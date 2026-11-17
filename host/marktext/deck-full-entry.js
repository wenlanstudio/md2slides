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
 *              | {type:"md2s:build", html, mdDir, runOpts?…}      （HTML 放映稿，契约 v1）
 *   页面 → 宿主  {type:"md2s:ready", pages, index, total, steps, diagrams, images,
 *                 slideWidth, slideHeight, meta, theme, ms}
 *              | {type:"md2s:change", index, total, step, steps, mode}
 *              | {type:"md2s:warn", message}                       （缺图占位等非致命提示）
 *              | {type:"md2s:error", stage:"build", message}
 *              | {type:"md2s:error", stage:"validate", code:"E_CONTRACT_VIOLATION",
 *                 contractVersion, message, issues[], rawCount}   （HTML 契约校验拒绝）
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
const { CONT_CLASS, OVERFLOW_CLASS, MEDIA_SHRUNK_CLASS } = require("../../core/paginate/overflow")
const {
  validateHtmlDeck,
  formatIssues,
  CONTRACT_VERSION,
} = require("../../core/htmlDeck/validate")

// html-to-image 在本形态是 bundle 模块（sourceRoots 含 lib）；deck-core 的
// ir()/exportImages() 读 window.htmlToImage（Typora 形态由 srcdoc 内联脚本提供）——挂上。
window.htmlToImage = require("../../lib/html-to-image.js")

// ---------------------------------------------------------------------------
// 缺口 B（2026-11-15 发题对齐）：当前页的 quiz 标记 id 列表。
// 教师版放映 DOM 的题干元素带 data-md2s-quiz="{qid}"（core/quiz/registerQuiz 产物；
// 学生版投影才会被 strip），quiz 标记 id 与服务端 question_key 恒等——
// 随 md2s:change 上报后，宿主发题面板把本页题置顶。
// ---------------------------------------------------------------------------
const currentPageQuizKeys = () => {
  try {
    const current = document.querySelector("section.md2s-current")
    if (!current) return []
    return [...current.querySelectorAll("[data-md2s-quiz]")]
      .map(el => el.getAttribute("data-md2s-quiz"))
      .filter(Boolean)
  } catch {
    return []
  }
}

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
  // 页面里画不了的图表交给宿主（父页面）出位图：graphviz / plantuml / matplotlib。
  // mermaid / echarts 是浏览器运行时，页面自己渲染，不走这条。
  if (block.type !== "graphviz" && block.type !== "plantuml" && block.type !== "matplotlib") {
    return undefined
  }
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

/* 构建期隐藏 #deck：内容注入后到 deckCore.run() 应用 transform/单页显示之间有一帧
   裸渲染——封面 h1 按 1920 设计画布铺开，缩放未生效时看着偏右偏大（用户 2026-11-16
   截图）。ready 后显示，rebuild 时再隐藏；出错/空稿也必须恢复，别把放映留成白屏。 */
const setDeckBuilding = (on) => {
  const root = document.getElementById("deck")
  if (root) root.style.visibility = on ? "hidden" : ""
}

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
/* 诚实溢出页（2026-11-17 拍板：放不下就原样保留）：红实线比切分的琥珀虚线更重——
   切分是引擎办妥了的事，溢出是等作者办的事。 */
html.md2s-list #deck > section.${OVERFLOW_CLASS} {
  outline: calc(3px / var(--md2s-list-zoom, 0.3)) solid #dc2626;
  outline-offset: calc(-6px / var(--md2s-list-zoom, 0.3));
}
.md2s-list-warn {
  position: absolute; top: 24px; right: 24px; z-index: 3;
  padding: 6px 18px; border-radius: 24px;
  background: #b45309; color: #fff;
  font-size: 26px; font-family: system-ui, sans-serif; font-weight: 600;
  zoom: calc(1 / var(--md2s-list-zoom, 0.3));
}
/* 「超出」红徽章放左上，避开右上切分组的「N页」琥珀徽章（同页可两者兼有）；
   「图已缩」蓝徽章再往下错一层。 */
.md2s-overflow-warn { top: 24px; right: auto; left: 24px; background: #dc2626; }
.md2s-shrunk-warn { top: 88px; right: auto; left: 24px; background: #0369a1; }
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
 *  在全新 section 集上重打）。另打两类单页标记（2026-11-17 拍板的提醒体系）：
 *  诚实溢出页红实线 + 「超出」（内容按原样留在这一页、底部被裁，等作者改文档）；
 *  图片被分页缩放过的页挂「图已缩」蓝徽章（缩放是认可的正路，只提示）。 */
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
  for (const s of sections) {
    if (!s.classList.contains(OVERFLOW_CLASS)) continue
    const badge = document.createElement("div")
    badge.className = "md2s-list-warn md2s-overflow-warn"
    badge.textContent = "超出"
    s.appendChild(badge)
    warned += 1
  }
  for (const s of sections) {
    if (!s.classList.contains(MEDIA_SHRUNK_CLASS)) continue
    const badge = document.createElement("div")
    badge.className = "md2s-list-warn md2s-shrunk-warn"
    badge.textContent = "图已缩"
    s.appendChild(badge)
  }
  return warned
}

// ---------------------------------------------------------------------------
// 缺图护栏：markdown 引用了不存在的图片时，旧行为是整单失败、报「[object Event]」
// （html-to-image 的 createImage 把 onerror 的 Event 原样 reject；可编辑型更糟——
// imageBlock 把 http URL 当 dataUrl 塞进 media，sidecar 按 PNG 落盘，PIL 直接炸）。
// 改为构建时检测：坏图换画布画的占位 PNG（媒体通道只认 dataURL），缺失清单经
// md2s:warn 报宿主——演示继续，损失可见。（2026-11-03 讲义真机翻车的修复）
// ---------------------------------------------------------------------------

/** 事件/未知抛出物 → 人话（Error 用 message；Event 带 type 与目标 src）。 */
const describeError = error => {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && typeof error.type === "string") {
    const target = error.target
    const what = target?.src
      ? `（${String(target.src).slice(0, 200)}）`
      : target?.tagName
        ? `（${target.tagName}）`
        : ""
    return `${error.type} 事件 ${what}`.trim()
  }
  return String(error)
}

/** 占位图（PNG dataURL）：媒体通道按 .png 落盘、sidecar 按 PNG 读，必须是真 PNG。 */
const placeholderPng = label => {
  const c = document.createElement("canvas")
  c.width = 640
  c.height = 400
  const g = c.getContext("2d")
  g.fillStyle = "#565656"
  g.fillRect(0, 0, c.width, c.height)
  g.strokeStyle = "#7a7a7a"
  g.lineWidth = 4
  g.strokeRect(8, 8, c.width - 16, c.height - 16)
  g.fillStyle = "#ffffff"
  g.textAlign = "center"
  g.textBaseline = "middle"
  g.font = "600 44px sans-serif"
  g.fillText("缺图", c.width / 2, 150)
  g.font = "24px sans-serif"
  g.fillStyle = "#d8d8d8"
  g.fillText(label, c.width / 2, 240, 560)
  return c.toDataURL("image/png")
}

let missingImages = []

const labelOfSrc = src => {
  try {
    return decodeURIComponent(new URL(src, location.href).pathname.split("/").pop() || "") || "image"
  } catch {
    return "image"
  }
}

/** 坏图（载完但 0 宽）换成占位 PNG；返回本次新标记的张数。幂等（dataset 门闩）。 */
const markMissingImages = () => {
  let marked = 0
  for (const img of document.images) {
    if (img.dataset.md2sMissing) continue
    if (img.src.startsWith("data:")) continue
    // lightbox 浮层自己的 <img> 没有 src 是常态，不是缺图——空 src 会被解析成
    // 页面自身（"deck.html"），曾把「缺图 1 张：deck.html」的假警告刷给每份讲义。
    if (img.closest(".md2s-lb")) continue
    if (!img.complete || img.naturalWidth > 0) continue
    img.dataset.md2sMissing = "1"
    const label = labelOfSrc(img.getAttribute("src") ?? img.src)
    img.src = placeholderPng(label)
    missingImages.push(label)
    marked += 1
  }
  return marked
}

/** 等未完成的图片落定（load/error 都算），限时兜底防挂死，然后补标坏图。 */
const waitForDeckImages = async (timeoutMs = 10000) => {
  const pending = [...document.images].filter(img => !img.complete)
  if (pending.length) {
    await Promise.race([
      Promise.all(
        pending.map(img =>
          new Promise(resolve => {
            img.addEventListener("load", () => resolve(), { once: true })
            img.addEventListener("error", () => resolve(), { once: true })
          })
        )
      ),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ])
  }
  markMissingImages()
}

/** 宿主钉死画布（契约 §5）：只管尺寸/盒模型，配色与排版交文稿 <style>。
 *  每次 rebuild 重写内容（同一 iframe 可能换用不同画布），但只挂一个 style 节点。 */
const injectHtmlBaseCss = (sw, sh) => {
  let el = document.getElementById("md2slides-html-base-css")
  if (!el) {
    el = document.createElement("style")
    el.id = "md2slides-html-base-css"
    document.head.appendChild(el)
  }
  el.textContent = `
section[data-slide] {
  position: relative;
  box-sizing: border-box;
  width: ${sw}px;
  height: ${sh}px;
  overflow: hidden;
}
`
}

/** 文稿 <style> 统一挂到 head（每次 rebuild 全量替换，避免旧样式残留）。 */
const injectDeckStyles = styles => {
  let el = document.getElementById("md2slides-html-deck-css")
  if (!el) {
    el = document.createElement("style")
    el.id = "md2slides-html-deck-css"
    document.head.appendChild(el)
  }
  el.textContent = styles.map(s => s.textContent || "").join("\n")
}

/**
 * 第三方 HTML 放映稿分支（msg.html）——契约 v1 的宿主实现，见
 * md2slides/docs/html-deck-contract.md。
 *
 * §2 摄取模型：DOMParser 解析 → ② validateHtmlDeck 校验（有 error 即结构化拒绝、
 * 不注入、不包装、不降级）→ ③ 只提取唯一 #deck 子树 + 全部 <style> →
 * ⑤ importNode 注入宿主 #deck → deckCore.run({skipBuild:true})。
 */
const buildHtml = async (msg, started) => {
  // ① 解析：独立于宿主 DOM，校验器看到的就是作者写的那份文稿。
  const source = String(msg.html ?? "")
  const parsed = new DOMParser().parseFromString(source, "text/html")

  // ② 校验：硬契约，有任何 error 就拒绝（P7）。
  const verdict = validateHtmlDeck(parsed)
  if (!verdict.ok) {
    setDeckBuilding(false) // doBuild 已置隐藏，校验失败也要放行（宿主会显示错误）
    post({
      type: "md2s:error",
      stage: "validate",
      code: "E_CONTRACT_VIOLATION",
      contractVersion: CONTRACT_VERSION,
      message: formatIssues(verdict),
      issues: verdict.issues,
      rawCount: verdict.rawCount,
    })
    return
  }

  const sw = verdict.canvas.width
  const sh = verdict.canvas.height
  const root = document.getElementById("deck") ?? document.body
  const savedScroll = document.documentElement.classList.contains("md2s-list")
    ? window.scrollY
    : 0

  // ③ 提取有效载荷；④ 外壳/垃圾节点一律丢弃。
  const sourceDeck = parsed.querySelector("#deck")
  const styles = [...parsed.querySelectorAll("style")]
  injectHtmlBaseCss(sw, sh)
  injectDeckStyles(styles)
  root.innerHTML = ""
  for (const child of [...sourceDeck.children]) {
    if (child.tagName === "STYLE") continue // 已统一进 head
    root.appendChild(document.importNode(child, true))
  }

  // 相对图片改道到本地服务（与 md 分支同款 /f?p=；allowRoots 含 mdDir）。
  if (msg.mdDir) rewriteImages(document, msg.mdDir)
  // 缺图必须赶在测量前换成占位（坏图 0 宽 vs 占位有真实几何）。
  await waitForDeckImages()

  const { mode, browse, startIndex, view, stepLines } = msg.runOpts ?? {}
  const result = await deckCore.run({
    slideWidth: sw,
    slideHeight: sh,
    meta: null,
    renderDiagramHost: rpcDiagram,
    onChange: ({ index, total, step, steps, mode: m }) =>
      post({ type: "md2s:change", index, total, step, steps, mode: m, quizKeys: currentPageQuizKeys() }),
    mode,
    browse,
    stepLines,
    onOpenExternal: url => post({ type: "md2s:link-open", url }),
    startIndex,
    view,
    skipBuild: true,
  })
  const warnings = view === "list" ? applyListView(sw) : 0
  if (view === "list") window.scrollTo(0, savedScroll)

  // SHOULD 级建议随 warn 提示，不阻止放映。
  const notes = []
  for (const w of verdict.warns) {
    notes.push(`[${w.rule}] ${w.message}${w.count > 1 ? `（×${w.count}）` : ""}`)
  }
  if (missingImages.length) {
    notes.push(`缺图 ${missingImages.length} 张，已用占位图：${[...new Set(missingImages)].join("、")}`)
  }
  if (notes.length) post({ type: "md2s:warn", message: notes.join("；") })

  setDeckBuilding(false) // 缩放/单页已就位，此刻才放行显示（避免裸渲染偏位标题闪现）
  post({
    type: "md2s:ready",
    pages: result.pages,
    index: result.index,
    total: result.total,
    steps: result.steps,
    diagrams: result.diagrams,
    images: 0,
    slideWidth: sw,
    slideHeight: sh,
    meta: null,
    theme: null,
    warnings,
    ms: Math.round(performance.now() - started),
  })
}

const doBuild = async msg => {
  const started = performance.now()
  missingImages = []
  setDeckBuilding(true)
  try {
    // 第三方 HTML 放映稿：绕开 compose，已编排好的 DOM 直接建播放器。
    if (msg.html != null) {
      await buildHtml(msg, started)
      return
    }
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
    // 缺图必须赶在分页前换成占位（坏图 0 宽 vs 占位有真实几何，量晚了页就错）。
    await waitForDeckImages()

    const { mode, browse, startIndex, view, stepLines } = msg.runOpts ?? {}
    const result = await deckCore.run({
      slideWidth: deck.slideWidth,
      slideHeight: deck.slideHeight,
      meta: deck.meta,
      renderDiagramHost: rpcDiagram,
      onChange: ({ index, total, step, steps, mode: m }) =>
        post({ type: "md2s:change", index, total, step, steps, mode: m, quizKeys: currentPageQuizKeys() }),
      mode,
      browse,
      stepLines,
      onOpenExternal: url => post({ type: "md2s:link-open", url }),
      startIndex,
      view,
    })
    const warnings = view === "list" ? applyListView(deck.slideWidth) : 0
    if (view === "list") window.scrollTo(0, savedScroll)
    // 非致命提示合并成一条：面板只有一个胶囊，各自 post 会互相覆盖。
    const notes = []
    if (deck.themeWarning) notes.push(deck.themeWarning)
    if (missingImages.length) {
      notes.push(`缺图 ${missingImages.length} 张，已用占位图：${[...new Set(missingImages)].join("、")}`)
    }
    // 分页警告（诚实溢出/图片缩放，deck-core 收集）只在**览视图**显示（2026-11-17
    // 用户拍板）：映视图是讲授面，不放作者侧诊断——览视图页上的红框/徽章已经
    // 指了位置，胶囊再给文字细节。console.warn 照发，排障日志不受影响。
    if (view === "list") {
      for (const d of result.diags ?? []) {
        if (d.level === "warning" && !notes.includes(d.message)) notes.push(d.message)
      }
    }
    if (notes.length) post({ type: "md2s:warn", message: notes.join("；") })
    setDeckBuilding(false) // 缩放/单页已就位，此刻才放行显示（避免裸渲染偏位标题闪现）
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
    // 协议只带人话 message；堆栈留给宿主日志——没有它，构建失败就只剩一句
    // "Cannot read properties of undefined"，排障得靠猜。
    setDeckBuilding(false) // 出错也要放行，别把放映留成永久白屏
    console.error("[deck] build failed:", error)
    post({ type: "md2s:error", stage: "build", message: describeError(error) })
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
    // 保险丝：media 通道只认 dataURL——imageBlock 万一塞进 http URL（构建后又坏过
    // 一场的残骸），写盘就是 PIL 读不出的文本文件，sidecar 当场炸。换占位图续走。
    const safeMedia = (media ?? []).map(item =>
      String(item.dataUrl).startsWith("data:image/")
        ? item
        : { ...item, dataUrl: placeholderPng("缺图") }
    )
    // media 同理走旁路；IR 本体是几百 KB 的 JSON，桥上直传没问题。
    sid = (await exportSideChannel.begin()).sid
    for (const item of safeMedia) {
      const b64 = String(item.dataUrl).split(",")[1] ?? ""
      await exportSideChannel.put(sid, item.name, b64)
    }
    const { dir } = await exportSideChannel.done(sid)
    sid = null
    post({
      type: "md2s:export-result",
      id: msg.id,
      ok: true,
      ir,
      issues,
      mediaDir: dir,
      mediaCount: safeMedia.length,
    })
  } catch (error) {
    if (sid) void exportSideChannel.abort(sid)
    post({ type: "md2s:export-result", id: msg.id, ok: false, error: describeError(error) })
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
