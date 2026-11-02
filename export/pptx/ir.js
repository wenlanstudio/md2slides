"use strict"
/**
 * ir.js — deck DOM → Slide IR：可编辑 PPTX 的内容契约。
 *
 * 抽取建立在三件已经完成的事之上，这里一件都不重做：
 *   · 分页/跨页（overflow.js 按浏览器实测高度切好）；
 *   · 图表已替换成位图（diagramHost.js 预通行，宿主 renderDiagram 出图）；
 *   · 代码已高亮（highlight.js 的 .hljs-* span；分页切片后由宿主重染）。
 *
 * 所以 IR 不解析 Markdown、不重新排版，只把浏览器已经定好的结果读出来：
 *   · 几何 = 实测矩形（复用 section.js 的 beginMeasure 钉画布，px 即设计 px）；
 *   · 样式 = 该元素自己的 computed style（不经过"全局 token → 再应用"这一环，
 *     内容样式因此不可能与主题分叉）；
 *   · 单位 = 英寸，画布统一归一化到 13.333"×7.5"（PPT 标准 16:9）。
 *
 * IR 只回答"有什么、在哪、什么样式"，不含任何 PPTX 概念——母版、版式、占位符都归 sidecar。
 */

const {
  sectionsOf,
  beginMeasure,
  endMeasure,
  PAGINATION_ATTR,
} = require("../../core/section")
const { rasterizeSvg } = require("../../core/render/diagram")
const { FURNITURE_CLASS } = require("../../core/paginate/furniture")

const IR_VERSION = 1

/**
 * 被整块栅格成图片的子树打这个标记。
 * 校验"文本是否丢字"时必须跳过它们：那些文字已经被画进图片里了，不是内容丢失。
 * 标记在 checkIr 结束后清除（见 check.js）。
 */
const RASTER_ATTR = "data-md2s-raster"

/**
 * 抽成 Office 公式（OMML）的子树打这个标记。
 *
 * 与栅格标记同理：公式的文字既不在 DOM 的可见文本里（MathML 是藏起来的），
 * 也不该按普通文字进 PPTX（它变成了结构化的 OMML 树）。两边都按这个标记跳过，
 * "文本逐字一致"的校验才不会把公式算成丢字。标记在 checkIr 结束后清除。
 */
const MATH_ATTR = "data-md2s-math"

/**
 * 归一化画布：PowerPoint 的 16:9 是 12192000×6858000 EMU，换算成英寸正好 13.3333…×7.5。
 * 用 EMU 反推而不是写死 13.333，是为了让 1280×720 / 1920×1080 都算出**精确**的 7.5in 高
 * （写死 13.333 会得到 7.4998，累积到几何上就是肉眼可见的偏移）。
 */
const EMU_PER_IN = 914400
const CANVAS_WIDTH_IN = 12192000 / EMU_PER_IN

/**
 * 宿主插件 UI（编辑器的「▶ 运行」按钮之类）不是文档内容，抽取与校验都要跳过。
 * 选择器由宿主经 opts.skipSelector 注入（core 默认空——core 不知道编辑器的存在）。
 */

const RE_HEADING = /^H([1-6])$/
const RE_URL = /url\((['"]?)(.*?)\1\)/

/** 能独立成块的标签；用于判断一个 div 是"容器"还是"内容" */
const BLOCKISH = "h1,h2,h3,h4,h5,h6,p,ul,ol,pre,table,img,blockquote,figcaption,div,section"

const round = (n, digits = 2) => {
  const f = 10 ** digits
  return Math.round((Number(n) || 0) * f) / f
}

const collapse = text => (text ?? "").replace(/\s+/g, " ")

/**
 * 标签名统一大写：HTML 元素的 `tagName` 本就是大写，但 **SVG 元素的是小写**（"svg"、"g"），
 * 不统一就会把内联图表漏判成未识别元素。
 */
const tagOf = el => (el?.tagName ?? "").toUpperCase()

/**
 * class 名统一字符串：SVG 元素的 `className` 是 `SVGAnimatedString` 对象而不是字符串，
 * 直接 `.includes` 会炸、直接输出会变成 `{}`。
 */
const classOf = el => {
  const attr = el?.getAttribute?.("class")
  if (typeof attr === "string") return attr
  const direct = el?.className
  return typeof direct === "string" ? direct : ""
}

/** computed color（rgb/rgba）→ #rrggbb */
function toHex(value) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(value ?? "")
  if (!m) return null
  return `#${[1, 2, 3]
    .map(i => Math.max(0, Math.min(255, Math.round(Number(m[i])))).toString(16).padStart(2, "0"))
    .join("")}`
}

/** `"Cascadia Mono", "JetBrains Mono", monospace` → `Cascadia Mono` */
function firstFont(family) {
  const first = (family ?? "").split(",")[0]?.trim().replace(/^['"]|['"]$/g, "")
  return first || null
}

/** 块级样式：sidecar 用它直接写 run，不再回头问主题 */
function styleOf(el, inPerPx) {
  const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el)
  if (!cs) return {}
  const fontSizePx = parseFloat(cs.fontSize) || 16
  const lineHeightPx = parseFloat(cs.lineHeight)
  const weight = Number(cs.fontWeight) || 400
  const space = px => round((parseFloat(px) || 0) * inPerPx, 4)
  return {
    fontSizePt: round(fontSizePx * inPerPx * 72, 2),
    font: firstFont(cs.fontFamily),
    color: toHex(cs.color),
    bold: cs.fontWeight === "bold" || weight >= 600 || undefined,
    italic: cs.fontStyle === "italic" || undefined,
    align: ["left", "center", "right", "justify"].includes(cs.textAlign) ? cs.textAlign : undefined,
    // 行距记**绝对磅值**，不记 CSS 的倍数：PowerPoint 的 spcPct 是"字体自然行高的倍数"，
    // CSS 的 line-height 是"字号的倍数"，两者不能直接互换（雅黑自然行高 ≈1.32em，
    // 把 1.55 原样写进 spcPct，PPT 行高就比浏览器高出一截，多行块集体冲出量好的框，
    // 见下一块——2026-10-24 微软 Office 里列表压住下一段，一半原因在这）。
    // sidecar 照它写 spcPts（精确行距），PPT 与浏览器的行高逐磅一致。
    lineSpacingPt: Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? round(lineHeightPx * inPerPx * 72, 2) : undefined,
    spaceBeforeIn: space(cs.marginTop),
    spaceAfterIn: space(cs.marginBottom),
    // 内边距也量：geo.w/h 含 padding，PPTX 文本框默认还有自己的 inset（左右各 0.1"），
    // 不映射的话文字起始位置和可用宽度都会与浏览器漂移（sidecar 拿它设 frame inset）。
    paddingLeftIn: space(cs.paddingLeft),
    paddingRightIn: space(cs.paddingRight),
    paddingTopIn: space(cs.paddingTop),
    paddingBottomIn: space(cs.paddingBottom),
  }
}

/** run 级样式：只记录**与所属块不同**的字段，IR 才不至于被重复样式淹没 */
function runStyleOf(el, base) {
  const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el)
  if (!cs) return {}
  const style = {}
  const color = toHex(cs.color)
  if (color && color !== base.color) style.color = color
  const weight = Number(cs.fontWeight) || 400
  const bold = cs.fontWeight === "bold" || weight >= 600
  if (bold !== !!base.bold) style.bold = bold
  const italic = cs.fontStyle === "italic"
  if (italic !== !!base.italic) style.italic = italic
  const font = firstFont(cs.fontFamily)
  if (font && font !== base.font) style.font = font
  return style
}

const sameStyle = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

/**
 * 把一段内联内容摊平成 [{text, style?}]（BR 变成 {br:true}）。
 * 高亮 span、加粗、inline code 都在这层被读成 run —— 语法着色因此是实测色，
 * 不是查表得来的近似色。
 */
/**
 * KaTeX 的公式 → { latex, mathml, display }；不是公式（或没留 MathML）返回 null。
 *
 * KaTeX 渲染时会把 LaTeX 源码留在 `<annotation encoding="application/x-tex">` 里
 * （藏在 `.katex-mathml` 中，屏幕上看不见但 DOM 里有）。这两样正是 Office 公式的输入：
 * MathML 在 sidecar 里走 MathML→OMML 变成 PowerPoint 的原生公式（可双击编辑），
 * LaTeX 留作转不动时的兜底文本——都比把公式栅格成图片强（图既不可编辑，也常常裁不全）。
 *
 * 反过来说，`runsOf` 绝不能把 `.katex` 摊平成文字：摊平会把 MathML 的字符、
 * annotation 里的源码、katex-html 的排版字符**三份一起**念出来，
 * PPT 里就成了 "VtV_tVt" 这种谁也读不懂的串（2026-10-30 修的行内公式 bug）。
 */
function mathInfoOf(el) {
  const math = el?.querySelector?.("math") ?? (tagOf(el) === "MATH" ? el : null)
  if (!math?.outerHTML) return null
  const annotation = math.querySelector?.('annotation[encoding="application/x-tex"]')
  return {
    latex: (annotation?.textContent ?? "").trim(),
    mathml: math.outerHTML,
    display: math.getAttribute?.("display") === "block" || classOf(el).includes("katex-display"),
  }
}

function runsOf(el, base, { keepWhitespace = false, stop = null } = {}) {
  const runs = []
  const push = (text, style) => {
    const raw = keepWhitespace ? text ?? "" : collapse(text)
    if (!raw) return
    const last = runs[runs.length - 1]
    // 公式 run 不许被后面的文字并进去：它没有 text 字段，并进去就成了 "undefined…"
    if (last && !last.br && !last.math && sameStyle(last.style, style)) {
      last.text += raw
      return
    }
    runs.push(style && Object.keys(style).length ? { text: raw, style } : { text: raw })
  }
  const walk = (node, style) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        push(child.nodeValue, style)
        continue
      }
      if (child.nodeType !== 1) continue
      // stop：整棵子树不要（列表项用它把嵌套列表排除在外，见 listItems）
      if (stop?.(child)) continue
      if (child.tagName === "BR") {
        runs.push({ br: true })
        continue
      }
      // 行内公式：整棵子树换成一条 math run（注释见 mathInfoOf）
      if (classOf(child).includes("katex")) {
        const info = mathInfoOf(child)
        if (info) {
          child.setAttribute(MATH_ATTR, "1")
          runs.push({ math: info })
          continue
        }
      }
      walk(child, runStyleOf(child, base))
    }
  }
  walk(el, undefined)
  return runs
}

/** li 下面挂着的子列表（markdown 缩进写法：子 ul/ol 是父 li 的子元素） */
const nestedListsOf = li => [...li.children].filter(c => c.tagName === "UL" || c.tagName === "OL")
const isNestedList = el => el.tagName === "UL" || el.tagName === "OL"

/** 代码块：run 里的换行重新切成行，行内保留前导空格 */
function codeLines(code, base) {
  const lines = [[]]
  for (const run of runsOf(code, base, { keepWhitespace: true })) {
    if (run.br) {
      lines.push([])
      continue
    }
    const parts = run.text.split("\n")
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines[lines.length - 1].push(run.style ? { text: part, style: run.style } : { text: part })
    })
  }
  return lines.filter((line, i) => line.length || i === 0)
}

/** 列表项（含嵌套），按文档顺序 */
function listItems(list, base, ctx) {
  const items = []
  // 缩进基准恒为最外层列表的左边：sidecar 的 marL 相对它算（= 文本框左沿 + lIns）
  const listLeft = list.getBoundingClientRect().left
  // 列表项 runs 摊平整棵 li：除嵌套列表外，宿主 UI（exec 的 ▶/⏩，data-md2s-activatable）
  // 也要排除——否则它混进 item.runs，而 DOM 侧校验按 skipSelector 已剔除，两边文本分叉。
  const stopUI = el => isNestedList(el) || (!!ctx.skipSelector && el.matches?.(ctx.skipSelector))
  const walk = (node, level) => {
    // 每层列表各取自己的框：嵌套 ul 里第一条的"上一条"是本层的内容顶边，
    // 若退回最外层，父条目的整行高度会被当成间距（嵌套列表总高凭空多一行）。
    const rect = node.getBoundingClientRect()
    const cs = node.ownerDocument?.defaultView?.getComputedStyle?.(node)
    const padTop = (parseFloat(cs?.paddingTop) || 0) / ctx.scale
    let prevBottom = null // 同 ul 内上一条的底边（缩放后 px）；null = 本 ul 的第一条
    for (const child of node.children) {
      if (child.tagName === "LI") {
        const li = child.getBoundingClientRect()
        // 只取 li 自己的内联内容：markdown 的缩进子列表是 li 的子元素，
        // 摊平时不排除的话父条目会把整段子项文字再念一遍（末条 "- a\n  - b"
        // 在 PPT 里就成了 "a b" 加一条 "b"）。子项由下面的 walk 单独成条目。
        const item = { level, runs: runsOf(child, base, { stop: stopUI }), style: styleOf(child, ctx.inPerPx) }
        const lines = visualLinesOf(child, { stopBeforeNestedList: true })
        if (lines) item.lines = lines
        const indentPx = firstTextLeft(child, listLeft)
        if (indentPx != null) item.indentIn = round((indentPx / ctx.scale) * ctx.inPerPx, 4)
        // 与上一条（或本 ul 内容顶边）的**实测**间距：浏览器怎么排的就怎么记——
        // margin 折叠（6.3+6.3→6.3）、首条 margin 是否逃出 ul 边框盒（flex 子项里
        // 不逃、嵌套容器里逃），两种场合结论相反，建模 CSS 折叠规则迟早算错。
        // sidecar 照写 spcBef，条目间距与总高因此和浏览器逐磅一致。
        const from = prevBottom == null ? rect.top + padTop : prevBottom
        const gap = Math.max(0, (li.top - from) / ctx.scale)
        item.gapBeforeIn = round(gap * ctx.inPerPx, 4)
        const liSrc = srcOf(child)
        if (liSrc) item.srcRange = liSrc   // 条目级行号：增量重排按条目脏标记时用
        prevBottom = li.bottom
        items.push(item)
        // 嵌套列表挂在 li 下面，层级别由递归深度给出
        for (const sub of child.children) {
          if (sub.tagName === "UL" || sub.tagName === "OL") walk(sub, level + 1)
        }
        continue
      }
      if (child.tagName === "UL" || child.tagName === "OL") walk(child, level)
    }
  }
  walk(list, 0)
  return items
}

/** 末条之后的实测间距（末 li 的 margin-bottom 在不在 ul 边框盒里，两种场合都有） */
function gapAfterOf(list, ctx) {
  const direct = [...list.children].filter(c => c.tagName === "LI")
  const last = direct[direct.length - 1]
  if (!last) return null
  const rect = list.getBoundingClientRect()
  const cs = list.ownerDocument?.defaultView?.getComputedStyle?.(list)
  const padBottom = (parseFloat(cs?.paddingBottom) || 0) / ctx.scale
  const gap = Math.max(0, (rect.bottom - padBottom - last.getBoundingClientRect().bottom) / ctx.scale)
  return round(gap * ctx.inPerPx, 4)
}

/** 表格：列宽取首行实测宽，行高逐行实测——都是浏览器已经排好的结果 */
function tableOf(table, base, ctx) {
  const rows = []
  const headRow = table.querySelector("thead tr")
  if (headRow) rows.push(rowOf(headRow, base, ctx, true))
  const body = table.querySelector("tbody") ?? table
  for (const tr of body.querySelectorAll("tr")) rows.push(rowOf(tr, base, ctx, false))
  const first = rows[0]
  return {
    type: "table",
    colWidths: (first?.cells ?? []).map(c => round(c.w ?? 0, 4)),
    rows: rows.map(r => ({
      header: r.header || undefined,
      heightIn: round(r.h ?? 0, 4),
      cells: r.cells.map(c => ({ runs: c.runs, style: c.style, w: round(c.w ?? 0, 4) })),
    })),
  }
}

function rowOf(tr, base, ctx, header) {
  const r = tr.getBoundingClientRect()
  const cells = [...tr.children].map(cell => {
    const rect = cell.getBoundingClientRect()
    return {
      runs: runsOf(cell, base),
      style: styleOf(cell, ctx.inPerPx),
      w: rect.width / ctx.scale * ctx.inPerPx,
      header: tagOf(cell) === "TH" ? true : undefined,
    }
  })
  return { cells, header, h: r.height / ctx.scale * ctx.inPerPx }
}

// ==================== 块抽取 ====================

function geoOf(el, ctx) {
  const r = el.getBoundingClientRect()
  const toIn = px => round(px / ctx.scale * ctx.inPerPx, 4)
  return {
    x: toIn(r.left - ctx.originX),
    y: toIn(r.top - ctx.originY),
    w: toIn(r.width),
    h: toIn(r.height),
  }
}

const isVisible = el => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/**
 * 源码行号（markdown.js 写进 data-src-*，1 基含端点）；没有就 undefined。
 * 消费方：宿主的「点击幻灯片跳源码行」与增量重排；封面/家具等引擎生成的块没有。
 * 插件/引擎包的容器（如脚注 ol）自己不带行号，回退到首个带行号的后代。
 */
function srcOf(el) {
  const start = Number(el.getAttribute?.("data-src-start"))
  if (Number.isInteger(start) && start > 0) {
    const end = Number(el.getAttribute("data-src-end"))
    return [start, Number.isInteger(end) && end >= start ? end : start]
  }
  const inner = el.querySelector?.("[data-src-start]")
  return inner ? srcOf(inner) : undefined
}

/**
 * 这段文字的视觉行数：Range 的客户端矩形按**垂直重叠**聚簇，一簇一行。
 *
 * 两个坑都不能踩：
 *   · 不能数矩形个数——一行里混了粗体 / 行内代码 / <mark> 关键字高亮就有多个矩形；
 *   · 不能按 top 精确分簇——同一行的内联盒字号不同（正文 42px、行内代码 34px），
 *     基线对齐但 top 差几 px，精确分簇会把一行数成三四行（自检因此满屏误报）。
 * 判据是重叠：矩形的纵向跨度有交集即同一行；一行之内任何内联盒都落在行盒里，
 * 行与行之间隔着一整个行盒，不会互相重叠。
 *
 * sidecar 拿行数做两件事：
 *   · ===1 时关 word_wrap：PowerPoint 的字体度量与浏览器有微小差异（同名字体在
 *     不同宿主里的 hinting、行高微差都算），一行文字一旦被它重排成两行，家具和封面
 *     当场破版——页码 "11 / 31" 折成 "11 /" + "31"、页眉书名掉字，都是这么来的。
 *     折行是明显破版，溢出几个像素无感，所以单行文本一律不许 PPT 折。
 *   · 写进 IR 的 `lines`：sidecar 出片时拿"行数 × 行距 + 段距"对照量好的框高，
 *     浏览器里放不下的事先在构建期炸出来，不等用户在 Office 里看见重叠。
 */
const visualLinesOf = (el, { stopBeforeNestedList = false } = {}) => {
  const doc = el.ownerDocument
  if (!doc?.createRange) return null
  const range = doc.createRange()
  // 列表项只量自己那几行：子列表是独立的条目，量进父项会重复计一次
  const nested = stopBeforeNestedList ? nestedListsOf(el)[0] : null
  if (nested) {
    range.setStart(el, 0)
    range.setEndBefore(nested)
  } else {
    range.selectNodeContents(el)
  }
  const rects = [...range.getClientRects()].filter(r => r.height > 0 && r.width > 0)
  if (!rects.length) return null
  rects.sort((a, b) => a.top - b.top || a.left - b.left)
  let lines = 1
  let bottom = rects[0].bottom
  for (const r of rects.slice(1)) {
    if (r.top < bottom) {
      // 与当前行有纵向交集：同一行，行盒可能因此长高（行内图/大字号）
      bottom = Math.max(bottom, r.bottom)
    } else {
      lines += 1
      bottom = r.bottom
    }
  }
  return lines
}

/** li 首个内联盒子的左沿（相对 ul 左边，px）；空 li 返回 null */
function firstTextLeft(li, listLeft) {
  const doc = li.ownerDocument
  if (!doc?.createRange) return null
  const range = doc.createRange()
  range.selectNodeContents(li)
  const first = range.getClientRects()[0]
  return first ? first.left - listLeft : null
}

/** 容器（分栏/封面/引用…）不自身成块，它的子块带着容器标记继续往下走 */
function hasBlockChildren(el) {
  return [...el.children].some(child => child.matches?.(BLOCKISH))
}

/**
 * 一个元素 → 0..n 个块。
 * @param {object} ctx { originX, originY, scale, inPerPx, media, baseDir, skipSelector }
 * @param {object} container { name, index } 所在容器（分栏列序等）
 */
/**
 * 给"浏览器栅格不了的元素"兜底：调用方提供的栅格钩子（见 opts.rasterize）。
 * 成功就变成图片块（并打上栅格标记，文字随图片走），失败返回 null 由调用方退回 custom。
 */
async function tryRasterize(el, ctx) {
  if (typeof ctx.rasterize !== "function") return null
  try {
    const dataUrl = await ctx.rasterize(el)
    if (dataUrl) return imageBlock(el, ctx, dataUrl, { rasterize: true })
  } catch (error) {
    console.warn("[md2slides] rasterize failed", error?.message ?? error)
  }
  return null
}

async function blocksOf(el, ctx, container) {
  const tag = tagOf(el)
  const cls = classOf(el)
  const mark = (block, target = el) => {
    if (container?.name) block.container = container.name
    if (container?.index != null) block.col = container.index
    // 源码行号：块自己带的优先（imageBlock 已从 img 上读过），否则从目标元素补
    // （`<p><img></p>` 的行号在外层 p 上）
    if (!block.srcRange) {
      const range = srcOf(target)
      if (range) block.srcRange = range
    }
    // 视觉行数（家具槽位/封面行/短标题常是 1 行）：见 visualLinesOf 注释
    if (block.type === "heading" || block.type === "paragraph") {
      const lines = visualLinesOf(target)
      if (lines) {
        block.lines = lines
        if (lines === 1) block.singleLine = true
      }
    }
    return block
  }

  // 图片：markdown 的图片常是 `<p><img></p>`，量的是 img 自己
  if (tag === "IMG") return [mark(imageBlock(el, ctx))]

  // KaTeX：抽成 math 块，sidecar 把它变成 PowerPoint 的原生 OMML 公式（可双击编辑）。
  // 抽不出 MathML（KaTeX 配成只输出 html 时）才退回栅格——图不可编辑，但总比丢掉强。
  if (cls.includes("katex-display") || cls.includes("katex")) {
    const info = mathInfoOf(el)
    if (info) {
      el.setAttribute(MATH_ATTR, "1")
      return [mark({
        type: "math",
        display: info.display,
        latex: info.latex,
        mathml: info.mathml,
        geo: geoOf(el, ctx),
        style: styleOf(el, ctx.inPerPx),
      })]
    }
    const raster = await tryRasterize(el, ctx)
    if (raster) return [mark(raster)]
  }

  // 内联 SVG：栅格化失败的图表会原样留在 deck 里（见 diagram.js 的 fallback）
  if (tag === "SVG") {
    let src = null
    try {
      src = await rasterizeSvg(el, ctx.diagramScale ?? 2)
    } catch (error) {
      console.warn("[md2slides] svg rasterize failed", error?.message ?? error)
    }
    if (src) return [mark(imageBlock(el, ctx, src, { rasterize: true }))]
    // 常规路子失败（含 foreignObject 的 mermaid 时序图就是这样）：交给整页栅格 + 裁切兜底
    const raster = await tryRasterize(el, ctx)
    if (raster) return [mark(raster)]
    // 含 foreignObject 的 SVG 浏览器也不给画（mermaid 时序图就是这样）：登记待栅格，文本留住
    return [mark({ type: "custom", raster: "svg", geo: geoOf(el, ctx), html: el.outerHTML, text: collapse(el.textContent).trim() })]
  }

  const heading = RE_HEADING.exec(tag)
  if (heading) {
    const style = styleOf(el, ctx.inPerPx)
    return [mark({ type: "heading", level: Number(heading[1]), geo: geoOf(el, ctx), style, runs: runsOf(el, style) })]
  }

  if (tag === "PRE") {
    const code = el.querySelector("code") ?? el
    return [mark({ type: "code", geo: geoOf(el, ctx), style: styleOf(code, ctx.inPerPx), lines: codeLines(code, styleOf(code, ctx.inPerPx)) })]
  }

  if (tag === "TABLE") {
    return [mark({ ...tableOf(el, styleOf(el, ctx.inPerPx), ctx), geo: geoOf(el, ctx), style: styleOf(el, ctx.inPerPx) })]
  }

  if (tag === "UL" || tag === "OL") {
    const style = styleOf(el, ctx.inPerPx)
    const items = listItems(el, style, ctx)
    const block = { type: "list", ordered: tag === "OL", geo: geoOf(el, ctx), style, items }
    const total = items.reduce((sum, item) => sum + (item.lines ?? 1), 0)
    if (total) block.lines = total
    const gapAfter = gapAfterOf(el, ctx)
    if (gapAfter != null) block.gapAfterIn = gapAfter
    return [mark(block)]
  }

  // 家具（页眉/页脚，furniture.js 注入）：每个槽位抽成**独立块**。
  // 整块抽成一段的话，左右两个槽的文字会在 PPTX 的同一个文本框里连成一行——
  // 分栏就位不了。槽位各自带 geo，sidecar 自然会摆到对应的角上。
  if ((tag === "HEADER" || tag === "FOOTER") && cls.includes(FURNITURE_CLASS)) {
    const out = []
    for (const slot of el.children) {
      if (!isVisible(slot)) continue
      const style = styleOf(slot, ctx.inPerPx)
      out.push(mark({
        type: "paragraph",
        role: tag === "HEADER" ? "header" : "footer",
        geo: geoOf(slot, ctx),
        style,
        runs: runsOf(slot, style),
      }, slot))
    }
    return out
  }

  if (tag === "P" || tag === "FIGCAPTION" || tag === "HEADER" || tag === "FOOTER") {
    // `<p><img></p>`：块里只有一张图，按图片处理，几何也取图片的
    const imgs = [...el.querySelectorAll("img")].filter(isVisible)
    if (imgs.length === 1 && !collapse(el.textContent).trim()) return [mark(imageBlock(imgs[0], ctx))]
    const style = styleOf(el, ctx.inPerPx)
    const block = { type: "paragraph", geo: geoOf(el, ctx), style, runs: runsOf(el, style) }
    if (tag === "HEADER") block.role = "header"
    if (tag === "FOOTER") block.role = "footer"
    return [mark(block)]
  }

  if (tag === "BLOCKQUOTE") {
    return await collect(el, ctx, { name: "quote" })
  }

  if (tag === "DIV" || tag === "SECTION" || tag === "FIGURE") {
    if (cls.includes("cols")) {
      const out = []
      const cols = [...el.children]
      for (let index = 0; index < cols.length; index++) {
        out.push(...await collect(cols[index], ctx, { name: "cols", index }))
      }
      return out
    }
    if (cls.includes("cover")) return await collect(el, ctx, { name: "cover" })
    if (hasBlockChildren(el)) return await collect(el, ctx, { name: "group" })
    if (collapse(el.textContent).trim()) {
      const style = styleOf(el, ctx.inPerPx)
      return [mark({ type: "paragraph", geo: geoOf(el, ctx), style, runs: runsOf(el, style) })]
    }
    return []
  }

  // 走到这里说明是没认出来的元素：登记而不是丢掉，"内容准确性"才能被机器校验
  return [mark({ type: "unknown", geo: geoOf(el, ctx), tag, cls: cls || undefined, text: collapse(el.textContent).trim() })]
}

function imageBlock(el, ctx, src, { rasterize = false } = {}) {
  const file = ctx.media?.add(src ?? el.getAttribute("src") ?? el.src, "fig") ?? null
  // 整块被画成图片的子树，其文字随图片走，校验时不再按"文本"要求它
  if (file && rasterize) el.setAttribute?.(RASTER_ATTR, "1")
  const block = { type: "image", geo: geoOf(el, ctx), src: file }
  const range = srcOf(el)
  if (range) block.srcRange = range
  return block
}

async function collect(parent, ctx, container) {
  const out = []
  for (const child of parent.children) {
    if (child.nodeType !== 1) continue
    if (ctx.skipSelector && child.matches?.(ctx.skipSelector)) continue
    if (!isVisible(child)) continue
    out.push(...await blocksOf(child, ctx, container))
  }
  return out
}

// ==================== 页 ====================

/** 版式提示：给 sidecar 选占位符用；几何仍以实测为准，猜错了也不会歪 */
function layoutOf(blocks) {
  if (!blocks.length) return "blank"
  const area = b => (b.geo?.w ?? 0) * (b.geo?.h ?? 0)
  const total = blocks.reduce((sum, b) => sum + area(b), 0) || 1
  const share = pred => blocks.filter(pred).reduce((sum, b) => sum + area(b), 0) / total
  const kinds = new Set(blocks.map(b => b.type))

  if (blocks.length === 1 && blocks[0].type === "heading" && blocks[0].level === 1) return "title"
  // 分栏要"占主导"才算分栏页：一页里夹一条两栏的分栏条，本质仍是正文页
  if (share(b => b.container === "cols") > 0.4) return "two-col"
  if (share(b => b.type === "table") > 0.5) return "table"
  if (share(b => b.type === "code") > 0.5) return "code"
  if (share(b => b.type === "image") > 0.5) return "figure"
  if (kinds.has("heading") && (kinds.has("paragraph") || kinds.has("list"))) return "title+body"
  return "mixed"
}

function backgroundOf(section, ctx) {
  const cs = section.ownerDocument?.defaultView?.getComputedStyle?.(section)
  if (!cs) return {}
  const bg = {}
  const color = toHex(cs.backgroundColor)
  if (color) bg.color = color
  const url = RE_URL.exec(cs.backgroundImage ?? "")
  if (url?.[2] && !url[2].startsWith("data:")) {
    // CSS 背景图在整页栅格化里必丢（README 已知限制）；模板路线把它作为底层图片带回来
    const file = ctx.media?.add(url[2], "bg")
    if (file) bg.image = file
  }
  return bg
}

async function slideOf(section, index, ctx) {
  const rect = section.getBoundingClientRect()
  const ctxHere = {
    ...ctx,
    originX: rect.left,
    originY: rect.top,
    // svg 被 pin 到设计尺寸后 scale 应恒为 1；保留换算是为了 pin 失败时仍然正确
    scale: rect.height > 0 && section.clientHeight > 0 ? rect.height / section.clientHeight : 1,
  }
  const blocks = await collect(section, ctxHere, null)
  const pagination = section.getAttribute(PAGINATION_ATTR)
  return {
    index,
    pagination: pagination ? Number(pagination) : undefined,
    layout: layoutOf(blocks),
    background: backgroundOf(section, ctxHere),
    blocks,
  }
}

/**
 * IR 的 `meta`：只收写进 PPTX 文件属性的三个键（title/author/date）。
 *
 * `book` / `header` / `footer`  deliberately 不进 IR——它们是版面/家具的输入，
 * 该走 layout 与 blocks，不走文件属性。三个键全缺时返回 null，
 * IR 里不留一个空对象。
 *
 * @param {object|null} meta compose 透出的 deckMeta
 */
const filePropsOf = meta => {
  const m = meta ?? {}
  const asText = v => (v == null || v === "" ? null : String(v))
  const out = {
    title: asText(m.title),
    subtitle: asText(m.subtitle),
    author: asText(m.author),
    date: asText(m.date),
  }
  return Object.values(out).some(v => v !== null) ? out : null
}

/**
 * @param {Document} doc deck 所在文档（iframe.contentDocument）
 * @param {object} opts {
 *   slideWidth, slideHeight, theme, cssHash, media, baseDir,
 *   diagramScale,        // 内联 SVG 的栅格倍率
 *   settle,              // 开始测量后的等待钩子：给活图表几帧时间铺开画布
 *   beforeSlide,         // 抽取每一页前的钩子：翻到该页（隐藏页上的画布是 0×0）
 *   rasterize,           // 元素 → PNG data URL 的兜底栅格钩子（整页出图后按矩形裁切）
 *   skipSelector,        // 宿主插件 UI 的选择器（如 "[data-plugin-activatable]"），命中即跳过
 *   meta,                // compose 的 deckMeta（front-matter 六键）→ IR 文件属性三键
 * }
 * @returns {Promise<object>} Slide IR
 */
async function extractIr(doc, opts = {}) {
  const pxWidth = opts.slideWidth > 0 ? opts.slideWidth : 1280
  const pxHeight = opts.slideHeight > 0 ? opts.slideHeight : 720
  // 归一化画布：px → in 只由画布宽度决定，高度跟着主题比例走
  const inPerPx = CANVAS_WIDTH_IN / pxWidth
  const ctx = {
    inPerPx,
    scale: 1,
    originX: 0,
    originY: 0,
    media: opts.media,
    baseDir: opts.baseDir,
    diagramScale: opts.diagramScale,
    rasterize: opts.rasterize,
    skipSelector: opts.skipSelector ?? "",
  }

  beginMeasure(doc, pxWidth, pxHeight)
  try {
    if (opts.settle) await opts.settle()
    const slides = []
    let index = 0
    for (const section of sectionsOf(doc)) {
      if (opts.beforeSlide) await opts.beforeSlide(index)
      slides.push(await slideOf(section, index, ctx))
      index += 1
    }
    return {
      version: IR_VERSION,
      canvas: {
        widthIn: round(CANVAS_WIDTH_IN, 4),
        heightIn: round(pxHeight * inPerPx, 4),
        pxWidth,
        pxHeight,
      },
      theme: { name: opts.theme ?? null, cssHash: opts.cssHash ?? null },
      // 文档元数据：sidecar 拿它写 PPTX 文件属性（右键 → 属性）。与内容无关，故不占 slides。
      meta: filePropsOf(opts.meta),
      slides,
    }
  } finally {
    endMeasure(doc)
  }
}

module.exports = { extractIr, IR_VERSION, CANVAS_WIDTH_IN, RASTER_ATTR, MATH_ATTR }
