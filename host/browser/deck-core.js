"use strict";

/**
 * deck-core.js — deck 页面（iframe 里那一半）的**引擎内脏**，宿主无关。
 *
 * 两个页面入口共用这一份（渲染器两份实现必然漂移，漂移的后果是「预览什么样，
 * 导出就什么样」破产）：
 *   · `host/typora/deck-entry.js`（→ dist/deck-page.js）：Typora 形态——父侧 Node
 *     compose 好再序列化进 srcdoc，这里只跑"需要真实布局的那半程"；
 *   · `host/marktext/deck-full-entry.js`（→ dist/deck-full.js）：marktext 形态——
 *     渲染进程全沙箱，compose 也搬进页面里跑，本模块的 run/ir/exportImages 照用。
 *
 * 加载即注入两段样式：续页标记（CONT_CSS）与目录页（TOC_CSS）。它们跟着**运行代码
 * 的版本**走，父侧只传 deck.css——样式与实现漂移是旧壳的老毛病。
 */

const { splitOverflow, CONT_CSS, OVERFLOW_CSS } = require("../../core/paginate/overflow")
const { TOC_CSS } = require("../../core/paginate/toc")
const { highlightCode } = require("../../core/render/highlight")
const { renderDiagrams, assertDiagramsRendered } = require("../../core/render/diagramHost")
const { renderDiagram: pageRenderDiagram, BROWSER_TYPES } = require("./index")
const { sectionsOf } = require("../../core/section")
const { createDeckPlayer } = require("../../kit/player")
const { layoutShortBlocks, SHORT_CSS } = require("../../kit/shortCode")
const { mountLightbox } = require("../../kit/lightbox")
const { mountLinkbox } = require("../../kit/linkbox")
const { extractIr } = require("../../export/pptx/ir")
const { checkIr } = require("../../export/pptx/check")

const injectStyle = (id, css) => {
  if (document.getElementById(id)) return
  const el = document.createElement("style")
  el.id = id
  el.textContent = css
  document.head.appendChild(el)
}

// 续页标记的样式不在主题里，宿主必须拼进 deck CSS（API.md §2.3）——在这里拼，
// 跟着运行代码的版本走。播放器样式不用管：createDeckPlayer 自己幂等注入。
injectStyle("md2slides-cont-css", CONT_CSS)
// 目录页（章节目录，core/paginate/toc.js）：同续页标记——引擎产物的兜底样式跟着
// 代码版本走。主题里也有一份完整的，那边是"长什么样"，靠 :where() 让主题必赢。
injectStyle("md2slides-toc-css", TOC_CSS)
// 诚实溢出（2026-11-17 拍板：段落/分栏放不下就原样保留）：页面裁掉放不下的部分，
// 内容仍在 DOM 里。同为引擎产物的兜底样式，跟着代码版本走。
injectStyle("md2slides-overflow-css", OVERFLOW_CSS)
// 两栏活格（`python short`，2026-11-26 定稿）：格子的占位预算与运行期形态。
// 与上面三段同为「跟着运行代码走」的兜底样式，主题可覆盖。
injectStyle("md2slides-short-css", SHORT_CSS)

/**
 * 反复分页直到没活干（`splitOverflow` 返回 0）。
 *
 * 外层多跑几轮不是浪费：染色会往代码块里塞 span，理论上不改高度，但那正是要验的事
 * ——`settleDeck`（e2e/runner.js）用同一段逻辑兜"染色后回潮"。
 */
const paginate = opts => {
  let added = 0
  for (let i = 0; i < 8; i++) {
    added = splitOverflow(document, opts)
    if (!added) break
  }
  return added
}

/** 当前 deck 根容器：父侧序列化时统一放 `#deck`，兜底 body。 */
const rootOf = () => document.getElementById("deck") ?? document.body

/**
 * 导出前强制所有页可见。播放器把非当前页设成 `display:none`，IR 量几何会全部 0、
 * 逐页栅格会漏页——导出时临时打掉这条隐藏规则，完事再撤。
 * @returns {() => void} 还原函数
 */
const showAllSlides = () => {
  const style = document.createElement("style")
  style.setAttribute("data-md2s-export", "")
  style.textContent = ".md2s-stage>section[data-slide]{display:flex!important;}"
  document.head.appendChild(style)
  // 契约 v1 §4.1：导出恒取静态终态，冻结宿主触发的动画（.md2s-anim-play）。
  player?.freezeAnims?.()
  return () => {
    style.remove()
    player?.unfreezeAnims?.()
  }
}

let player = null
/**
 * 图片查看器（全屏缩放/拖动，kit/lightbox.js）。挂在 iframe 的 document 上就够了——图片
 * 的 DOM 就在这份文档里，不需要父侧 bridge。同一 iframe 只 mount 一次（run 可能被重调）。
 * 它不碰图片 DOM 一个字节（触发靠事件委托认 IMG），对 IR / PPTX 导出零影响。
 */
let lightbox = null

/**
 * 超链接浮层（kit/linkbox.js，2026-11-17）：Enter 命中链接 → iframe 显示网页，
 * 翻页笔开关。「在浏览器打开」交给宿主回调（wenlan 用 shell.openExternal）。
 * 同一 iframe 只 mount 一次（run 可能被重调）。对外经 opts.onOpenExternal 注入，
 * 与宿主解耦——Typora 形态不传就只预览、按钮点了无动作。
 */
let linkbox = null

/**
 * 图表预通行：mermaid / echarts 是浏览器运行时，svg 栅格要 canvas，
 * 页面侧用 host/browser 的真渲染器画。
 *
 * 时序铁律（API.md）：必须在分页实测**之前**——晚一步 overflow.js 量到的就是 0，
 * IR 的几何跟着全错。跑完当场过 `assertDiagramsRendered` 闸门：接不了的图会在这里
 * 炸，run() 拒绝——用户永远看不到「图源当代码块留在 deck 里」这种静默退化。
 *
 * @param {object} [opts]
 * @param {Function} [opts.renderDiagramHost] 宿主额外渲染器（marktext 形态：
 *        graphviz/plantuml 经 postMessage 托外壳离屏出图）。返回 {dataUrl} 或抛错；
 *        只接 BROWSER_TYPES 之外的类型，浏览器类型仍走页面渲染器。传了它，本遍
 *        处理全部图表类型；不传（Typora 形态）行为与旧版逐字节一致：only=BROWSER_TYPES。
 * @returns {Promise<{rendered: number, types: string[]}>}
 */
const diagramPass = async (opts = {}) => {
  const host = typeof opts.renderDiagramHost === "function" ? opts.renderDiagramHost : null
  const result = await renderDiagrams(document, {
    renderDiagram: block =>
      host && !BROWSER_TYPES.includes(block.type) ? host(block) : pageRenderDiagram(block),
    ...(host ? {} : { only: BROWSER_TYPES }),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  })
  assertDiagramsRendered(document)
  return result
}

/**
 * 分页收敛 → 补染 → 建播放器。宿主在 iframe load 后调用（或每次 rebuild 重调）。
 *
 * @param {object} [opts]
 * @param {number} opts.slideWidth / opts.slideHeight 画布尺寸（compose 的返回值）
 * @param {object} [opts.meta]     八键元数据（页眉页脚的输入）
 * @param {"page"|"element"} [opts.mode] 放映形态，默认 page（"slide" 旧键 = page+browse:false）
 * @param {boolean} [opts.browse]  仅 page 形态：true（默认）逐元素游走 / false 纯整页翻
 * @param {boolean} [opts.stepLines] 代码块行粒度遍历（front-matter stepLines: true），透传 player
 * @param {Function} [opts.onOpenExternal] (url) => void——链接浮层「在浏览器打开」回调；宿主用
 *   shell.openExternal 实现。不传则该按钮点了无动作（浮层内 iframe 预览仍可用）。
 * @param {Function} [opts.onChange] 翻页/步进回调（宿主状态栏用；list 视图不触发）
 * @param {number} [opts.startIndex] 起始页（1 基，P3-c 光标锚点用；list 视图忽略）
 * @param {Function} [opts.renderDiagramHost] 见 diagramPass（marktext 形态）
 * @param {"present"|"list"} [opts.view] 展示视图，默认 present（一次一页的播放器）。
 *   "list" = 幻灯片列表（形态模型 v2 §4）：**物理分页照跑**（真页），但不建播放器
 *   ——堆叠/缩放/溢出警告由页面侧（deck-full 的 applyListView）负责。同一 iframe
 *   实例的 view 恒定（宿主为 slide/present 两叶各开一个实例），rebuild 原样保留。
 * @param {boolean} [opts.skipBuild] 第三方 HTML 放映稿分支（deck-full-entry 的
 *   msg.html）：DOM 已由作者编排好（<section data-slide> + 画布排版），跳过图表预通行
 *   / 物理分页 / 代码染色三道"改写 DOM"的工序，直接建播放器（见 html-slide.md）。
 * @returns {Promise<{pages: number, index: number, total: number, steps: number,
 *                     diagrams: number, player: object|null}>}
 *   player 是活的播放器句柄（activate/next/go/…）——**同源调用方**（宿主经
 *   contentWindow 直接调）拿到的是真引用，可立即装饰页面（挂可激活 ▶）并驱动播放器；
 *   经 CDP/序列化通道（e2e、调试台）取到的只是快照对象，请改用 getPlayer()。
 *   list 视图 player 为 null。
 */
const run = async (opts = {}) => {
  // 第三方 HTML 放映稿：DOM 已由作者编排（<section data-slide> + 画布排版），
  // 跳过改写 DOM 的三道工序（图表预通行 / 物理分页 / 代码染色），直接建播放器。
  const skipBuild = opts.skipBuild === true
  // 分页警告（诚实溢出/图片缩放…）收集于此，随 run() 结果回宿主——宿主聚合进
  // md2s:warn，放映态也看得见哪里装不下。skipBuild（HTML 放映稿）不分页，恒空。
  const diags = []
  // 图表预通行先行：浏览器类型图先画完（外加宿主托渲染的类型），再谈测量。
  const diagram = skipBuild ? { rendered: 0 } : await diagramPass(opts)
  if (!skipBuild) {
    const paginateOpts = {
      slideWidth: opts.slideWidth,
      slideHeight: opts.slideHeight,
      meta: opts.meta ?? null,
      contMarker: opts.contMarker ?? "（续）",
      margin: opts.margin ?? 1,
      diags,
    }
    paginate(paginateOpts)
    // 切页会丢高亮 span，收敛后必须补染（API.md 时序铁律 2）
    const painted = highlightCode(document)
    // 两栏活格（`python short`）：必须赶在染色**之后**（highlight 用 innerHTML 整段
    // 覆盖，早一步行包装全毁）、分页复测**之前**（右列占位预算分页量得到）。
    // 双条件 = front-matter stepLines: true + 围栏 short 修饰词（meta 与围栏同出
    // 一份 md，自洽）。改造会改行宽/行高 → 复测分页。
    const shorted = layoutShortBlocks(document, {
      enabled: opts.meta?.stepLines === true,
      diags,
    })
    if (painted > 0 || shorted > 0) paginate(paginateOpts)
  }

  // 原地重建（deck-full 的防抖 rebuild 会重调 run）：先拆旧播放器，键盘/触屏监听
  // 不许累积。首次运行为 null，Typora 形态不受影响。
  player?.destroy?.()
  if (opts.view === "list") {
    // 列表态：物理分页照常（真页 + 真主题），无播放器、无翻页步进。
    player = null
    lightbox = lightbox ?? mountLightbox(document, {
      maxScale: 12,
      // 关闭浮窗后把焦点还给播放器容器（createDeckPlayer 会给 root 挂 tabindex="-1"）。
      // 放映的当前步本来就停在打开时那张图上，游标无需恢复。
      onClose: () => rootOf()?.focus?.(),
    })
    linkbox = linkbox ?? mountLinkbox(document, {
      onOpenExternal: url => opts.onOpenExternal?.(url),
      onClose: () => rootOf()?.focus?.(),
    })
    const count = sectionsOf(document).length
    return { pages: count, index: 1, total: count, steps: 0, diagrams: diagram.rendered, player: null, diags }
  }
  const created = createDeckPlayer(rootOf(), {
    slideWidth: opts.slideWidth,
    slideHeight: opts.slideHeight,
    mode: opts.mode ?? "page",
    browse: opts.browse,
    stepLines: opts.stepLines,
    onChange: opts.onChange,
    startIndex: opts.startIndex ?? 1,
  })
  player = created
  lightbox = lightbox ?? mountLightbox(document, {
    maxScale: 12,
    onClose: () => rootOf()?.focus?.(),
  })
  linkbox = linkbox ?? mountLinkbox(document, {
    onOpenExternal: url => opts.onOpenExternal?.(url),
    onClose: () => rootOf()?.focus?.(),
  })
  return {
    pages: sectionsOf(document).length,
    index: created.index,
    total: created.total,
    steps: created.steps,
    diagrams: diagram.rendered,
    diags,
    // 承接面（P4-a）：run() resolve 就是"deck 就绪"——分页收敛、补染、播放器全就位，
    // 装饰器（挂 data-md2s-activatable 的 ▶）从此刻起可以动手，不需要另立事件。
    player: created,
  }
}

/**
 * 文件图片预取成 dataURL：IR 的 media 落盘钩子只收 data URL，而文档里的图片是
 * http URL（父侧按本地路径改写来的）。同源 fetch，栅格与落盘都走这条。
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

/**
 * 抽 IR 并过闸门（导出可编辑 PPTX 用；图片型导出不需要）。
 *
 * media 是"只攒不落盘"的收集器：浏览器里落不了盘，data URL 交给父侧写临时目录，
 * sidecar 只认 IR 里的文件名。少这一环，image 块的 src 是 null，闸门当场报。
 *
 * @returns {Promise<{ir: object, issues: string[], stats: object, media: Array<{name:string,dataUrl:string}>}>}
 */
const ir = async (opts = {}) => {
  await inlineImages()
  const items = []
  let n = 0
  // 扩展名跟 mime 走，别把 GIF 咬死成 .png（matplotlib 动画块现在是 GIF 位图）。
  // 与 export/pptx/media.js 的 EXT_OF 同口径，那边管独立宿主落盘，这里管浏览器侧收集。
  const EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
  }
  const media = {
    add: (dataUrl, kind) => {
      n += 1
      const mime = /^data:([^;,]+)[;,]/.exec(String(dataUrl ?? ""))?.[1]?.toLowerCase()
      const name = `${kind ?? "fig"}-${n}${(mime && EXT_BY_MIME[mime]) || ".png"}`
      items.push({ name, dataUrl })
      return name
    },
    warnings: [],
  }
  // 播放器把非当前页设成 display:none：IR 量几何会全 0。导出前强制全可见，完事还原。
  const restore = showAllSlides()
  // exec 桥注入的运行按钮（▶，data-md2s-activatable）是 UI 不是内容；两栏活格的
  // 结果格（data-md2s-short-cell，kit/shortCode）同样——运行期注入的执行结果
  // 不是讲义内容，导出右栏留白（2026-11-26 定稿）。两者共用 skipSelector：
  // 顶层代码块里它们是 <code> 的兄弟/子元素，codeLines 读不到兄弟、子元素靠
  // ir.js 的 stop 跳过；列表项里的代码块会经 listItems 的 runsOf 摊平——两边都要剔。
  const EXEC_UI = "[data-md2s-activatable],[data-md2s-short-cell]"
  let result, issues, stats
  try {
    result = await extractIr(document, {
      slideWidth: opts.slideWidth,
      slideHeight: opts.slideHeight,
      theme: opts.theme,
      meta: opts.meta ?? null,
      media,
      // 公式 / 活组件的兜底栅格。html-to-image 由页面提供（Typora 经 srcdoc 内联，
      // marktext 形态经 bundle 模块后挂到 window，见 deck-full-entry）。
      rasterize: el => window.htmlToImage?.toPng(el),
      skipSelector: EXEC_UI,
    })
    ;({ issues, stats } = checkIr(document, result, { skipSelector: EXEC_UI }))
  } finally {
    restore()
  }
  return { ir: result, issues, stats, media: items }
}

/**
 * 逐页栅格成 PNG data URL（图片型导出用）。
 *
 * 播放器把非当前页 `display:none` 且整页套了 `transform: scale()`，直接某页栅格会漏页 /
 * 尺寸缩水。这里临时强制所有页可见、铺满画布、取消单页 transform，再交给页面里的
 * html-to-image 逐页出图；完事撤掉临时样式，放映态原样还原。
 *
 * @param {object} [opts]
 * @param {number} [opts.slideWidth]  画布设计宽（像素）
 * @param {number} [opts.slideHeight] 画布设计高（像素）
 * @returns {Promise<string[]>} 每页一张 PNG 的 data URL（顺序 = 页序）
 */
const exportImages = async (opts = {}) => {
  const W = opts.slideWidth || 1920
  const H = opts.slideHeight || 1080
  const sections = [...document.querySelectorAll("section[data-slide]")]
  const style = document.createElement("style")
  style.setAttribute("data-md2s-export", "")
  style.textContent =
    ".md2s-stage>section[data-slide]{display:flex!important;" +
    `width:${W}px!important;height:${H}px!important;` +
    "position:absolute!important;left:0!important;top:0!important;" +
    "transform:none!important;overflow:hidden!important;}" +
    // 图片型栅格时隐藏 exec 桥注入的运行按钮（▶，data-md2s-activatable）与两栏活格的
    // 结果格（data-md2s-short-cell）——前者不该出片，后者按 2026-11-26 定稿「导出
    // 右栏留白」。格子 display:none 后 grid 行自动收缩回代码行自身，右列留空。
    "[data-md2s-activatable],[data-md2s-short-cell]{display:none!important;}"
  document.head.appendChild(style)
  // 契约 v1 §4.1：逐页栅格也取静态终态，冻结宿主触发的动画。
  player?.freezeAnims?.()
  const urls = []
  try {
    for (const sec of sections) {
      const url = await window.htmlToImage.toPng(sec, {
        width: W,
        height: H,
        pixelRatio: 1,
        cacheBust: true,
        style: { transform: "none", transformOrigin: "0 0" },
      })
      urls.push(url)
    }
  } finally {
    style.remove()
    player?.unfreezeAnims?.()
  }
  return urls
}

/** 宿主探针/调试用：当前播放器实例（run 之前为 null）。 */
const getPlayer = () => player

module.exports = { run, ir, exportImages, getPlayer }
