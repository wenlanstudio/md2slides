"use strict"

/**
 * entry.js — e2e 在浏览器里的那一半。
 *
 * 它被 `bundle.js` 原样搬进页面，所以下面 require 的 `../core/…` 就是 Node 侧跑的那份
 * 源码，一字未改。这里只做两件事：**驱动分页** 和 **如实上报量到的数字**。
 *
 * 断言一律不写在这里：页面里能看到的只是 DOM，判定"合不合理"要在 Node 侧对着报告做，
 * 那样失败信息才带得全（哪一页、溢出多少像素、页里有什么）。
 */

const { splitOverflow } = require("../core/paginate/overflow")
const { FURNITURE_CLASS, SLOT_LEFT_CLASS, SLOT_RIGHT_CLASS } = require("../core/paginate/furniture")
const { highlightCode } = require("../core/render/highlight")
const { sectionsOf, beginMeasure, endMeasure } = require("../core/section")
const { extractIr, IR_VERSION } = require("../export/pptx/ir")
const { createDeckPlayer } = require("../kit/player")
const { mountLightbox } = require("../kit/lightbox")
const { checkIr } = require("../export/pptx/check")
const { DIAGRAM_TYPES, langOf } = require("../core/render/diagramHost")
const { renderDiagrams, assertDiagramsRendered } = require("../core/render/diagramHost")
const { renderDiagram: pageRenderDiagram, BROWSER_TYPES } = require("./pageDiagram")

const isFixed = el => el.tagName === "HEADER" || el.tagName === "FOOTER"
const isHeading = el => /^H[1-6]$/.test(el.tagName)

/**
 * 「中心内容」的判据，`overflow.js::coreTypeOf` 的镜像。
 *
 * 故意不复用那份：e2e 拿它来交叉校验"每页最多一个核心"。两边若哪天漂移了，
 * 应当在这里炸出来，而不是悄悄共用同一个可能写错的判据。
 */
const coreTypeOf = el => {
  switch (el.tagName) {
    case "PRE": return "code"
    case "TABLE": return "table"
    case "UL": case "OL": return "list"
    case "IMG": case "FIGURE": return "image"
    default: break
  }
  if (el.tagName === "P") {
    const kids = [...el.childNodes].filter(n => !(n.nodeType === 3 && !n.nodeValue.trim()))
    if (kids.length === 1 && kids[0].nodeType === 1 && kids[0].tagName === "IMG") return "image"
  }
  if (el.classList?.contains("katex-display") || el.querySelector?.(".katex-display")) return "math"
  return null
}

/**
 * 一页的量。口径与 `overflow.js` 一致：内容底边相对内容盒顶，超出 `avail * margin` 即溢出。
 * 必须在 `beginMeasure` / `endMeasure` 之间量——主题把非当前页藏起来了，藏着量全是 0。
 */
const measureSlide = (section, margin) => {
  const view = section.ownerDocument.defaultView
  const cs = view.getComputedStyle(section)
  const padTop = parseFloat(cs.paddingTop) || 0
  const padBottom = parseFloat(cs.paddingBottom) || 0
  const avail = Math.max(0, section.clientHeight - padTop - padBottom)

  const rect = section.getBoundingClientRect()
  const scale = rect.height > 0 && section.clientHeight > 0 ? rect.height / section.clientHeight : 1
  const origin = rect.top + (section.clientTop + padTop) * scale

  const kids = [...section.children].filter(el => !isFixed(el))
  const bottom = kids.length
    ? (kids[kids.length - 1].getBoundingClientRect().bottom - origin) / scale
    : 0

  return {
    index: Number(section.getAttribute("data-pagination")) || 0,
    blocks: kids.length,
    avail: Math.round(avail),
    bottom: Math.round(bottom),
    overflow: Math.round(Math.max(0, bottom - avail * margin)),
  }
}

/**
 * 一页的家居：页眉 / 页脚文本 + 页码槽位文本。
 *
 * 家具由 furniture.js 在分页收敛后注入，e2e 要断言三条规则（check.js）：
 *   ① 封面（第一页）两样豁免；② 扉页无页眉、页码保留；③ 页码连续且总数正确。
 * 这里只如实读 DOM，判定在 Node 侧。
 */
const furnitureOf = section => {
  const header = section.querySelector(`:scope > header.${FURNITURE_CLASS}`)
  const footer = section.querySelector(`:scope > footer.${FURNITURE_CLASS}`)
  return {
    header: header?.textContent?.trim() || null,
    footer: footer?.textContent?.trim() || null,
    page: footer?.querySelector(`:scope > .${SLOT_RIGHT_CLASS}`)?.textContent?.trim() ?? null,
    // 2026-10-24 起面包屑住在页脚左槽（原来在页眉右槽）
    path: footer?.querySelector(`:scope > .${SLOT_LEFT_CLASS}`)?.textContent?.trim() ?? null,
  }
}

/**
 * 跑一轮物理分页，返回这一轮新增了几页。
 *
 * 反复调用直到返回 0 即收敛。`splitOverflow` 内部有自己的 pass 上限，
 * 所以外层只要再调一次确认它没活干就够了——多调几次是为了兜住"染色后高度变了"这种回潮。
 */
const paginate = (opts = {}) => splitOverflow(document, opts)

/** 物理分页会把代码块的 span 切没，收敛后必须补一次色。 */
const repaint = () => highlightCode(document)

/**
 * 全篇量一遍。返回逐页数字 + 汇总。
 *
 * @param {object} [opts]
 * @param {number} [opts.slideWidth]  测量时钉住的画布宽
 * @param {number} [opts.slideHeight] 测量时钉住的画布高
 * @param {number} [opts.margin]      与分页同一个容差系数
 */
const report = (opts = {}) => {
  const margin = opts.margin ?? 1
  const sections = sectionsOf(document)

  beginMeasure(document, opts.slideWidth, opts.slideHeight)
  let pages
  try {
    pages = sections.map(section => {
      const row = measureSlide(section, margin)
      const kids = [...section.children].filter(el => !isFixed(el))
      const heading = kids.find(isHeading)
      const headingText = heading?.textContent
        ?.replace(/\s+/g, " ").replace("（续）", "").trim() ?? ""
      const hasContent = kids.some(el => !isHeading(el) && !el.classList?.contains("md2s-cont"))
      // 封面（USAGE.md §3.0）：引擎按 front-matter 的 title 生成，题名住在 div.cover 里。
      // check.js 靠它断言"封面存在 / 题名正确 / 两样豁免"。
      const cover = kids.find(el => el.classList?.contains("cover"))
      return {
        ...row,
        cores: kids.map(coreTypeOf).filter(Boolean),
        // 扉页：只剩标题 /「（续）」标记。它本身不是缺陷——书本式结构的部标题页
        // （`## 部标题` 紧跟 `### 节标题`）就该长这样，判据在 dividerRepeat。
        divider: kids.length > 0 && !hasContent,
        empty: kids.length === 0,
        heading: headingText,
        cover: cover ? cover.textContent?.replace(/\s+/g, " ").trim() ?? null : null,
        furniture: furnitureOf(section),
        // 续页表头内容比对（check.js）：splitTable 克隆的表头必须与首页逐字一致
        tables: [...section.querySelectorAll("table")].map(t => ({
          cont: t.classList.contains("md2s-table-cont"),
          head: t.querySelector("thead")
            ?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        })),
        // 一页里出现两个「（续）」，说明克隆标题时没把旧的剥掉，页越拆标记越多。
        contMarks: section.querySelectorAll(".md2s-cont").length,
      }
    })
    // 扉页重复：本页是扉页，而下页把头上的标题**原样再摆一遍**（repeatHeading 克隆）——
    // 读者先看一个光秃秃的标题，翻过去又是同一个标题，本页零信息量。
    // 与两种合法形态区分：① 合法续页的前一页是有内容的（重复标题正是为了给上下文）；
    // ② 部标题扉页后跟一个新节标题，不重复。只有"扉页 + 同标题"才是 README 那个病。
    pages.forEach((p, i) => {
      const next = pages[i + 1]
      p.dividerRepeat = p.divider && !!p.heading && next?.heading === p.heading
    })
  } finally {
    endMeasure(document)
  }

  const overflowing = pages.filter(p => p.overflow > 0)
  return {
    pages,
    summary: {
      total: pages.length,
      overflowing: overflowing.length,
      maxOverflow: overflowing.reduce((m, p) => Math.max(m, p.overflow), 0),
      dividerRepeats: pages.filter(p => p.dividerRepeat).map(p => p.index || pages.indexOf(p) + 1),
      empties: pages.filter(p => p.empty).map(p => p.index || pages.indexOf(p) + 1),
      multiCore: pages.filter(p => p.cores.length > 1).map(p => p.index || pages.indexOf(p) + 1),
      // hljs v11 输出的是 `hljs-keyword` 这类带后缀的类，没有裸 `.hljs` —— 按前缀找。
      highlighted: document.querySelectorAll("code [class*='hljs-']").length,
      slidesWithCode: pages.filter(p => p.cores.includes("code")).length,
    },
  }
}

/**
 * 页面侧的图表预通行：mermaid / echarts 只能在这里渲染（都是浏览器运行时，Node 侧没有）。
 *
 * 跑完立刻过闸门 `assertDiagramsRendered`——谁都没接手的图表类型会在这里炸出来，
 * 这是"不接受缺图降级"的兜底。
 */
const diagramPass = async (opts = {}) => {
  const result = await renderDiagrams(document, {
    renderDiagram: block => pageRenderDiagram(block, opts),
    only: opts.only ?? BROWSER_TYPES,
    settle: opts.settle,
    frames: opts.frames,
  })
  assertDiagramsRendered(document)
  return result
}

/** 当前 deck 的 HTML，供落盘比对 / 出片。 */
const deckHtml = () => [...sectionsOf(document)].map(s => s.outerHTML).join("\n")

/**
 * 内容快照，用来验「分页只搬不丢」。
 *
 * 计数只取**切分不会改变**的那几样：代码全文、表体行数、图片数、公式数。
 * 标题数和段落数不在此列——续页会克隆标题、还会补一个「（续）」标记段落，它们本就该变多。
 * 表格只数 `tbody`：`thead` 会被克隆到每一张续页上，数它反而会误报。
 *
 * 列表特殊：项数**会**变多，所以两个数都留着。
 * 按项切时项数守恒；但"单个列表项就高过一整页"时，`splitFirstItemInside` 会把那一项
 * 切成两半——原页留头部、续页放尾部，于是多出一个 `<li>`。那是设计使然，不是丢内容，
 * 真正的守恒判据是 `listText`（两半的文本拼回去必须等于原来那一项）。
 */
const snapshot = () => {
  const deck = document.getElementById("deck") ?? document.body
  // 引擎注入的目录页（core/paginate/toc.js）不进守恒比对：它不是作者内容，
  // 分页前后凭空出现或消失都不代表"搬丢了东西"。
  const all = sel => [...deck.querySelectorAll(sel)].filter(el => !el.closest("section[data-toc]"))
  return {
    pages: sectionsOf(document).length,
    codeText: all("pre > code").map(c => c.textContent).join("\n "),
    tableRows: all("tbody tr").length,
    listItems: all("li").length,
    listText: all("li").map(li => li.textContent).join("\n "),
    images: all("img").length,
    katex: all(".katex").length,
    // 图表：已经渲染成图节点的个数，以及**还没渲染**的图表围栏个数。
    // 后者必须是 0 —— 不接受缺图降级，这个契约就靠它在这里钉住。
    diagrams: all("[data-diagram]").length,
    unrenderedCharts: all("pre > code").filter(c => DIAGRAM_TYPES[langOf(c)]).length,
    // 块数：切分只会把一个块变成两个，所以这三个数只增不减。少了就是搬丢了。
    codeBlocks: all("pre").length,
    tables: all("table").length,
    tablesWithHead: all("table").filter(t => t.querySelector("thead")).length,
    lists: all("ul, ol").length,
    // deck 容器的直接子元素必须全是 `<section>`：切出来的块若被随手 append 到容器上，
    // 它就掉到所有页之外了——那种内容在放映时是彻底看不见的。
    strays: [...deck.children].filter(el => el.tagName !== "SECTION").length,
  }
}

/**
 * 逐页列出顶层块：tag / class / 是否核心 / 实测高度。
 *
 * 物理分页的判据全靠"量到的像素 + 块的类型"，出问题时只有文本描述是查不动的——
 * 得能直接看到"这一页到底装了哪些块、各占多高"。`check.js --dump` 用的就是它。
 */
const blocks = (opts = {}) => {
  const sections = sectionsOf(document)
  beginMeasure(document, opts.slideWidth, opts.slideHeight)
  try {
    return sections.map((section, i) => ({
      page: i + 1,
      avail: measureSlide(section, opts.margin ?? 1).avail,
      kids: [...section.children]
        .filter(el => !isFixed(el))
        .map(el => {
          const r = el.getBoundingClientRect()
          const cs = el.ownerDocument.defaultView.getComputedStyle(el)
          return {
            tag: el.tagName,
            cls: typeof el.className === "string" ? el.className : "",
            core: coreTypeOf(el),
            height: Math.round(r.height),
            // 临时诊断：img 的内联样式与计算高度上限
            diag: el.tagName === "IMG"
              ? (console.warn(`[dump-img] style=${el.getAttribute("style")} | computed maxH=${cs.maxHeight} maxW=${cs.maxWidth} h=${cs.height} w=${cs.width}`), undefined)
              : undefined,
          }
        }),
    }))
  } finally {
    endMeasure(document)
  }
}

/**
 * 抽 IR，并当场跑 `export/pptx/check.js` 那道闸门。
 *
 * 那道闸门原本只在 `host/typora/index.js` 里被调用——锁在那个待重写的旧壳里，
 * headless 下等于零覆盖。e2e 才是它天然的家：`extractIr` 读的是 `getBoundingClientRect`，
 * 没有真实布局就全是 0，跟物理分页一个道理。
 *
 * `media` 刻意不传：浏览器里没有落盘，图片块的 `file` 会是 null。但闸门比的是 `src`
 * 而不是 `file`，两条 P0（逐页文本等价、几何不越界）都不受影响。
 */
/**
 * IR 的 image 块只存**落盘后的路径**，落盘由 `ctx.media` 负责——IR 本身不背 data URL。
 *
 * 浏览器里落不了盘，所以这里把 data URL 攒着，先发一个占位文件名，回 Node 那边再按
 * 同一个名字写盘。这样 IR 里存的是真路径，sidecar 拿着它就能找到图。
 * 少了这一环，image 块的 src 就是 null，闸门会立刻报"图片未落盘"。
 */
const collectingMedia = () => {
  const items = []
  let n = 0
  return {
    items,
    add: (dataUrl, kind) => {
      n += 1
      const name = `${kind ?? "fig"}-${n}.png`
      items.push({ name, dataUrl })
      return name
    },
    warnings: [],
  }
}

/**
 * 把页面里的文件图片（相对/绝对 URL）预取成 dataURL。
 * e2e 的 media sink 是"只发编号"的假件（无落盘，README 已知坑）：它只收 dataUrl——
 * 之前的夹具图都是页面内栅格出来的 dataUrl 所以够用；夹具长出真图片文件后，
 * 抽 IR 前先就地内联，假 sink 照常工作。同源 fetch（页面走 http://）。
 */
const inlineImages = async () => {
  for (const img of document.querySelectorAll("img")) {
    const src = img.getAttribute("src")
    if (!src || src.startsWith("data:")) continue
    try {
      const blob = await fetch(img.src).then(r => {
        if (!r.ok) throw new Error(`http ${r.status}`)
        return r.blob()
      })
      img.src = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error("FileReader 失败"))
        reader.readAsDataURL(blob)
      })
    } catch (error) {
      console.warn(`[md2slides] 图片预取失败（${src}）：${error?.message ?? error}`)
    }
  }
}

const irAudit = async (opts = {}) => {
  await inlineImages()
  const media = collectingMedia()
  const ir = await extractIr(document, {
    slideWidth: opts.slideWidth,
    slideHeight: opts.slideHeight,
    theme: opts.theme,
    // front-matter 七键 → IR 文件属性四键（title/subtitle/author/date）
    meta: opts.meta ?? null,
    media,
    // 浏览器里的栅格钩子：`lib/html-to-image.js` 挂在 `window.htmlToImage` 上。
    // 没有它，图表和公式只能登记成 custom/unknown —— 而 sidecar 对这两类是跳过。
    rasterize: opts.rasterize === false ? undefined : el => window.htmlToImage?.toPng(el),
  })
  const { issues, stats } = checkIr(document, ir)

  return {
    version: ir.version,
    canvas: ir.canvas,
    issues,
    stats,
    pages: ir.slides.map(s => ({
      index: s.index,
      pagination: s.pagination,
      blocks: s.blocks?.length ?? 0,
      types: [...new Set((s.blocks ?? []).map(b => b.type))].sort(),
    })),
    // IR 本体要带回去：sidecar 只认 IR JSON，不认 DOM。它里面存的是图片**路径**
    // 而不是 data URL，所以不会很大——data URL 走下面那条。
    ir,
    media: media.items,
  }
}

/**
 * 播放器页面内探针：接管 / 翻页 / 键盘 / 两端钳住 / 还原，一口气验完。
 * 返回 { issues, total }——issues 空 = 全过。必须在浏览器活着的时候由 runner 调：
 * page 一旦 detach，evaluate 就永远不可能了（check.js 拿到的 page 是死的）。
 */
const playerProbe = ({ slideWidth, slideHeight, mode }) => {
  const issues = []
  const root = document.getElementById("deck")
  if (!root) return { issues: ["playerProbe：找不到 #deck"], total: 0, steps: 0 }
  let p = null
  try {
    p = createDeckPlayer(root, { slideWidth, slideHeight, mode })
    const stage = root.querySelector(":scope > .md2s-stage")
    if (!stage) issues.push("stage 没建出来")
    if (stage && p.total !== stage.querySelectorAll("section[data-slide]").length) {
      issues.push("total 与 stage 内页数不符")
    }
    const cur = stage
      ? [...stage.querySelectorAll("section[data-slide]")].findIndex(s => s.classList.contains("md2s-current"))
      : -1
    if (cur !== 0 || p.index !== 1) issues.push(`起始应为第 1 页，实际 index=${p.index} cur=${cur + 1}`)
    const scale = stage ? Number(stage.style.getPropertyValue("--md2s-scale")) : NaN
    if (!(scale > 0) || !Number.isFinite(scale)) issues.push(`缩放异常：${scale}`)

    if (mode === "element") {
      // 找步数最多的一页，验：visibility 揭示 / 逐步计数 / 当前步唯一 / ←→ 恒为翻页
      let best = 0
      let bestIdx = 0
      for (let i = 1; i <= p.total; i++) { p.go(i); if (p.steps > best) { best = p.steps; bestIdx = i } }
      if (best === 0) {
        issues.push("element 模式：整份文档没有任何步进页（步进表没建出来？）")
      } else {
        p.go(bestIdx)
        const section = stage.querySelectorAll("section[data-slide]")[bestIdx - 1]
        const before = section.querySelectorAll(".md2s-step-hidden").length
        const el = section.querySelector(".md2s-step-hidden")
        if (el && getComputedStyle(el).visibility !== "hidden") {
          issues.push("未揭示元素应为 visibility:hidden（占位不显示）")
        }
        p.stepFwd(); p.stepFwd()
        if (p.step !== 2) issues.push(`stepFwd 两次后 step 应为 2，实际 ${p.step}`)
        const after = section.querySelectorAll(".md2s-step-hidden").length
        // 相对减少即可（表格的整表步只揭示一个元素，行步才逐个放行）
        if (!(after < before)) issues.push(`步进后隐藏元素应减少：${before} → ${after}`)
        // 一步一个框：表格先整张表一步，之后才是每行一步（旧方案表头与首行同时描边）
        const curCount = section.querySelectorAll(".md2s-step-current").length
        if (curCount !== 1) issues.push(`当前步应唯一（实际 ${curCount}，steps=${best} step=${p.step}）`)
        // ←→ 恒为翻页（在非末页上验，末页钳住是正当行为）
        p.go(1)
        root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))
        if (p.index !== 2) issues.push("element 模式 ←→ 恒为翻页，实际没翻")
      }
    } else if (stage) {
      p.go(2)
      if (p.index !== 2) issues.push("go(2) 无效")
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))
      if (p.index !== 3) issues.push("键盘 → 无效")
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }))
      if (p.index !== p.total) issues.push("End 无效")
      p.next()
      if (p.index !== p.total) issues.push("末页 next 应钳住")
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }))
      if (p.index !== 1) issues.push("Home 无效")
      p.prev()
      if (p.index !== 1) issues.push("首页 prev 应钳住")
    }

    // 触屏手势：与键盘同一套语义（左右翻页 / 上滑步进或翻页）。真 Chromium 才有
    // PointerEvent，所以这条只在浏览器里验（smoke 的 jsdom 那侧走 touch 路线）。
    const firePointer = (type, x, y) => root.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", isPrimary: true,
      clientX: x, clientY: y,
    }))
    const swipe = (x0, y0, x1, y1) => {
      firePointer("pointerdown", x0, y0)
      firePointer("pointermove", x1, y1)
      firePointer("pointerup", x1, y1)
    }
    p.go(1)
    swipe(600, 400, 500, 400)                       // ← 左滑 = 下一页
    if (p.index !== 2) issues.push(`触屏左滑应到第 2 页，实际 ${p.index}`)
    swipe(500, 400, 600, 400)                       // → 右滑 = 上一页
    if (p.index !== 1) issues.push(`触屏右滑应回第 1 页，实际 ${p.index}`)
    if (p.steps > 0) {
      swipe(600, 400, 600, 300)                     // ↑ 上滑 = 下一步
      if (p.step !== 1) issues.push(`触屏上滑应步进到第 1 步，实际 ${p.step}`)
      swipe(600, 400, 600, 500)                     // ↓ 下滑 = 上一步
      if (p.step !== 0) issues.push(`触屏下滑应回到第 0 步，实际 ${p.step}`)
    } else {
      swipe(600, 400, 600, 300)                     // 纯翻页形态：上滑 = 下一页
      if (p.index !== 2) issues.push(`纯翻页形态触屏上滑应翻页，实际 ${p.index}`)
    }
    const beforeIdx = p.index
    swipe(600, 400, 580, 400)                       // 20px 抖动不该翻
    if (p.index !== beforeIdx) issues.push(`触屏 20px 抖动不该翻页：${beforeIdx} → ${p.index}`)
  } catch (error) {
    issues.push(`探针异常：${error?.message ?? error}`)
  } finally {
    if (p) {
      p.destroy()
      if (root.querySelector(":scope > .md2s-stage")) issues.push("destroy 后 stage 没撤")
      const backs = root.querySelectorAll(":scope > section[data-slide]")
      if (backs.length !== p.total) issues.push(`destroy 后页没搬回：${backs.length}/${p.total}`)
      if (root.classList.contains("md2s-player")) issues.push("destroy 后 md2s-player 类没摘")
    }
  }
  return { issues, total: p?.total ?? 0, steps: p?.steps ?? 0 }
}

/**
 * 图片查看器探针（kit/lightbox.js）：真浏览器里验「点图打开 → 解码 → 滚轮缩放 → 拖动 →
 * Esc 关闭」。真轮 / 真 pointer / 真图片加载，这三点 jsdom 都验不了，所以在这里补——
 * 尤其 `WheelEvent` 与 pointer 合成事件的行为和 jsdom 不一样。
 * @returns {Promise<{issues: string[], opened: boolean, decoded: number}>}
 */
const lightboxProbe = async () => {
  const issues = []
  const doc = document
  // 注入一张确定性可解码的大图（1200×12000，同源静态服务器托管）作测试对象，
  // 彻底不依赖 deck 内容 / 图表异步栅格时序（那俩都会让"图上哪找"变 flaky）。
  const testSec = doc.createElement("section")
  testSec.setAttribute("data-slide", "")
  const img = doc.createElement("img")
  img.alt = "测试图"
  img.src = (location.origin || "") + "/e2e/fixtures/oversize-tall.png"
  testSec.appendChild(img)
  doc.body.appendChild(testSec)
  const lb = mountLightbox(doc, { currentSlide: () => testSec })
  // 取最新实例（防重复挂载串台）
  const allLb = doc.querySelectorAll(".md2s-lb")
  const el = allLb[allLb.length - 1]
  const allImg = doc.querySelectorAll(".md2s-lb-img")
  const lbImg = allImg[allImg.length - 1]
  const fire = (target, type, init) => target.dispatchEvent(
    type === "wheel" ? new WheelEvent(type, { bubbles: true, cancelable: true, ...init })
      : type === "click" ? new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
        : new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true, ...init }))

  img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
  if (!lb.isOpen) { lb.destroy(); testSec.remove(); return { issues: ["点图片没打开查看器"], opened: false, decoded: 0 } }

  // 等解码：图片 http 可达才谈得上「看原图」
  await new Promise(resolve => {
    const done = () => { lbImg.removeEventListener("load", done); lbImg.removeEventListener("error", done); resolve() }
    lbImg.addEventListener("load", done)
    lbImg.addEventListener("error", done)
    setTimeout(done, 4000)
  })
  const decoded = lbImg.naturalWidth || 0
  if (!decoded) issues.push(`查看器里的图没解码出来（src 不可达？${String(img.getAttribute("src")).slice(0, 60)}）`)

  const fit = lb.scale
  if (!(fit > 0 && fit <= 1)) issues.push(`初始 pose 应≤1（大图适应、小图原始）：${fit}`)
  // 居中护栏：fit 态 tx=ty=0，图的中心必须与浮层中心重合。
  // （曾出过「absolute + left/top:50% 但没 transform 拉回自身一半」→ 图整张偏右下。）
  {
    const host = lbImg.parentElement.getBoundingClientRect()
    const ib = lbImg.getBoundingClientRect()
    const dxOff = (ib.left + ib.width / 2) - (host.left + host.width / 2)
    const dyOff = (ib.top + ib.height / 2) - (host.top + host.height / 2)
    if (!(Math.abs(dxOff) < 1.5 && Math.abs(dyOff) < 1.5)) {
      issues.push(`适应屏幕时图应居中，实际偏移 (${dxOff.toFixed(1)}, ${dyOff.toFixed(1)})`)
    }
  }
  const box = lbImg.parentElement.getBoundingClientRect()
  const cx = box.left + box.width / 2
  const cy = box.top + box.height / 2

  fire(el, "wheel", { deltaY: -240, clientX: cx, clientY: cy })
  if (!(lb.scale > fit)) issues.push(`滚轮上滚应放大：${fit} → ${lb.scale}`)
  for (let i = 0; i < 60; i++) fire(el, "wheel", { deltaY: -240, clientX: cx, clientY: cy })
  if (lb.scale > 8 + 1e-6) issues.push(`放大应被上限钳住，实际 ${lb.scale}`)
  for (let i = 0; i < 120; i++) fire(el, "wheel", { deltaY: 240, clientX: cx, clientY: cy })
  if (lb.scale < 0.1 - 1e-6) issues.push(`缩小应被下限钳住，实际 ${lb.scale}`)

  // 拖动：先放大到超出视口，否则会被「图小于视口就锁死居中」钳回 0
  for (let i = 0; i < 24; i++) fire(el, "wheel", { deltaY: -240, clientX: cx, clientY: cy })
  const txOf = () => Number(/translate\((-?[\d.]+)px/.exec(lbImg.style.transform)?.[1] ?? NaN)
  const before = txOf()
  fire(lbImg, "pointerdown", { pointerId: 11, clientX: cx, clientY: cy })
  fire(lbImg, "pointermove", { pointerId: 11, clientX: cx + 120, clientY: cy })
  // 抬手必须补：不补的话 pointerId 11 残留在 pointers 里，下面的 pinch 建 pair() 时
  // `slice(0, 2)` 会取到 [11, 21] 而不是 [21, 22]，双指距离恒等于拖动后的距离，
  // 拉开永远不放大（2026-10-30 实测：d0 = d = 220 → r = 1 → k 不变）。
  fire(lbImg, "pointerup", { pointerId: 11, clientX: cx + 120, clientY: cy })
  const moved = txOf() - before
  // 诊断：图小于视口时锁死居中属正确行为，不误报。nat 来自查看器内部，这里用 naturalWidth 复算 maxX 判断。
  const vw = el.clientWidth || 800
  const natW = lbImg.naturalWidth || 0
  const maxX = Math.max(0, (natW * lb.scale - vw) / 2)
  if (maxX >= 60) {
    if (!(Math.abs(moved - 120) < 1)) issues.push(`拖动 120px 应产生等量位移，实际 ${moved.toFixed(1)}（lbCount=${allLb.length} k=${lb.scale} natW=${natW} vw=${vw} tf="${lbImg.style.transform}"）`)
  } else if (Math.abs(moved) >= 1) {
    issues.push(`图小于视口却被拖动出位移 ${moved.toFixed(1)}（应锁死居中）`)
  }

  // 拖动松手后浏览器还会补一个 click；target 可能是图片与浮层的共同祖先（el 本身）。
  // 曾因这里被误判成「点了背景」而立刻退出预览（连同工具条按钮一起失效）。
  if (!lb.isOpen) issues.push("拖动松手后查看器不该关闭")
  fire(el, "click")
  if (!lb.isOpen) issues.push("拖动后浏览器补发的 click 不该关闭查看器")

  // 工具条按钮：点完必须生效、且不能把浮层关掉（+-适应1:1 曾全失效—点它们反而退出）
  // （上面的用例把 k 推到了上限 8，先复位到 fit，否则 ＋ 看不出变化、− 也无从缩起）
  fire(el.querySelector('[data-act="fit"]'), "click")
  for (const act of ["zoom-in", "zoom-out", "one", "fit"]) {
    const before2 = lb.scale
    fire(el.querySelector(`[data-act="${act}"]`), "click")
    if (!lb.isOpen) { issues.push(`点工具条「${act}」把查看器关掉了（应只动作不关闭）`); break }
    if (act === "fit" && Math.abs(lb.scale - fit) > fit * 0.02 + 1e-6) {
      issues.push(`点「适应」应回到 fit=${fit.toFixed(4)}，实际 ${lb.scale}`)
    }
    if (act === "one" && Math.abs(lb.scale - 1) > 0.02) {
      issues.push(`点「1:1」应回到原始像素 k=1，实际 ${lb.scale}`)
    }
    if (act === "zoom-in" && !(lb.scale > before2 + 1e-6)) issues.push(`点「＋」应放大：${before2} → ${lb.scale}`)
    if (act === "zoom-out" && !(lb.scale < before2 - 1e-6)) issues.push(`点「−」应缩小：${before2} → ${lb.scale}`)
  }

  // 双击必须「同一处」：快点两下相距很远的地方，不该被当成双击把图跳到 1:1 / 适应
  const beforeApart = lb.scale
  fire(lbImg, "pointerdown", { pointerId: 31, clientX: cx, clientY: cy })
  fire(lbImg, "pointerup", { pointerId: 31, clientX: cx, clientY: cy })
  fire(lbImg, "pointerdown", { pointerId: 32, clientX: cx + 220, clientY: cy + 140 })
  fire(lbImg, "pointerup", { pointerId: 32, clientX: cx + 220, clientY: cy + 140 })
  if (Math.abs(lb.scale - beforeApart) > 1e-6) {
    issues.push(`相距很远的两下轻点不该被判成双击（scale ${beforeApart} → ${lb.scale}）`)
  }

  // 双指 pinch：拉开应放大。先点「适应」把上面推到上限的 k 复位到 fit，否则 pinch 被钳住看不出放大
  el.querySelector('[data-act="fit"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  const k0 = lb.scale
  fire(lbImg, "pointerdown", { pointerId: 21, clientX: cx - 100, clientY: cy })
  fire(lbImg, "pointerdown", { pointerId: 22, clientX: cx + 100, clientY: cy })
  fire(lbImg, "pointermove", { pointerId: 22, clientX: cx + 300, clientY: cy })
  if (!(lb.scale > k0)) issues.push(`双指拉开应放大：${k0} → ${lb.scale}`)
  fire(lbImg, "pointerup", { pointerId: 22, clientX: cx + 300, clientY: cy })
  fire(lbImg, "pointerup", { pointerId: 21, clientX: cx - 100, clientY: cy })

  // Esc：在 body 上发，验 window capture 能拦住（不放给任何别的消费者）
  doc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  if (lb.isOpen) issues.push("Esc 没关闭查看器")

  // ✕ 按钮：同样应能关闭（过去整个工具条被当成背景点击，点谁都是退出）
  fire(img, "click")
  if (!lb.isOpen) issues.push("关闭后再次点图片应能重新打开")
  fire(el.querySelector('[data-act="close"]'), "click")
  if (lb.isOpen) issues.push("点工具条 ✕ 应关闭查看器")

  lb.destroy()
  testSec.remove()
  if (doc.querySelector(".md2s-lb")) issues.push("destroy 后浮层没拆")
  if (doc.querySelector("section[data-slide]")?.contains(testSec)) issues.push("testSec 没拆")
  return { issues, opened: true, decoded }
}

/**
 * 截图打包：puppeteer 逐页真屏截的全尺寸 PNG → 页内等比缩到 640 宽 → base64。
 * 有基线就地在 canvas 里逐像素比（通道容差 12/255，缩放平滑掉亚像素抖动），
 * 返回每页差异比（0~1）。基线同样是 640 宽缩图：回归看版面（分页/主题/公式/图表），
 * 不看字体微距——那类差异由「同机回归」消化，caveat 同 IR 快照。
 */
const shotPack = async ({ width, height, pngs, baselines }) => {
  const TW = 640
  const TH = Math.round(height * (TW / width))
  const load = src => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("图片解码失败"))
    img.src = src
  })
  const draw = img => {
    const canvas = document.createElement("canvas")
    canvas.width = TW
    canvas.height = TH
    canvas.getContext("2d").drawImage(img, 0, 0, TW, TH)
    return canvas
  }
  const smalls = []
  for (const b64 of pngs) {
    smalls.push(draw(await load(`data:image/png;base64,${b64}`)).toDataURL("image/png").split(",")[1])
  }
  let diffs = null
  if (Array.isArray(baselines) && baselines.length === smalls.length) {
    diffs = []
    for (let i = 0; i < smalls.length; i++) {
      const ctx = draw(await load(`data:image/png;base64,${baselines[i]}`)).getContext("2d")
      const da = ctx.getImageData(0, 0, TW, TH).data
      const db = draw(await load(`data:image/png;base64,${smalls[i]}`)).getContext("2d").getImageData(0, 0, TW, TH).data
      let bad = 0
      for (let p = 0; p < da.length; p += 4) {
        if (Math.abs(da[p] - db[p]) > 12 || Math.abs(da[p + 1] - db[p + 1]) > 12 || Math.abs(da[p + 2] - db[p + 2]) > 12) bad += 1
      }
      diffs.push(bad / (TW * TH))
    }
  }
  return { shots: smalls, diffs }
}

module.exports = {
  paginate,
  shotPack,
  createDeckPlayer,
  playerProbe,
  lightboxProbe,
  repaint,
  report,
  deckHtml,
  coreTypeOf,
  snapshot,
  blocks,
  irAudit,
  diagramPass,
  IR_VERSION,
}
