"use strict"

/**
 * kit/shortCode.js — ` ```python short ` 两栏活格代码块（2026-11-27 v2 定稿）。
 *
 * 是什么：front-matter `stepLines: true` 时，围栏标记 `python short` 的代码块在
 * deck 里收窄为左列（~55%），右侧留白区留给放映期执行结果。
 *
 * 布局模型 v2（推翻 v1 的「行↔格 grid + 每行占位预算」——用户裁决 2026-11-27：
 * 「不能吃满整页，留白少不美观；无输出行（import 等）不配在右侧占空间；有输出
 * 的利用无输出的空间」）：
 *   - 构建期：pre 收窄 + 行包装 + run-line 标记，**不注入任何格子**（无输出行
 *     零占用的唯一实现法）；分页照常量测（收窄只改宽度，版面冻结不受运行期影响）。
 *   - 放映期：宿主 exec 桥把结果卡片（.md2s-short-res）注入页内**绝对定位浮层**
 *     （.md2s-short-zone，盖在右侧留白上）——卡片按内容自适配高度、自上而下
 *     堆叠，浮动层不改文档流 → 页几何恒定，分页/IR/步进的版面冻结铁律天然保持。
 *
 * 时机（与染色/分页的时序铁律）：**染色之后、分页复测之前**——highlightCode 用
 * `code.innerHTML = …` 整段覆盖，早一步行包装全毁。生产接线在
 * host/browser/deck-core.js；e2e 的 settleDeck 镜像同序。
 *
 * 导出安全：结果卡片是放映期 UI——带 `data-md2s-short-cell` 属性进 deck-core.ir
 * 的 skipSelector（文本两侧同剔）、exportImages 隐藏；构建期 DOM 里零卡片，
 * 空文档导出天然干净。
 *
 * 步进契约：每行 span 挂 `data-md2s-run-line`（与 kit/steps.js 的 codeline 步
 * 同一属性）——player 的 activate() 命中行即派发 click，宿主 exec 桥接手执行该行。
 */

const { wrapCodeLines, langOf } = require("./codeLines")
const { sectionsOf } = require("../core/section")
const { trimTrailingBlankLines } = require("../core/paginate/layout-core")

/** 围栏标记属性（core/parse/markdown.js 写入）。 */
const SHORT_MARK = "data-md2s-short"
/** 结果卡片的豁免属性：deck-core.ir 的 skipSelector、exportImages 隐藏、exec 桥定位共用。 */
const CELL_ATTR = "data-md2s-short-cell"
const ZONE_CLASS = "md2s-short-zone"
const RES_CLASS = "md2s-short-res"
const RES_OUT_CLASS = "md2s-short-out"
const SHORT_CLASS = "md2s-short"
/** 认的语言标记首词；与 core/parse/markdown.js 的 SHORT_FENCE_LANGS 同口径。 */
const SHORT_LANGS = new Set(["python", "py"])
/** 行数帽：超过自动回退普通代码块（浮层堆不下那么多结果，两栏只收短 demo）。 */
const SHORT_LIMIT = 12

/** short 标记的块（是否改造过看类名）。导出/护栏共用判据。 */
const isShortPre = el =>
  !!el && el.tagName === "PRE" && el.classList?.contains(SHORT_CLASS)

/**
 * 把一个标记块改造成两栏形态（v2：收窄 + 行标记，不造格子）。返回是否真动了刀
 * （false = 幂等命中或不符合条件）。
 */
const transformOne = (pre, opts) => {
  if (pre.classList.contains(SHORT_CLASS)) return false // 已改造（幂等）
  const code = pre.querySelector("code")
  if (!code) return false
  if (!SHORT_LANGS.has(String(langOf(code) ?? ""))) return false
  const lines = trimTrailingBlankLines(String(code.textContent ?? "").split("\n"))
  if (lines.length > SHORT_LIMIT) {
    const message = `short 代码块 ${lines.length} 行超过行数帽 ${SHORT_LIMIT}，已回退普通代码块（两栏活格只收短 demo）`
    if (Array.isArray(opts.diags)) opts.diags.push({ level: "warning", message })
    console.warn(`[md2slides] ${message}`)
    return false
  }
  if (!lines.length) return false

  // 行包装（codeLines.js）惰性幂等：行间补 \n 文本节点，textContent 逐字不变。
  const lineEls = wrapCodeLines(code)
  if (!lineEls.length) return false
  for (const line of lineEls) line.setAttribute("data-md2s-run-line", "")
  pre.classList.add(SHORT_CLASS)
  return true
}

/**
 * 全 deck 扫一遍改造 short 标记块。
 *
 * @param {Document} doc
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]  front-matter `stepLines: true` 才开（与围栏修饰词
 *   `short` 双条件，缺一不两栏）。deck-full 传 meta.stepLines；e2e 同。
 * @param {Array}   [opts.diags] 分页警告收集（超帽回退提示）
 * @returns {number} 实际改造的块数（0 = 幂等命中或没活干）
 */
const layoutShortBlocks = (doc, opts = {}) => {
  if (opts.enabled !== true || !doc?.querySelectorAll) return 0
  let count = 0
  for (const section of sectionsOf(doc)) {
    for (const pre of section.querySelectorAll(`pre[${SHORT_MARK}]`)) {
      if (transformOne(pre, opts)) count += 1
    }
  }
  return count
}

/**
 * 与 OVERFLOW_CSS 同一注入槽（deck-core 加载即注入）：左列收窄 + 结果浮层卡片。
 * 浮层几何（left/top/right/bottom）由宿主 exec 桥在装饰期按 pre 实测写入内联样式
 * ——这里只立法形态：卡片堆叠、内容自适配、聚焦淡化、busy/error/figure 注记。
 */
const SHORT_CSS = `
/* 左列收窄：右侧留白是版面的一部分（美学裁决 2026-11-27——不追求吃满整页），
   结果浮层盖在留白上，不进文档流。 */
pre.md2s-short { width: 55%; }
/* 无输出行（import/赋值）的「已执行」角标：左列行尾一枚 ✓——右侧零占用
   （「有输出的利用无输出的空间」，2026-11-27 用户裁决；由 exec 桥挂类）。 */
pre.md2s-short .code-line { position: relative; }
pre.md2s-short .code-line.md2s-line-done::after {
  content: "✓";
  position: absolute;
  right: 0.6em;
  opacity: 0.4;
}
/* 结果浮层：几何（left/top/width/height）由 exec 桥按页实测写入内联样式。
   overflow hidden = 结果总量超留白区时按卡片压缩，绝不把页撑变形。 */
.md2s-short-zone {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  overflow: hidden;
  pointer-events: none;
}
/* 结果卡片：按内容自适配（flex-basis auto），空间不够时等比压缩（min-height:0
   + 内容帽由桥按份写入）。左侧色条 = 与左列行的视觉系连；行号章 = 卡片头顶的
   「行 N」小标（v2 不再逐行对齐，靠它认亲）。 */
.md2s-short-res {
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
  font-size: 0.72em;
  line-height: 1.35;
  padding: 0.15em 0.4em 0.15em 0.7em;
  border-left: 2px solid rgba(127, 127, 127, 0.35);
  background: rgba(127, 127, 127, 0.06);
  border-radius: 0 0.5em 0.5em 0;
  opacity: 0.55;
  transition: opacity 0.15s ease;
  pointer-events: auto;
}
.md2s-short-res.md2s-short-cur { opacity: 1; }
.md2s-short-res > .md2s-short-out {
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  overflow: hidden;
}
/* 赋值行跑完的「已执行」章：空卡片的教学语义（赋值不产出，但确实跑过）。
   空卡片自身压缩到一行章高，不占留白。 */
.md2s-short-res.md2s-short-done > .md2s-short-out:empty::after {
  content: "✓";
  opacity: 0.45;
  font-size: 0.9em;
}
/* 执行中：卡片内的脉冲提示（结果到达即被内容替换）。 */
@keyframes md2s-short-blink { 50% { opacity: 0.25; } }
.md2s-short-res.md2s-short-busy > .md2s-short-out::after {
  content: "执行中…";
  animation: md2s-short-blink 1s ease-in-out infinite;
}
.md2s-short-res.md2s-short-error > .md2s-short-out { color: #c0392b; }
/* 表格（引擎按 DataFrame 渲染的 PNG）按卡片内容帽缩进去：帽由桥按份写入内联。 */
.md2s-short-res img {
  display: block;
  margin: 0 auto;
  max-width: 100%;
  object-fit: contain;
}
/* matplotlib 图（kind=figure）v1 不进卡片（二期）：留一枚静默注记，真图走 ▶ 面板。 */
.md2s-short-res table.md2s-short-table {
  border-collapse: collapse;
  margin: 0;
  font-size: 1em;
  background: transparent;
  /* 占满父级（2026-11-27 用户裁决）：宽随卡、高随分配的格子高度拉伸，
     行行铺满不缩角——matplotlib 版的满卡观感，原生 CSS 直接给。 */
  width: 100%;
  height: 100%;
}
.md2s-short-res table.md2s-short-table th,
.md2s-short-res table.md2s-short-table td {
  padding: 0.12em 0.6em;
  text-align: center;
}
/* renderTable 给表头写的是 ▶ 面板的深色内联样式；卡片是浅底，覆盖成浅灰。 */
.md2s-short-res table.md2s-short-table th {
  background: rgba(127, 127, 127, 0.14) !important;
  color: inherit !important;
}
/* 收敛裁切到底时底部渐隐，比硬裁半行体面（packZone 溢出时挂 -clipped 类）。 */
.md2s-short-res.md2s-short-clipped > .md2s-short-out {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 1.6em), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 1.6em), transparent);
}
.md2s-short-note {
  opacity: 0.6;
  font-size: 0.85em;
  margin-top: 0.2em;
}
.md2s-short-res .md2s-short-fig {
  display: block;
  opacity: 0.6;
  font-style: italic;
}
`

module.exports = {
  layoutShortBlocks, SHORT_CSS, SHORT_LIMIT,
  SHORT_MARK, CELL_ATTR, ZONE_CLASS, RES_CLASS, RES_OUT_CLASS, SHORT_CLASS, isShortPre,
}
