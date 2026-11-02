"use strict"
// cover.js — 封面页：由 front-matter 生成，作者不手写。
//
// 规范（2026-10-24 立，见 USAGE.md §3.0）：
//   · 正文只有标题和内容，H1–H6 都是标题——正文里没有"题名"这种特殊元素；
//   · 文档题名唯一来源是 front-matter 的 `title`（同时进 PPTX 文件属性）；
//   · 声明了 title 时，引擎自动生成封面页（title / subtitle / author / date），排在全文第一页；
//   · 手写封面 div 不再被接受。
//
// 为什么封面必须引擎生成而不是作者手写：
//   1. 题名、作者、日期与文件属性同源——手写封面意味着同一份信息在两个地方各写一遍；
//   2. 封面是"零内容页"：它不该参与分页测量、不该有页眉页脚（furniture.js 对第一页
//     豁免），这些规则只有引擎知道；
//   3. 预览 / IR / PPTX 三处同源：手写 div 在 Typora 预览里好看，导出后照样得再排一遍。
//
// 生成点就在 compose（sectionize 之后、打页码之前）：封面是一个普通的
// `<section data-slide>`，之后的路（物理分页、家具、IR、sidecar）它全流程照常走——
// 没有任何一环需要为它开特例（div.cover 不是 section 的直接子元素，所以标题扫描、
// 面包屑、中心内容判据全都天然跳过它）。

/** 封面容器类名。主题靠它排版（两个 python 主题都有 .cover 规则）。 */
const COVER_CLASS = "cover"

/**
 * 手写封面 div 的诊断。与 cols.js 的诊断同形（rule / level / line / message），
 * 由 compose 收进 `coverDiags` 透出。
 */
const HAND_COVER_DIAG = {
  rule: 1,
  level: "warning",
  line: 1,
  message: "手写封面 div 不再接受：封面由 front-matter 的 title/author/date 自动生成，请删掉该 div",
}

/**
 * 剥掉打在全文最前面的手写封面 div。
 *
 * 只认"第一个 section 的第一个子元素是 div.cover"——封面按定义就在全文最前面，
 * 混在正文中间的 div.cover 是作者自己的内容，不碰。div 是所在 section 唯一内容时，
 * 连 section 一起删（空页对后面的物理分页是个陷阱）。
 *
 * @param {Element} deck sectionize 产出的 .md2slides-deck
 * @returns {object[]} 诊断数组（剥到了才有 1 条）
 */
const stripHandwrittenCover = deck => {
  const first = deck?.firstElementChild
  const div = first?.firstElementChild
  if (!div || div.tagName !== "DIV" || !div.classList.contains(COVER_CLASS)) return []
  div.remove()
  if (!first.children.length) first.remove()
  return [{ ...HAND_COVER_DIAG }]
}

/**
 * 建封面页：`<section data-slide><div class="cover"><h1>title</h1><p class="subtitle">subtitle</p><p>author</p><p>date</p></div></section>`。
 *
 * `title` 缺省（未声明 / 空串）返回 null——没有题名就没有封面，第一页就是正文第一页。
 * subtitle / author / date 缺项不上封面：文件属性缺一项比塞默认值好，封面同理。
 * 副标题排在题名正下方、作者上方——封面阅读次序就是声明次序。
 *
 * @param {Document} doc
 * @param {object|null} meta compose 透出的 deckMeta（七键）
 * @returns {Element|null}
 */
const buildCover = (doc, meta) => {
  const title = meta?.title
  if (title == null || String(title).trim() === "") return null

  const section = doc.createElement("section")
  section.setAttribute("data-slide", "")
  const cover = doc.createElement("div")
  cover.className = COVER_CLASS

  const h1 = doc.createElement("h1")
  h1.textContent = String(title)
  cover.appendChild(h1)

  // 副标题：题名下方一行，字号介于题名与作者之间（主题 .cover p.subtitle 专用样式）。
  // 没有副标题就不插这个 p——封面上不留空行。
  const subtitle = meta?.subtitle
  if (subtitle != null && String(subtitle).trim() !== "") {
    const p = doc.createElement("p")
    p.className = "subtitle"
    p.textContent = String(subtitle)
    cover.appendChild(p)
  }

  // 作者、日期各占一行（主题 .cover p 的样式就是给这两行准备的）
  for (const key of ["author", "date"]) {
    const value = meta[key]
    if (value == null || String(value).trim() === "") continue
    const p = doc.createElement("p")
    p.textContent = String(value)
    cover.appendChild(p)
  }

  section.appendChild(cover)
  return section
}

module.exports = { buildCover, stripHandwrittenCover, COVER_CLASS }
