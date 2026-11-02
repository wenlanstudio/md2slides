"use strict"

/**
 * runner.js — 把一份 Markdown 送进真浏览器，跑完物理分页，把量到的数字带回来。
 *
 * 一次完整的链路：
 *
 * ```
 * md ──compose（Node 侧，jsdom）──▶ html + css ──▶ 写成 e2e/.cache/*.html
 *                                                        │
 *                        headless Chrome ◀── goto file://
 *                                                        │
 *   inject: lib/highlight.min.js → e2e/externals.js → bundle(entry.js)
 *                                                        │
 *   paginate ─▶ repaint ─▶ paginate ─▶ report ─────────▶ { pages, summary }
 * ```
 *
 * 分工：`compose` 负责"不需要布局的那一半"（解析、逻辑分页、拼 CSS），
 * 浏览器只负责"需要量高度的那一半"。所以注入页面的不是 md，而是 compose 的产物。
 *
 * **这里不做任何断言**——runner 只管把数字取回来，判断在 `check.js`。
 */

const fs = require("fs")
const path = require("path")
const { pathToFileURL } = require("url")
const { JSDOM } = require("jsdom")

const { compose } = require("../core/compose")
const { renderDiagrams, chartBlocksOf } = require("../core/render/diagramHost")
const { renderDiagram: thinRenderDiagram, NODE_TYPES } = require("../host/thin")
const { bundleScript } = require("./bundle")
const { launch } = require("./browser")
const { serve } = require("./serve")
const { buildPptx, inspectPptx } = require("./sidecar")

const ROOT = path.resolve(__dirname, "..")
const CACHE_DIR = path.join(__dirname, ".cache")
const SNAPSHOT_DIR = path.join(__dirname, "snapshots")

const posix = p => p.split(path.sep).join("/")

/**
 * KaTeX 字体的绝对地址：输出文件落在 `.cache/` 里，相对路径指不到 `lib/katex/fonts`。
 *
 * 走 HTTP 服务的地址而不是 `file://`：栅格公式时 html-to-image 要 XHR 去取 woff2，
 * 而 Chrome 一律拒绝 XHR 到 `file://`。取不回来，公式的高度就是 fallback 字体的高度，
 * 物理分页据此做的每个决定都是错的。
 */
const katexFontsUrl = baseUrl =>
  baseUrl ? `${baseUrl}/lib/katex/fonts/` : `${pathToFileURL(path.join(ROOT, "lib/katex/fonts")).href}/`

/** 页面骨架：主题 CSS + 摊开所有页，其余交给浏览器量。 */
const deckPage = (deck, bodyHtml) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${deck.name ?? "deck"}</title>
<style>${deck.css}</style>
<style>
  /* e2e 专用：所有页都摊开、按原始尺寸排。正式放映时由宿主接管这一层。 */
  html, body { margin: 0; background: #f2f4f7; }
  #deck { display: flex; flex-direction: column; width: ${deck.slideWidth}px; }
  section[data-slide] { flex: none; }
</style>
</head><body>
<div id="deck">${bodyHtml}</div>
</body></html>
`

/**
 * 生成可在浏览器里打开的 deck 页面（分页前）。
 * @returns {{ deck: object, file: string }} 落盘路径
 */
const buildPage = async (md, { name = "deck", cacheDir = CACHE_DIR, baseUrl = null, renderDiagram } = {}) => {
  const document = new JSDOM("").window.document
  const composed = compose(md, { document, katexFontsUrl: katexFontsUrl(baseUrl) })
  const deck = { name, ...composed }

  // 图表预通行：core 只调度，出图的是宿主。必须在写页（也就是浏览器实测）之前跑完——
  // 晚一步 overflow.js 量到的就是 0，IR 的几何跟着全错。
  const diagram = await renderDiagrams(composed.doc, {
    renderDiagram: renderDiagram ?? thinRenderDiagram,
    // 只做 Node 侧会的那几种；mermaid 是浏览器运行时，留给页面那一遍。
    only: NODE_TYPES,
  })
  if (diagram.rendered > 0) {
    // compose 给的 html 是预通行**之前**的快照，换过图就得重新序列化。
    const el = composed.doc.querySelector(".md2slides-deck")
    if (el) deck.html = el.innerHTML
  }
  // 还剩下的图表类型 = 交给别的环境去渲染的。最后没人接手就是硬失败。
  deck.diagram = { ...diagram, deferred: [...new Set(chartBlocksOf(composed.doc).map(b => b.type))] }

  fs.mkdirSync(cacheDir, { recursive: true })
  const file = path.join(cacheDir, `${name}.html`)
  fs.writeFileSync(file, deckPage(deck, deck.html), "utf8")
  return { deck, file }
}

/** 反复分页直到它没活干（`splitOverflow` 返回 0）。 */
const settle = async (page, opts, maxRounds = 6) => {
  const rounds = []
  for (let i = 0; i < maxRounds; i++) {
    const added = await page.evaluate(o => window.md2slides.paginate(o), opts)
    rounds.push(added)
    if (added === 0) break
  }
  return rounds
}

/**
 * 注入浏览器运行时并跑页面侧图表预通行（管线第 2 段，e2e 与导出 CLI 共用——
 * 管线副本是「预览什么样，导出就什么样」这条承诺的天敌）。
 * 顺序要紧：hljs 是 externals 里那一项的来源，externals 又是 bundle 的依赖。
 */
const injectRuntime = async (page, deferred) => {
  await page.addScriptTag({ path: require.resolve("../lib/highlight.min.js") })
  // IR 抽取要用它把公式 / 图表栅格成 PNG（ir.js 的 rasterize 钩子）。
  await page.addScriptTag({ path: require.resolve("../lib/html-to-image.js") })
  await page.addScriptTag({ path: require.resolve("./externals.js") })
  await page.addScriptTag({ content: bundleScript(require.resolve("./entry")) })
  await page.evaluate(() => {
    window.md2slides = window.installMd2slides(window.__md2slides_externals)
  })

  // 图表预通行第二遍：mermaid / echarts 是浏览器运行时，只能在页面里渲染。
  // 两个 lib 都不小（mermaid 5.5 MB、echarts 1.1 MB），只在文档真用到时才注入。
  if (deferred.includes("mermaid")) {
    await page.addScriptTag({ path: require.resolve("../host/lib/mermaid.min.js") })
  }
  if (deferred.includes("echarts")) {
    await page.addScriptTag({ path: require.resolve("../host/lib/echarts.min.js") })
  }
  // 这一遍跑完会当场过 `assertDiagramsRendered` 闸门：谁都没接手的图表类型在这里炸。
  // 不传 only：默认接管页面侧全部类型（mermaid + echarts）。
  return page.evaluate(() => window.md2slides.diagramPass({}))

  // 字体没就位就量，量到的是 fallback 字体的高度——中文字体尤其明显。
  await page.evaluate(() => document.fonts.ready.then(() => true))
}

/** 收敛循环（管线第 3 段）：分页到不动 → 补染 → 再来一轮看回不回潮。 */
const settleDeck = async (page, opts) => {
  const rounds = await settle(page, opts)
  const repainted = await page.evaluate(() => window.md2slides.repaint())
  // 染色会往代码块里塞 span，理论上不改高度，但那正是要验的事：再来一轮看回不回潮。
  const roundsAfterRepaint = repainted > 0 ? await settle(page, opts) : []
  return { rounds, repainted, roundsAfterRepaint }
}

/**
 * 跑一份文档。
 *
 * @param {object} input
 * @param {string} [input.file]  Markdown 路径（与 `md` 二选一）
 * @param {string} [input.md]    Markdown 源文本
 * @param {string} [input.name]  产物名，默认取文件名
 * @param {object} [input.paginate] 传给 `splitOverflow` 的选项
 * @returns {Promise<{ deck: object, rounds: number[], repainted: number,
 *                     roundsAfterRepaint: number[], report: object, file: string,
 *                     finalHtml: string, console: string[] }>}
 */
const runDeck = async input => {
  const { file: mdFile, md: mdText } = input
  if (!mdFile && mdText == null) throw new Error("runDeck: 要给 file 或 md")

  const md = mdText ?? fs.readFileSync(mdFile, "utf8")
  const name = input.name ?? (mdFile ? path.basename(mdFile, ".md") : "deck")

  // 页面经 HTTP 打开，不用 file://：XHR 到 file:// 被 Chrome 一律拒绝，
  // 栅格公式取不到 woff2，量出来的高度就是错的。
  const server = await serve(ROOT)
  const logs = []
  try {
    const { deck, file } = await buildPage(md, { name, baseUrl: server.url })

    const paginateOpts = {
      slideWidth: deck.slideWidth,
      slideHeight: deck.slideHeight,
      contMarker: "（续）",
      margin: 1,
      // 页眉页脚的家居配置（front-matter 六键）：收敛后由 furniture.js 注入
      meta: deck.meta ?? null,
      ...(input.paginate ?? {}),
    }

    // 浏览器起在函数最里层：端口先占到手，页面才能用它拼出字体地址。
    const browser = await launch(input.browser ?? {})
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: deck.slideWidth, height: deck.slideHeight })
      // 浏览器里的 console / 未捕获异常带回 Node：分页是在页面里跑的，不接出来就全哑了。
      page.on("console", msg => logs.push(`${msg.type()}: ${msg.text()}`))
      page.on("pageerror", err => logs.push(`pageerror: ${err.message}`))
      page.on("requestfailed", req => logs.push(`requestfailed: ${req.url()}`))
      // 404 不算 requestfailed（它是个正经响应），单独听，才知道是哪个 URL 取不到。
      page.on("response", res => {
        if (res.status() >= 400) logs.push(`http ${res.status()}: ${res.url()}`)
      })

      await page.goto(`${server.url}/${posix(path.relative(ROOT, file))}`, { waitUntil: "load" })

      const deferred = deck.diagram?.deferred ?? []
      const diagramPass = await injectRuntime(page, deferred)

      const before = await page.evaluate(() => window.md2slides.snapshot())
      const { rounds, repainted, roundsAfterRepaint } = await settleDeck(page, paginateOpts)

      const report = await page.evaluate(o => window.md2slides.report(o), {
        slideWidth: paginateOpts.slideWidth,
        slideHeight: paginateOpts.slideHeight,
        margin: paginateOpts.margin,
      })
      const finalHtml = await page.evaluate(() => window.md2slides.deckHtml())
      const after = await page.evaluate(() => window.md2slides.snapshot())
      // 逐页块清单（--dump 要用）。顺手取，成本就一次测量。
      const blocks = await page.evaluate(o => window.md2slides.blocks(o), {
        slideWidth: paginateOpts.slideWidth,
        slideHeight: paginateOpts.slideHeight,
        margin: paginateOpts.margin,
      })
      // 分页收敛、代码补染之后才抽 IR：IR 不重新排版，它读的就是浏览器定好的这份 DOM，
      // 所以顺序反了会抽到切碎前的样子。
      const ir = await page.evaluate(o => window.md2slides.irAudit(o), {
        slideWidth: paginateOpts.slideWidth,
        slideHeight: paginateOpts.slideHeight,
        theme: deck.theme,
        // 文档元数据进 IR：sidecar 据此写 PPTX 文件属性
        meta: deck.meta ?? null,
      })

      // 播放器探针：会搬动页面 DOM，放在 IR 抽取**之后**跑；趁浏览器活着，page 一关
      // evaluate 就不可能了。结果只带 issues 回来，判断在 check.js。
      const playerOpts = {
        slideWidth: paginateOpts.slideWidth,
        slideHeight: paginateOpts.slideHeight,
      }
      const player = await page.evaluate(o => window.md2slides.playerProbe(o), { ...playerOpts, mode: "slide" })
      const playerElement = await page.evaluate(o => window.md2slides.playerProbe(o), { ...playerOpts, mode: "element" })
      // 图片查看器探针：也要 DOM 活着，故紧随播放器之后；没图的 deck 会 skipped。
      const lightbox = await page.evaluate(() => window.md2slides.lightboxProbe())

      // 截图基线：分页/主题/公式/图表的「看起来对不对」只有像素能验（数字闸门抓不到
      // 居中丢了、字号错了这类事）。逐页真屏截 → 页内缩到 640 宽落盘 → 有基线就地比。
      // 基线在 e2e/snapshots/shots/（进版本库）；同机回归，caveat 同 IR 快照。
      const shotDir = path.join(CACHE_DIR, "shots", name)
      const baselineDir = path.join(SNAPSHOT_DIR, "shots", name)
      const pngs = []
      for (const handle of await page.$$("section[data-slide]")) {
        pngs.push((await handle.screenshot()).toString("base64"))
      }
      const baselines = fs.existsSync(baselineDir)
        ? fs.readdirSync(baselineDir).filter(f => f.endsWith(".png")).sort()
            .map(f => fs.readFileSync(path.join(baselineDir, f)).toString("base64"))
        : null
      const shotPacked = await page.evaluate(o => window.md2slides.shotPack(o), {
        width: paginateOpts.slideWidth,
        height: paginateOpts.slideHeight,
        pngs,
        baselines,
      })
      fs.mkdirSync(shotDir, { recursive: true })
      shotPacked.shots.forEach((b64, i) => {
        fs.writeFileSync(path.join(shotDir, `p${String(i + 1).padStart(2, "0")}.png`), Buffer.from(b64, "base64"))
      })
      const shot = { compared: baselines != null, pages: shotPacked.shots.length, issues: [] }
      if (shot.compared) {
        if (baselines.length !== shotPacked.shots.length) {
          shot.issues.push(`页数变了：基线 ${baselines.length} 页 → 现在 ${shotPacked.shots.length} 页`)
        } else {
          shotPacked.diffs.forEach((ratio, i) => {
            if (ratio > 0.01) shot.issues.push(`第 ${i + 1} 页与基线像素差异 ${(ratio * 100).toFixed(2)}%（阈值 1%）`)
          })
        }
      }

      // 分页**后**的产物才是翻车时要看的：断言报"第 6 页溢出 30px"，
      // 光看切之前的文档是判断不出切错了还是主题写错了的。
      const paginatedFile = path.join(
        path.dirname(file),
        `${path.basename(file, ".html")}.paginated.html`,
      )
      fs.writeFileSync(paginatedFile, deckPage(deck, finalHtml), "utf8")

      // IR 落地：sidecar 是另一个进程，只认文件不认内存。
      // IR 里存的是图片**路径**，图本身单独写进 media 目录（文件名由 entry.js 那边约定）。
      const stem = path.join(path.dirname(file), name)
      const irFile = `${stem}.ir.json`
      const mediaDir = `${stem}.media`
      const pptxFile = `${stem}.pptx`
      fs.mkdirSync(mediaDir, { recursive: true })
      for (const item of ir.media) {
        const base64 = String(item.dataUrl).split(",")[1] ?? ""
        fs.writeFileSync(path.join(mediaDir, item.name), Buffer.from(base64, "base64"))
      }
      fs.writeFileSync(irFile, JSON.stringify(ir.ir, null, 2), "utf8")

      const pptx = buildPptx({ ir: irFile, out: pptxFile, media: mediaDir, report: `${stem}.sidecar.json` })
      // 出片成功才读几何：去读一个不存在的文件，只会得到一句没用的报错。
      const shapes = pptx.ok ? inspectPptx(pptxFile) : null

      return {
        deck,
        file,
        player,
        playerElement,
        lightbox,
        shot,
        rounds,
        repainted,
        roundsAfterRepaint,
        report,
        finalHtml,
        before,
        after,
        blocks,
        ir,
        diagram: deck.diagram,
        diagramPass,
        pptx,
        shapes,
        pptxFile,
        irFile,
        console: logs,
      }
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
}

module.exports = { runDeck, buildPage, injectRuntime, settleDeck, CACHE_DIR }
