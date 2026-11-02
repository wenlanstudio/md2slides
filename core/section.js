"use strict"
// section.js — 幻灯片容器的唯一契约。分页、IR 抽取、测量都只认这里的选择器。
//
// 每页就是一个 `<section data-slide>`，由 `core/split/sectionize.js` 产出：没有 svg、
// 没有 foreignObject，也就不必再为"svg 缩放"做换算（原来 `scaleOf()` 存在的理由）。
// 主题 CSS 本来就只写 `section { … }`，所以这一层之下主题一个字都不用改。

/** 页面容器就是 section 自己。 */
const SLIDE_SELECTOR = "section[data-slide]"

const PAGINATION_ATTR = "data-pagination"

/** Slides in document order, i.e. the order a presenter walks through. */
function sectionsOf(doc) {
  return [...doc.querySelectorAll(SLIDE_SELECTOR)]
}

/**
 * A fresh, empty slide right after `section`.
 * Only the section's own attributes are copied (theme class, directives…); its `id` is dropped
 * because it is used as an anchor and duplicates would collide.
 *
 * @returns {Element|null} the new, empty slide — callers fill it in themselves
 */
function newSlideAfter(section) {
  if (!section?.parentNode) return null
  const cont = section.cloneNode(false)
  cont.removeAttribute("id")
  section.parentNode.insertBefore(cont, section.nextSibling)
  return cont
}

/**
 * Pagination: re-stamp the page number after pages were inserted — but only when the deck
 * asked for pagination at all (the attribute is what says so).
 */
function renumber(doc) {
  const sections = sectionsOf(doc)
  if (!sections.some(s => s.hasAttribute(PAGINATION_ATTR))) return
  sections.forEach((section, i) => section.setAttribute(PAGINATION_ATTR, String(i + 1)))
}

/**
 * Reveal every slide and pin each one to its intrinsic size.
 * The deck CSS hides all slides but the active one, and a `display:none` slide reports every
 * rect as 0; pinning the box to `slideWidth × slideHeight` additionally makes any scaling
 * exactly 1, so measurements need no conversion.
 *
 * 谁要量幻灯片都得先走这两步（跨页拆分、IR 抽取），所以放在这里而不是某个调用方里。
 */
const MEASURE_STYLE_ID = "md2slides-measure-style"

function beginMeasure(doc, width, height) {
  let style = doc.getElementById(MEASURE_STYLE_ID)
  if (!style) {
    style = doc.createElement("style")
    style.id = MEASURE_STYLE_ID
    doc.head.appendChild(style)
  }
  // section 是 flex 列容器（base.css，垂直居中 `justify-content: safe center` 靠它）：
  // 强制显示时必须保持 flex，否则测量与 IR 几何是顶对齐的，和预览、PPTX 三处漂移
  // （2026-10-24：居中改了、测量没跟上，PPTX 成品还是顶对齐）。
  style.textContent = `${SLIDE_SELECTOR}{display:flex !important}`
  if (!(width > 0 && height > 0)) return
  for (const el of doc.querySelectorAll(SLIDE_SELECTOR)) {
    el.style.width = `${width}px`
    el.style.height = `${height}px`
  }
}

function endMeasure(doc) {
  doc.getElementById(MEASURE_STYLE_ID)?.remove()
  for (const el of doc.querySelectorAll(SLIDE_SELECTOR)) {
    el.style.removeProperty("width")
    el.style.removeProperty("height")
  }
}

module.exports = {
  sectionsOf,
  newSlideAfter,
  renumber,
  beginMeasure,
  endMeasure,
  SLIDE_SELECTOR,
  PAGINATION_ATTR,
}
