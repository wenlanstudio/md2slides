"use strict";

/**
 * deck-full-entry.js — marktext 形态的 deck 页面入口（浏览器侧 bundle → deck-full.js）。
 *
 * 与 Typora 形态（deck-entry.js → deck-page.js）的分工差异：marktext 渲染进程全沙箱
 * （nodeIntegration:false + CSP script-src 'self'），**compose 也搬进页面里跑**——
 * 本页面从宿主服务（host/server）加载，不经 srcdoc、不受编辑器 CSP 约束。
 * 引擎内脏（分页/染色/播放器/IR/栅格）与 Typora 共用 host/browser/deck-core.js。
 *
 * 桥协议（postMessage，设计稿 integration-marktext.md §5.3）：
 *   页面 → 宿主  {type:"md2s:boot"}                     页面就绪（脚本装载完毕，可收 build）
 *   宿主 → 页面  {type:"md2s:build", md, mdDir, runOpts?{mode,browse,startIndex}}
 *   页面 → 宿主  {type:"md2s:ready", pages, index, total, steps, diagrams, images,
 *                 slideWidth, slideHeight, meta, theme, ms}
 *              | {type:"md2s:change", index, total, step, steps, mode}
 *              | {type:"md2s:error", stage:"build", message}
 *              | {type:"md2s:rpc", id, kind:"diagram", diagramType, source}
 *   宿主 → 页面  {type:"md2s:rpc-result", id, ok, dataUrl?|error?}   （图表托渲染应答）
 *   宿主 → 页面  {type:"md2s:export", id, kind:"image"|"editable",
 *                 slideWidth, slideHeight, theme?, meta?}            （导出取数）
 *   页面 → 宿主  {type:"md2s:export-result", id, ok,
 *                 imagesDir?/pages?                                    （kind=image）
 *                 ir?/issues?/mediaDir?/mediaCount?}                  （kind=editable）
 *   大位图不过桥：逐页 POST 到宿主服务的 /x 旁路落盘（数百 MB 过 postMessage→IPC
 *   会把 Electron 卡死——2026-10-31 真机 79 页讲义的教训），桥上只走目录路径。
 *   页面 → 宿主  {type:"md2s:esc"}                     焦点在 deck 内的 Esc 转发
 *
 * 图表三级策略在本形态的落法：
 *   mermaid / echarts → 页面自己画（运行时按需从服务加载，见 ensureDiagramLibs）；
 *   graphviz / plantuml → 经 rpc 托宿主离屏出图（marktext 用 muya 同款 viz WASM /
 *   fetchPlantuml IPC——与编辑器同库同版本，所见一致）；
 *   都失败 → DiagramError 硬失败（deck-core 的闸门），经 md2s:error 上报宿主。
 *
 * rebuild 是**原地**的：宿主防抖后重发 md2s:build，本页面重跑 compose 换 #deck 内容
 * 与样式，不重载页面——脚本与预热资产全程复用，无闪烁。
 */

const deckCore = require("../browser/deck-core")
const { compose } = require("../../core/compose")
const { sectionsOf } = require("../../core/section")
const { CONT_CLASS } = require("../../core/paginate/overflow")

// html-to-image 在本形态是 bundle 模块（sourceRoots 含 lib）；deck-core 的
// ir()/exportImages() 读 window.htmlToImage（Typora 形态由 srcdoc 内联脚本提供）——挂上。
window.htmlToImage = require("../../lib/html-to-image.js")

// ---------------------------------------------------------------------------
// 资产预热：compose 的 readFile 是同步签名，页面里取资产只有异步 fetch。
// 先把清单里的文本资产拉进内存，之后以"按 basename 查表"实现同步 readFile。
// loadTheme 扫目录走的是全局 fs.readdirSync（不经 readFile 钩子），同样打补丁。
// ---------------------------------------------------------------------------

const fileMap = new Map() // basename -> text（主题 css、katex css）
const themeNames = []
let libUrls = {} // {mermaid:"lib/mermaid.min.js", echarts:"lib/echarts.min.js"}（按需加载）
let warmPromise = null

const fetchText = url =>
  fetch(url).then(r => {
    if (!r.ok) throw new Error(`资产取不到：${url}（http ${r.status}——资产包不全？）`)
    return r.text()
  })

const warmAssets = () => {
  if (warmPromise) return warmPromise
  warmPromise = (async () => {
    const manifest = await fetchText("/assets.json").then(JSON.parse)
    for (const name of manifest.themes ?? []) {
      fileMap.set(name, await fetchText(`/themes/${encodeURIComponent(name)}`))
      themeNames.push(name)
    }
    if (manifest.katexCss) {
      const base = String(manifest.katexCss).split("/").pop()
      fileMap.set(base, await fetchText(`/${manifest.katexCss}`))
    }
    libUrls = manifest.libs ?? {}
    const fsStub = window.__md2slides_externals?.fs
    if (fsStub && !fsStub.readdirSync) {
      fsStub.readdirSync = dir => {
        if (String(dir).includes("themes")) return [...themeNames]
        throw new Error(`deck-full: 浏览器里列不了目录（${dir}）——资产清单没盖住这条链路`)
      }
    }
  })()
  return warmPromise
}

/** compose 的 readFile 钩子：按 basename 查预热表。缺件抛错——静默丢主题/公式字体
 *  是 deck.js 头注释里点名要消灭的退化（catch{return ""} 那类），这里必须响。 */
const readFileMap = file => {
  const base = String(file).split(/[\\/]/).pop()
  if (fileMap.has(base)) return fileMap.get(base)
  throw new Error(`资产映射里没有 ${base}（pack 不全，或这条链路需要新资产）`)
}

// ---------------------------------------------------------------------------
// mermaid / echarts 运行时按需加载：纯文本文档不该为 5.5MB 的 mermaid 买单。
// 预扫 md 里的图表围栏（超集即可，多加载无害；代码块里的围栏字面量顶多白载一次）。
// ---------------------------------------------------------------------------

const loadedLibs = new Set()
const ensureLib = async type => {
  if (loadedLibs.has(type)) return
  const rel = libUrls[type]
  if (!rel) return
  await new Promise((resolve, reject) => {
    const el = document.createElement("script")
    el.src = `/${rel}`
    el.onload = resolve
    el.onerror = () => reject(new Error(`图表运行时加载失败：/${rel}`))
    document.head.appendChild(el)
  })
  loadedLibs.add(type)
}

const ensureDiagramLibs = async md => {
  const wanted = new Set([...String(md).matchAll(/^```\s*(mermaid|echarts)\b/gm)].map(m => m[1]))
  for (const type of wanted) await ensureLib(type)
}

// ---------------------------------------------------------------------------
// rpc：graphviz / plantuml 托宿主离屏出图（宿主应答 {dataUrl}——位图在注入那一刻
// 冻结，分页/查看器/IR/导出全链路同一份字节，见设计稿「为什么不留 SVG」的裁决）。
// ---------------------------------------------------------------------------

let rpcSeq = 0
const pending = new Map()

const rpc = (kind, payload, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const id = ++rpcSeq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`宿主 ${kind} 应答超时（${timeoutMs}ms）`))
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    window.parent.postMessage({ type: "md2s:rpc", id, kind, ...payload }, "*")
  })

const rpcDiagram = async block => {
  if (block.type !== "graphviz" && block.type !== "plantuml") return undefined
  return rpc("diagram", { diagramType: block.type, source: block.source })
}

// ---------------------------------------------------------------------------
// build：compose → 注入 → run（deck-core），全程串行（防抖后的 build 不许交叉写 DOM）。
// ---------------------------------------------------------------------------

const post = msg => window.parent.postMessage(msg, "*")

/** 本地相对图片 → 宿主服务的 /f?p=（deck.js 同款改道；服务端 allowRoots 钉死白名单）。 */
const rewriteImages = (doc, mdDir) => {
  let images = 0
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? ""
    if (!src || /^(?:data|blob|https?|file):/i.test(src)) continue
    const abs = mdDir
      ? `${String(mdDir).replace(/[\\/]+$/, "")}/${decodeURIComponent(src)}`
      : decodeURIComponent(src)
    img.setAttribute("src", `${location.origin}/f?p=${encodeURIComponent(abs)}`)
    images += 1
  }
  return images
}

let buildChain = Promise.resolve()

/** 与 build 同链串行：导出取数不许和重建交叉写 DOM。 */
const enqueue = job => {
  buildChain = buildChain.then(job)
  return buildChain
}

// ---------------------------------------------------------------------------
// 列表态（幻灯片列表，形态模型 v2 §4）：全部物理页堆叠 + 视口适配缩放 +
// 溢出警告。物理分页在 deck-core.run(view:"list") 里照常跑，这里只管展示：
// #deck 从"绝对定位的舞台"变成"纵向卡片流"，每页 zoom 到视口宽。警告的诚实
// 语义：物理分页永不产出溢出页（装不下即切（续）页），"溢出" = 一个逻辑页被
// 切成 N 张物理页——按（续）标记（CONT_CLASS）连片分组，组内 N>1 打标。
// ---------------------------------------------------------------------------

const LIST_CSS_ID = "md2slides-list-css"

const ensureListCss = () => {
  if (document.getElementById(LIST_CSS_ID)) return
  const el = document.createElement("style")
  el.id = LIST_CSS_ID
  // 反向 zoom（calc(1/var)）让警告标的视觉尺寸不随页缩放变小；Electron 的
  // Chromium 接受 calc 的 zoom（不接受时退化成"跟着页一起缩"，可接受）。
  el.textContent = `
html.md2s-list, html.md2s-list body { overflow: auto; height: auto; background: #23252b; }
html.md2s-list #deck {
  position: static; inset: auto;
  padding: 24px 24px 60vh;
  display: flex; flex-direction: column; align-items: center; gap: 24px;
}
html.md2s-list #deck > section {
  position: relative; flex: none;
  zoom: var(--md2s-list-zoom, 0.3);
}
html.md2s-list #deck > section.md2s-cont-page {
  outline: calc(3px / var(--md2s-list-zoom, 0.3)) dashed #d97706;
  outline-offset: calc(-6px / var(--md2s-list-zoom, 0.3));
}
.md2s-list-warn {
  position: absolute; top: 24px; right: 24px; z-index: 3;
  padding: 6px 18px; border-radius: 24px;
  background: #b45309; color: #fff;
  font-size: 26px; font-family: system-ui, sans-serif; font-weight: 600;
  zoom: calc(1 / var(--md2s-list-zoom, 0.3));
}
`
  document.head.appendChild(el)
}

let listZoomObs = null

const applyListView = slideWidth => {
  ensureListCss()
  document.documentElement.classList.add("md2s-list")
  const fit = () => {
    const avail = document.documentElement.clientWidth - 48
    const z = Math.min(1, Math.max(0.05, avail / slideWidth))
    document.documentElement.style.setProperty("--md2s-list-zoom", String(z))
  }
  fit()
  if (!listZoomObs) {
    listZoomObs = new ResizeObserver(fit)
    listZoomObs.observe(document.documentElement)
  }
  return markOverflowWarnings()
}

/** 溢出警告：按（续）连片分组，返回被切成多页的逻辑页数。幂等（每次 build 后
 *  在全新 section 集上重打）。 */
const markOverflowWarnings = () => {
  const sections = sectionsOf(document)
  let warned = 0
  let i = 0
  while (i < sections.length) {
    let j = i
    while (j + 1 < sections.length && sections[j + 1].querySelector(`.${CONT_CLASS}`)) j++
    const n = j - i + 1
    if (n > 1) {
      warned += 1
      const badge = document.createElement("div")
      badge.className = "md2s-list-warn"
      badge.textContent = `${n}页`
      sections[i].appendChild(badge)
      for (let k = i; k <= j; k++) sections[k].classList.add("md2s-cont-page")
    }
    i = j + 1
  }
  return warned
}

const doBuild = async msg => {
  const started = performance.now()
  try {
    await warmAssets()
    await ensureDiagramLibs(msg.md ?? "")
    const deck = compose(msg.md ?? "", {
      document,
      themesDir: "/themes",
      readFile: readFileMap,
      katexFontsUrl: `${location.origin}/fonts/`,
    })
    // compose 的 html 是它完成那一刻的快照——图片改道发生在 deck.doc 上，
    // 必须改完再序列化（API.md 时序铁律 3 同款坑）。
    const images = rewriteImages(deck.doc, msg.mdDir)
    const deckEl = deck.doc.querySelector(".md2slides-deck")
    const html = deckEl ? deckEl.innerHTML : deck.html

    let styleEl = document.getElementById("md2slides-deck-css")
    if (!styleEl) {
      styleEl = document.createElement("style")
      styleEl.id = "md2slides-deck-css"
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = deck.css
    const root = document.getElementById("deck") ?? document.body
    // 列表态原地重建时保住滚动位置：#deck 换内容前记下，分页收敛后回放。
    const savedScroll = document.documentElement.classList.contains("md2s-list")
      ? window.scrollY
      : 0
    root.innerHTML = html

    const { mode, browse, startIndex, view } = msg.runOpts ?? {}
    const result = await deckCore.run({
      slideWidth: deck.slideWidth,
      slideHeight: deck.slideHeight,
      meta: deck.meta,
      renderDiagramHost: rpcDiagram,
      onChange: ({ index, total, step, steps, mode: m }) =>
        post({ type: "md2s:change", index, total, step, steps, mode: m }),
      mode,
      browse,
      startIndex,
      view,
    })
    const warnings = view === "list" ? applyListView(deck.slideWidth) : 0
    if (view === "list") window.scrollTo(0, savedScroll)
    post({
      type: "md2s:ready",
      pages: result.pages,
      index: result.index,
      total: result.total,
      steps: result.steps,
      diagrams: result.diagrams,
      images,
      slideWidth: deck.slideWidth,
      slideHeight: deck.slideHeight,
      meta: deck.meta,
      theme: deck.theme,
      warnings,
      // 构建耗时（ms）：M3 增量分排裁决的实测数据源——宿主顺手 log 即可攒样本。
      ms: Math.round(performance.now() - started),
    })
  } catch (error) {
    post({ type: "md2s:error", stage: "build", message: error?.message ?? String(error) })
  }
}

const build = msg => enqueue(() => doBuild(msg))

// ---------------------------------------------------------------------------
// 导出取数（M2）：宿主发 md2s:export，页面跑 deck-core 的 exportImages()/ir()，
// 数据经 export-result 回宿主——出片在宿主 main 进程（host/pptx 的 exportFromData）。
// ---------------------------------------------------------------------------

/** 旁路会话：开（拿 sid+dir）→ 逐件 POST → 收（回 dir）。失败即弃——临时目录留给 OS 清。 */
const exportSideChannel = {
  begin: async () => {
    const r = await fetch("/x?op=begin").then(x => x.json())
    return r
  },
  put: (sid, name, base64) =>
    fetch(`/x?op=page&sid=${encodeURIComponent(sid)}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: base64,
    }),
  done: async sid => fetch(`/x?op=done&sid=${encodeURIComponent(sid)}`).then(x => x.json()),
  abort: async sid => {
    void fetch(`/x?op=abort&sid=${encodeURIComponent(sid)}`).then(x => x.json())
  },
}

const doExport = async msg => {
  let sid = null
  try {
    if (msg.kind === "image") {
      const images = await deckCore.exportImages({
        slideWidth: msg.slideWidth,
        slideHeight: msg.slideHeight,
      })
      // 旁路落盘：位图逐页 POST 到宿主服务（不过 postMessage/IPC——大体量会挂死）。
      sid = (await exportSideChannel.begin()).sid
      for (let i = 0; i < images.length; i++) {
        const b64 = String(images[i]).split(",")[1] ?? ""
        await exportSideChannel.put(sid, `page-${String(i + 1).padStart(4, "0")}.png`, b64)
      }
      const { dir } = await exportSideChannel.done(sid)
      sid = null
      post({ type: "md2s:export-result", id: msg.id, ok: true, imagesDir: dir, pages: images.length })
      return
    }
    const { ir, issues, media } = await deckCore.ir({
      slideWidth: msg.slideWidth,
      slideHeight: msg.slideHeight,
      theme: msg.theme ?? null,
      meta: msg.meta ?? null,
    })
    // 闸门结果原样回传：issues 非空 → ok:false，宿主直接展示话术，不进出片。
    if (issues.length) {
      post({ type: "md2s:export-result", id: msg.id, ok: false, ir, issues })
      return
    }
    // media 同理走旁路；IR 本体是几百 KB 的 JSON，桥上直传没问题。
    sid = (await exportSideChannel.begin()).sid
    for (const item of media ?? []) {
      const b64 = String(item.dataUrl).split(",")[1] ?? ""
      await exportSideChannel.put(sid, item.name, b64)
    }
    const { dir } = await exportSideChannel.done(sid)
    sid = null
    post({ type: "md2s:export-result", id: msg.id, ok: true, ir, issues, mediaDir: dir, mediaCount: (media ?? []).length })
  } catch (error) {
    if (sid) void exportSideChannel.abort(sid)
    post({ type: "md2s:export-result", id: msg.id, ok: false, error: error?.message ?? String(error) })
  }
}

window.addEventListener("message", ev => {
  const data = ev.data
  if (!data || typeof data !== "object") return
  if (ev.source !== window.parent) return
  if (data.type === "md2s:build") void build(data)
  else if (data.type === "md2s:export") void enqueue(() => doExport(data))
  else if (data.type === "md2s:rpc-result" && pending.has(data.id)) {
    const p = pending.get(data.id)
    pending.delete(data.id)
    clearTimeout(p.timer)
    if (data.ok) p.resolve(data.dataUrl ? { dataUrl: data.dataUrl } : data.result)
    else p.reject(new Error(data.error || "宿主渲染失败"))
  }
})

// 同源调试面（宿主/测试可直调）；跨源宿主一律走 postMessage。
window.deckFull = { build, getPlayer: deckCore.getPlayer }

// Esc 转发：焦点在 deck 里时退出键到不了宿主（跨源，键盘事件不过来），转成
// md2s:esc 让宿主退场。lightbox / exec 浮层会在 window 捕获层吃掉自己的 Esc
// （stopPropagation），不会误触发这里。
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") post({ type: "md2s:esc" })
})

// 页面就绪信号：宿主收到它才发首帧 build（早发的消息没人接，会静默丢）。
post({ type: "md2s:boot" })
