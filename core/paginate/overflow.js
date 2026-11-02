"use strict"
// overflow.js — measurement-driven physical pagination.
//
// Why it exists: `sectionize`（逻辑分页）只按标题边界切页，一页装不下的东西——长代码块、
// 长列表、单纯长得超标的 section——会从页底伸出去。自动缩放救不了它：按宽度缩放只会
// 压窄超宽的块，对超高无能为力。
//
// Why measurement and not an estimate: 这一步跑在真实浏览器里，每块的高度读回来就好，
// 不必猜。它工作在渲染出的 DOM 上而不是 Markdown 上：deck 建好时图表围栏已经换成
// `<img>`，回头去改源码再整管线重跑一遍，还得维护 DOM 块 ↔ 源码行的映射——都不划算。
//
// Splitting rules, in order of preference:
//   1. Move whole top-level blocks to a continuation page; nothing inside them is reflowed.
//   2. If the block that no longer fits can be split (code block by lines, list by items),
//      keep as much of it as fits on this page and carry the rest over.
//   3. `header` / `footer` are page furniture: cloned, never moved. 家具由 furniture.js
//      在收敛后统一注入，不参与任何内容测量。
//
// The pass is repeated a bounded number of times because moving blocks onto a fresh page can
// change their height (`section > *:first-child` margins in a theme, repeated headings), and
// a continuation page can overflow in turn.

/** Class of the "(continued)" marker; styled by CONT_CSS. */
const CONT_CLASS = "md2s-cont"

/** Styling for the continuation marker. Added to the deck CSS by `index.js`. */
const CONT_CSS = `
section .${CONT_CLASS} { font-size: 0.7em; font-weight: normal; opacity: 0.7; }
`

const {
  sectionsOf,
  newSlideAfter,
  renumber,
  beginMeasure,
  endMeasure,
  SLIDE_SELECTOR,
} = require("../section")
const { injectFurniture, FURNITURE_CLASS } = require("./furniture")
const {
  planToc, fillToc, isTocSlide, chunkItems,
  TOC_SLIDE_ATTR, TOC_LIST_CLASS, TOC_TITLE_CLASS,
} = require("./toc")
// 分页决策内核（纯函数，零 DOM）：切点算术、单元装配、孤行回退、策略封闭集。
// 决策层抽到 layout-core 是双端共用（deck / marktext 纸叶）的合同——本文件只留
// 量测与动刀（view-model §5 / M4.1）；策略阈值改 STRATEGY = 改两端行为。
const {
  STRATEGY,
  isHeadingTag,
  classifyCore,
  assembleUnits,
  countFittingPrefix,
  cutIndexByBottom,
  trimTrailingBlankLines,
  bisectMaxFit,
  adjustForWidow,
  selectCoreBreak,
} = require("./layout-core")

const isHeading = el => isHeadingTag(el.tagName)
const isFixed = el => el.tagName === "HEADER" || el.tagName === "FOOTER"

/**
 * 顶层第一个**内容**子块：跳过页眉页脚。
 * 家具注入后 HEADER/FOOTER 排在内容末尾，但续页克隆时它们会被搬到新页最前面
 * （见 spillBlocks）——凡此种种，都让"第一个子元素"不再等于"第一个内容块"。
 */
const firstContent = el => [...el.children].find(child => !isFixed(child)) ?? null

/** Height actually available for content: the section's box minus its own padding. */
function contentBox(section) {
  const cs = section.ownerDocument.defaultView.getComputedStyle(section)
  const padTop = parseFloat(cs.paddingTop) || 0
  const padBottom = parseFloat(cs.paddingBottom) || 0
  return Math.max(0, section.clientHeight - padTop - padBottom)
}

/**
 * 页面被宿主 CSS 缩放时，`getBoundingClientRect` 报的是缩放后的值而 `clientHeight`
 * 不是。这里所有量都除以该系数——下文的「像素」一律指页面自身坐标系的像素。
 * （常规路径 beginMeasure 已把 section 钉到设计尺寸，系数恒为 1；这是防御性换算。）
 */
function scaleOf(section) {
  const rect = section.getBoundingClientRect()
  return rect.height > 0 && section.clientHeight > 0 ? rect.height / section.clientHeight : 1
}

/**
 * Position of every top-level block, relative to the section's content-box top.
 * Reading real layout positions (instead of summing heights) is what makes margins —
 * including collapsed ones — part of the measurement for free.
 *
 * 垂直居中（base.css 的 `justify-content: safe center`）会把整个内容柱往下推半格空闲，
 * 而分页判据要的是"内容贴在内容盒顶部"的逻辑坐标——先把这段顶部空移减掉，溢出判断、
 * 切点计算才与居中之前的旧行为逐像素一致。溢出态 `safe` 回退顶对齐，空移为 0，自动没错。
 * 家具是绝对定位的页面装饰，不随居中移动，所以取首个**内容**子块来量这段空移。
 * （块内拆分器——splitList / splitBlock——各自用块自身原点，本来就不受居中影响。）
 */
function blockRows(section) {
  const cs = section.ownerDocument.defaultView.getComputedStyle(section)
  const padTop = parseFloat(cs.paddingTop) || 0
  const rect = section.getBoundingClientRect()
  const scale = scaleOf(section)
  const base = rect.top + (section.clientTop + padTop) * scale
  const firstContentEl = [...section.children].find(el => !isFixed(el))
  const slack = firstContentEl
    ? Math.max(0, (firstContentEl.getBoundingClientRect().top - base) / scale)
    : 0
  const origin = base + slack * scale
  return [...section.children].map(el => {
    const r = el.getBoundingClientRect()
    const top = (r.top - origin) / scale
    return { el, top, bottom: top + r.height / scale }
  })
}

/**
 * Tell the reader this page carries on from the previous one: repeat the page's heading with
 * a marker, or — when there is no heading, or the heading itself is being carried over —
 * open the page with a bare marker.
 *
 * `isContinuation = false` 用于"另一个中心内容另起一页"：那种页不是谁的延续，它有自己的引语和
 * 核心，标「（续）」是误导。此时仍然重复标题（给上下文），只是不加标记。
 */
function appendContinuationMarker(cont, section, moving, opts, isContinuation = true, noHeading = false) {
  const marker = isContinuation ? opts.contMarker : null
  const first = firstContent(section)
  // `noHeading`: the continuation is a blank page for one block (see `spillToBarePage`) —
  // repeating the heading there would eat the very room the block was moved for.
  const repeats = !noHeading && (opts.repeatHeading ?? STRATEGY.repeatHeading) && first && isHeading(first)
  if (!repeats) {
    if (moving.includes(first)) return // the heading is carried over; it speaks for itself
    if (!marker) return
    // 同上：本页若已是续页，开头那个裸标记段落会被当成普通块保留下来，
    // 再追加一个就叠成「（续）（续）」。先清掉旧的。
    cont.querySelectorAll(`:scope > .${CONT_CLASS}`).forEach(el => el.remove())
    const p = cont.ownerDocument.createElement("p")
    p.className = CONT_CLASS
    p.textContent = marker
    // 插在最前面：续页标记是"这一页从上游接过来"的声明，得先于内容。
    // （spillBlocks 的降级重试会在内容已就位后才补这个标记，append 会把它甩到页尾。）
    cont.insertBefore(p, cont.firstChild)
    return
  }
  const heading = first.cloneNode(true)
  // 上一页若也是续页，它的标题里已经带了一个续标记；直接克隆会再追加一个，
  // 于是「（续）」随拆分轮数不断叠加（（续）（续）（续）…）。先剥掉旧的，保证每页只加一个。
  heading.querySelectorAll(`.${CONT_CLASS}`).forEach(el => el.remove())
  if (marker) {
    const mark = cont.ownerDocument.createElement("span")
    mark.className = CONT_CLASS
    mark.textContent = ` ${marker}`
    heading.appendChild(mark)
  }
  cont.appendChild(heading)
}

/** A block can only be sliced when its own layout is readable — an auto-scaled block is sized
 * asynchronously by a ResizeObserver, so its rect is not trustworthy right after a change. */
function canSplit(el) {
  if (el.shadowRoot) return false
  return el.tagName === "PRE" || el.tagName === "UL" || el.tagName === "OL" || el.tagName === "TABLE"
}

/**
 * 核心（PAGINATION.md §3）：代码 / 表格 / 有序无序列表 / 图片 / 单行公式。
 * 返回 null 表示"不是核心"——那它属于文档流、引语或结束语。
 *
 * 分类判据的纯层在 layout-core.classifyCore；这里只负责把 DOM 块读成描述子
 * （标签 / p 是否只含一张图 / 是否 KaTeX 块级公式）。
 *
 * 陷阱：markdown 里独立成行的图片渲染成 `<p><img></p>`，所以"只含一张图、没有文字"的段落
 * 必须判成图片核心，否则它会被当成引语，反而配不上自己的中心地位。
 */
function describeBlock(el) {
  let soleImg = false
  if (el.tagName === "P") {
    const kids = [...el.childNodes].filter(n => !(n.nodeType === 3 && !n.nodeValue.trim()))
    soleImg = kids.length === 1 && kids[0].nodeType === 1 && kids[0].tagName === "IMG"
  }
  return {
    tag: el.tagName,
    soleImg,
    katexDisplay: !!(el.classList?.contains("katex-display") || el.querySelector?.(".katex-display")),
  }
}

function coreTypeOf(el) {
  return classifyCore(describeBlock(el))
}

function splitBlock(el, room, opts) {
  if (el.tagName === "PRE") return splitCodeBlock(el, room, opts)
  if (el.tagName === "UL" || el.tagName === "OL") return splitList(el, room, opts)
  if (el.tagName === "TABLE") return splitTable(el, room, opts)
  return null
}

/**
 * 兜底诊断（2026-10-25 拍板：认输分支不再允许溢出）：进 opts.diags（结构化，
 * 宿主可取），同时 console.warn（e2e / CLI 的 console 捕获可见）。
 */
function warnDiag(opts, message) {
  if (Array.isArray(opts?.diags)) opts.diags.push({ level: "warning", message })
  console.warn(`[md2slides] ${message}`)
}

/** 版面内容区宽度（图片缩放的横向边界；纵向边界就是 budget）。 */
function contentWidth(section) {
  const cs = section.ownerDocument.defaultView.getComputedStyle(section)
  return Math.max(0,
    section.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))
}

/**
 * 超高媒体原位缩放（contain：等比缩到刚好放进盒内，铺满较长的一边）。
 * 命中至少一张返回 true（调用方负责复查溢出）。
 */
function fitImagesInPlace(el, boxW, boxH, scale) {
  const imgs = el.tagName === "IMG" ? [el] : [...(el.querySelectorAll?.("img") ?? [])]
  let changed = 0
  for (const img of imgs) {
    const r = img.getBoundingClientRect()
    const w = r.width / scale
    const h = r.height / scale
    if (w <= boxW && h <= boxH) continue
    const nw = img.naturalWidth || w
    const nh = img.naturalHeight || h
    const k = Math.min(boxW / nw, boxH / nh)
    img.style.width = `${Math.floor(nw * k)}px`
    img.style.height = `${Math.floor(nh * k)}px`
    changed += 1
  }
  return changed > 0
}

/**
 * 超高文本原位缩字号（段落 / 块级公式——KaTeX 全是 em 单位，随字号等比缩）。
 * 二分到刚好放进 room；下限 8px（1920 画布），缩到下限仍放不下返回 null
 * （物理极限，调用方决定进一步动作并告警）。返回缩放百分比（整数）。
 */
function shrinkTextToFit(el, room, scale, floor = STRATEGY.textShrinkFloor) {
  const view = el.ownerDocument?.defaultView
  const cs = view?.getComputedStyle?.(el)
  const original = parseFloat(cs?.fontSize)
  if (!Number.isFinite(original) || original <= floor) return null
  const measure = () => el.getBoundingClientRect().height / scale
  if (measure() <= room) return 100
  const fits = size => {
    el.style.fontSize = `${size}px`
    return measure() <= room
  }
  if (!fits(floor)) {
    el.style.fontSize = ""
    return null
  }
  let lo = floor
  let hi = original
  let chosen = floor
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) { chosen = mid; hi = mid } else { lo = mid }
  }
  el.style.fontSize = `${chosen}px`
  return Math.round((chosen / original) * 100)
}

/**
 * 切分后把源码行号改对。行号由 markdown.js 写进 data-src-*（1 基含端点），切分把一块
 * 搬成两块后，头块的 end 要收缩到头里最后一个带行号的后代（li / tr 都带），尾块的
 * start 取尾里第一个带行号的后代、end 沿用原块。头块没有行号（如裸 html_block）就不动。
 *
 * tailRoot：尾块里"搬过去的条目"的直接容器——splitTable 的续表挂了克隆表头，
 * 从 cont 根上找会命中表头行的行号，所以要指到 tbody。
 */
function restampSrcRange(head, tail, tailRoot = tail) {
  const origEnd = head.getAttribute("data-src-end")
  if (!origEnd) return
  const last = [...head.querySelectorAll("[data-src-end]")].pop()
  if (last) head.setAttribute("data-src-end", last.getAttribute("data-src-end"))
  const first = tailRoot.querySelector("[data-src-start]")
  if (first) tail.setAttribute("data-src-start", first.getAttribute("data-src-start"))
  tail.setAttribute("data-src-end", origEnd)
}

/**
 * Slice a table at a row boundary —— 「重复表头」（PAGINATION.md §5.3）：续页拿到的是一张**完整的表**
 * （克隆过的表头 + 剩余行），而不是一堆裸行。
 *
 * 这是长表跨页的唯一切分器：按实测行高找切点，找不到可容的行就整块搬、搬不动认输保页。
 * 若切不开，整块表只能"整块搬"，而搬了照样溢出 —— 于是每一轮都白搬一次、留下一张
 * 只有标题的空壳页（18 行的表就这么刷出 4 张过）。
 */
function splitTable(table, room, opts) {
  const scale = opts.scale ?? 1
  const body = table.querySelector("tbody")
  if (!body) return null
  const rows = [...body.rows]
  if (rows.length < 2) return null

  const head = table.querySelector("thead")
  const headH = head ? head.getBoundingClientRect().height / scale : 0
  const availBody = room - headH        // 表头每页都要占一份
  if (availBody <= 0) return null

  // 切行算术在 layout-core（countFittingPrefix）：能放下的前缀行数即切点。
  const cut = countFittingPrefix(
    rows.map(tr => tr.getBoundingClientRect().height / scale), availBody)
  if (cut <= 0 || cut >= rows.length) return null

  const cont = table.cloneNode(false)
  cont.classList.add("md2s-table-cont")   // 续页表标记：e2e 验「表头内容与首页一致」用
  if (head) cont.appendChild(head.cloneNode(true))
  const contBody = body.cloneNode(false)
  for (const tr of rows.slice(cut)) contBody.appendChild(tr)   // 搬走后半，原表只留前半
  cont.appendChild(contBody)
  restampSrcRange(table, cont, contBody)
  return cont
}

/**
 * Slice a code block at a line boundary: keep the head that fits, return the tail as a new
 * block of the same kind.
 *
 * The number of lines that fit cannot be derived from a line height — with wrapping, one
 * source line can occupy several visual rows — so it is found by bisection, measuring the
 * block itself after each change. That is ~log2(n) reflows, and only for blocks that really
 * overflow. Highlighting spans are dropped by slicing; the caller re-runs the highlighter
 * over the deck afterwards.
 */
function splitCodeBlock(pre, room, opts) {
  const scale = opts.scale ?? 1
  const code = pre.querySelector("code") ?? pre
  const source = code.textContent ?? ""
  // 尾随空行弹掉（layout-core trimTrailingBlankLines）：闭合围栏留下的空行不携带
  // 内容，切在它上面只会把空代码块甩给下一页。
  const lines = trimTrailingBlankLines(source.split("\n"))
  if (lines.length < 2) return null

  const fits = k => {
    code.textContent = lines.slice(0, k).join("\n")
    return pre.getBoundingClientRect().height / scale <= room
  }

  // Even one line is too tall (or the block fits after all): slicing cannot help.
  if (!fits(1)) {
    code.textContent = source
    return null
  }
  // 前缀二分（layout-core bisectMaxFit）：换行让"行数 ↔ 视觉高"不可解析，
  // 只能逐次实测；~log2(n) 次 reflow，只发生在真溢出的块上。
  const best = bisectMaxFit(lines.length, fits)
  if (best >= lines.length) {
    code.textContent = source
    return null
  }

  const tail = lines.slice(best).join("\n")
  code.textContent = lines.slice(0, best).join("\n")

  const cont = pre.cloneNode(false)
  const contCode = code.cloneNode(false)
  contCode.textContent = tail
  cont.appendChild(contCode)
  // 行号按算术收缩（围栏块内部没有带行号的子元素，restampSrcRange 帮不上）：
  // 内容行从 src-start+1（跳过起始围栏）数起，best 行留头，其余归尾。
  // 尾的 end 封到 start + lines.length——lines 已弹掉尾随空行，不去认领围栏前的空白。
  const srcStart = Number(pre.getAttribute("data-src-start"))
  if (srcStart > 0) {
    pre.setAttribute("data-src-end", String(srcStart + best))
    cont.setAttribute("data-src-start", String(srcStart + best + 1))
    cont.setAttribute("data-src-end", String(srcStart + lines.length))
  }
  return cont
}

/**
 * No item boundary fits: the FIRST item alone is taller than the space left — a list item
 * carrying a long code block, a long table or a nested list. Cutting at the item boundary is
 * impossible then (`cut <= 0`), and giving up is what let such a list stick out of the slide.
 *
 * So cut *inside* that item instead: its head stays, its tail plus the remaining items move on.
 * The item is cloned before the inner block is sliced, and the clone's copy of that block is
 * swapped for the tail — which is why the clone has to be taken first.
 */
function splitFirstItemInside(list, items, origin, room, opts) {
  const head = items[0]
  const kids = [...head.children]
  if (!kids.length) return null
  const limit = origin + room

  // 切点算术在 layout-core（cutIndexByBottom）：首个底边越过 limit 的子块下标。
  const cut = cutIndexByBottom(kids.map(k => k.getBoundingClientRect().bottom), limit)
  if (cut >= kids.length) return null

  // Cloned before anything is removed: the clone is what becomes the continuation item.
  const clone = head.cloneNode(true)
  // Bare text belongs to the head of the item, so the continuation must not carry a copy.
  for (const node of [...clone.childNodes]) if (node.nodeType === 3) node.remove()

  let tailBlock = null
  if (cut > 0) {
    // A whole inner block still fits: break at that boundary — cutting a full block per pass is
    // what makes this converge, slicing a few lines at a time does not.
    for (const el of kids.slice(cut)) el.remove()
    for (const el of [...clone.children].slice(0, cut)) el.remove()
  } else {
    // Even the first inner block is too tall: slice that block itself.
    const inner = kids[0]
    if (!canSplit(inner)) return null
    const roomInner = limit - inner.getBoundingClientRect().top
    if (roomInner <= 0) return null
    const idx = [...head.children].indexOf(inner)
    tailBlock = splitBlock(inner, roomInner, opts)
    if (!tailBlock || !clone.children[idx]) return null
    clone.children[idx].replaceWith(tailBlock)
  }
  if (!clone.children.length) return null

  const cont = list.cloneNode(false)
  if (list.tagName === "OL") {
    const start = Number(list.getAttribute("start")) || 1
    cont.setAttribute("start", String(start + 1))
  }
  cont.appendChild(clone)
  for (const li of items.slice(1)) cont.appendChild(li)
  restampSrcRange(list, cont)
  return cont
}

/** Slice a list at an item boundary; the continuation restarts the numbering for `<ol>`. */
function splitList(list, room, opts) {
  const scale = opts.scale ?? 1
  const items = [...list.children].filter(el => el.tagName === "LI")
  if (items.length < 2) return null

  const cs = list.ownerDocument.defaultView.getComputedStyle(list)
  const origin = list.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0) * scale
  // 切点算术在 layout-core（cutIndexByBottom）：首个底边（列表内容系）越过 room 的项。
  const cut = cutIndexByBottom(
    items.map(li => (li.getBoundingClientRect().bottom - origin) / scale), room)
  if (cut >= items.length) return null
  if (cut <= 0) return splitFirstItemInside(list, items, origin, room, opts)

  const cont = list.cloneNode(false)
  if (list.tagName === "OL") {
    const start = Number(list.getAttribute("start")) || 1
    cont.setAttribute("start", String(start + cut))
  }
  for (const li of items.slice(cut)) cont.appendChild(li)
  restampSrcRange(list, cont)
  return cont
}

/**
 * 目录页的专用切割（splitSection 的 isTocSlide 分支）。
 *
 * 为什么不能走通用路径：目录页的第一块是题名 `<p>`（不是标题），通用路径会判成
 * "题名是 flow、列表是核心" → 把整个列表搬去新页、题名留在原页，切出一页只有题名的
 * 废页。目录页要的是**按 li 边界切**：题名（含占位）留首页，剩余条目去续页，
 * 续页再补一份题名（fillToc 下一轮重建时写成"目录（续）"）。
 *
 * 续页由 `newSlideAfter` 的 `cloneNode(false)` 产出：`data-toc` 属性与 `md2s-toc`
 * class 全部继承，furniture（扉页口径）/ steps（整页一步）/ IR（srcRange 豁免）
 * 对目录页的特判自动覆盖它，不需要任何额外接线。
 *
 * @returns {boolean} 是否切出了新页
 */
function splitTocSection(section, opts) {
  const budget = contentBox(section) * (opts.margin ?? STRATEGY.margin)
  const rows = blockRows(section).filter(row => !isFixed(row.el))
  if (!rows.length || rows[rows.length - 1].bottom <= budget) return false

  const list = section.querySelector(`:scope > ol.${TOC_LIST_CLASS}`)
  if (!list) return false

  // 题名占位（含 margin）：续页要放得下剩余条目，首页给列表的空间得先扣掉题名
  const title = section.querySelector(`:scope > p.${TOC_TITLE_CLASS}`)
  let titleH = 0
  if (title) {
    const cs = section.ownerDocument.defaultView.getComputedStyle(title)
    titleH = (title.getBoundingClientRect().height
      + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)) / (opts.scale ?? 1)
  }
  // room 再收紧一项间距（STRATEGY.tocRoomSlack，策略封闭集）：splitList 按 li
  // 的**底边**（getBoundingClientRect，不含 margin）找断点，而本函数的溢出判据用
  // blockRows（含 margin）——不收紧就会切出"差几个像素仍算溢出"的页，且下一轮
  // splitList 又认为没有项超 room、切不动，死在这个缝里。
  const room = budget - titleH - STRATEGY.tocRoomSlack
  if (room <= 0) return false

  const cont = splitList(list, room, opts)
  if (!cont) return false
  const slide = newSlideAfter(section)
  if (!slide) return false
  // 续页 = 题名克隆 + 剩余条目。题名克隆带 data-src-*（fillToc 写的），
  // 本页第一条的行号口径由 fillToc 重建时重写，这里只是占位。
  if (title) slide.appendChild(title.cloneNode(true))
  slide.appendChild(cont)
  return true
}

/**
 * Split one overflowing slide into two. Returns false when nothing can be gained — most
 * importantly when the very first block is taller than a whole empty page and cannot be
 * sliced either, which would otherwise loop forever producing the same overflow.
 */
function splitSection(section, opts) {
  // 目录页（toc.js 的引擎产物）：按 li 边界切的专用路径，见 splitTocSection。
  // 条目一页放不下就切续页——页数反馈给 planToc 的 tocPages，下轮直接分组建页。
  if (isTocSlide(section)) return splitTocSection(section, opts)
  const avail = contentBox(section)
  if (avail <= 0) return false
  const rows = blockRows(section)
  if (!rows.length) return false // nothing measurable

  // 家具（HEADER/FOOTER）是绝对定位的页面装饰，它的"底边"贴着幻灯片下缘——
  // 不先滤掉的话，溢出判断会被一个永远"溢出"的页脚骗到。
  const movable = rows.filter(row => !isFixed(row.el))
  if (!movable.length || movable[movable.length - 1].bottom <= 0) return false

  const budget = avail * (opts.margin ?? STRATEGY.margin)
  if (movable[movable.length - 1].bottom <= budget) return false

  // 分割方法（PAGINATION.md §4）：其他段落走文档流（孤行控制），中心内容 = 引语 + 核心 + 结束语 是一体的。
  const units = assembleUnits(movable.map(row => describeBlock(row.el)))
  const ui = units.findIndex(u => movable[u.end].bottom > budget)
  if (ui < 0) return false
  const unit = units[ui]

  let cut = -1
  let remainder = null

  if (unit.role === "flow") {
    // 2026-10-25 拍板：整块高于一整页的段落不再认输——原位缩字号顺排（warning），
    // 不允许溢出。仅对"高于整页"的块生效：放得下整页的块照旧整块搬运（顺排/孤段控制
    // 的语义不能被缩放劫持）。
    const unitH = movable[unit.end].bottom - movable[unit.start].top
    if (unitH > budget) {
      const el = movable[unit.start].el
      const room = budget - movable[unit.start].top
      const pct = room > 0 ? shrinkTextToFit(el, room, opts.scale ?? 1) : null
      if (pct != null) {
        warnDiag(opts, `段落过高（约 ${Math.round(unitH)}px > 页高 ${Math.round(budget)}px），字号已缩至 ${pct}% 顺排`)
        return true
      }
      warnDiag(opts, "段落过高且缩至字号下限仍放不下（罕见，请反馈文档）")
      if (unit.start === 0) return false
    }
    if (unit.start === 0) return false
    cut = unit.start
  } else if (unit.start > 0) {
    // 中心内容放不下 → 整块新起一张，绝不为填满本页而把它拆开。
    //
    // 但搬到新页时，新页会在最前面**重复一遍本页标题**（appendContinuationMarker 克隆
    // firstElementChild），核心单元实际可用高度要扣掉它。若扣掉标题后仍放不下，搬到新页
    // 也照样溢出 —— 只会一轮轮白搬、每轮在原页留一张只有标题的空壳页（18 行的表就刷出过
    // 4 张）。这时必须改为切核心；连切都切不动，宁可让这一页溢出也不造废页。
    //
    // 标题占位含 margin：主题里标题上下 margin 合计约 0.45em，只减 border-box 会把
    // "搬过去也放得下"的窗口放宽这 ~25px —— 恰好盖过常见的溢出残差（源码层测高漏扣
    // 标题后的剩余溢出量），放行一次注定徒劳的搬运。
    const unitH = movable[unit.end].bottom - movable[unit.start].top
    const c = unit.core
    const firstChild = firstContent(section)
    let headingH = 0
    if (firstChild && isHeading(firstChild)) {
      const cs = section.ownerDocument.defaultView.getComputedStyle(firstChild)
      headingH = (firstChild.getBoundingClientRect().height
        + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
      ) / scaleOf(section)
    }
    // 更硬的形状护栏：核心之前若**只剩将被克隆回去的页家具**（首块标题 / 裸（续）段），
    // 整块搬走得到的是与本页几何相同的一页 —— 溢出原样带过去，每轮 pass 再搬一次、
    // 各留一张空壳，连续 OVERFLOW_MAX_PASSES 张"标题（续）"页即由此而来。
    // 该形状下搬运永远无意义，只能切核心（切不动则认输保页）。
    // 超高媒体（图片）例外：裸页上只放媒体本身，引导语留在原页——原页成为
    // 「标题+引导语」的扉页形态，给整页大图让路是正当排版（2026-10-25 拍板）。
    // furnitureOnly 卫士对媒体豁免：裸页只放图，不是「搬运等于没搬」的 futile 形态。
    const isMedia = unit.type === "image"
    const furnitureOnly = !isMedia && unit.start === 1
      && (isHeading(movable[0].el) || movable[0].el.classList?.contains(CONT_CLASS))
    if (furnitureOnly || unitH > budget - headingH) {   // 搬过去放不下（或搬了等于没搬）→ 切核心
      // 先试给它一张空白无标题的整页：放得下就不切碎（放不下会自己回滚，见函数注释）。
      // 超高媒体（图片）例外：裸页上只放媒体本身，引导语留在原页——原页成为
      // 「标题+引导语」的扉页形态，给整页大图让路是正当排版（2026-10-25 拍板）。
      if (spillToBarePage(section, movable.slice(isMedia ? c : unit.start).map(row => row.el), opts, budget)) return true
      const room = budget - movable[c].top
      if (room > 0 && canSplit(movable[c].el)) remainder = splitBlock(movable[c].el, room, opts)
      if (remainder) cut = c
      else if (unit.intro >= 0) cut = c   // 核心不可切 → 引语独占本页、核心整块去新页
      else {
        // 裸页被拒（原页会成空壳）且核心不可切：原位缩放/缩字到剩余空间——不允许溢出。
        const el = movable[c].el
        const room = budget - movable[c].top
        if (room > 0) {
          const prevStyle = el.getAttribute("style")
          const fitted = fitImagesInPlace(el, contentWidth(section), room, opts.scale ?? 1)
          if (fitted && !overflows(section, budget)) {
            warnDiag(opts, "超高图片已缩放适配本页剩余空间")
            return true
          }
          // 缩放救不了本页：回滚内联样式（写过的 width/height 不能残留到后续通道）
          if (prevStyle == null) el.removeAttribute("style")
          else el.setAttribute("style", prevStyle)
        }
        const pct = room > 0 ? shrinkTextToFit(el, room, opts.scale ?? 1) : null
        if (pct != null) {
          warnDiag(opts, `超高内容块已缩至 ${pct}% 适配本页剩余空间`)
          return true
        }
        return false                       // 物理极限：缩到下限仍放不下（罕见，请反馈）
      }
    } else {
      cut = unit.start                       // 新页放得下 → 整块搬走
    }
  } else {
    // 中心内容独占一张仍放不下，才允许内部拆解 —— 逐条对应 PAGINATION.md §5.3。
    const c = unit.core
    if (movable[c].bottom > budget) {
      const room = budget - movable[c].top
      if (room > 0 && canSplit(movable[c].el)) remainder = splitBlock(movable[c].el, room, opts)
      if (remainder) cut = c                    // 16 行：过长切分，头部与引语同属首页
      else if (unit.intro >= 0) cut = c         // 15 行：核心不可切 → 引语独占本页
      else {
        // 同上：不可切的核心独占整页仍放不下 → 原位缩放/缩字，不允许溢出。
        const el = movable[c].el
        const room = budget - movable[c].top
        if (room > 0) {
          const prevStyle = el.getAttribute("style")
          const fitted = fitImagesInPlace(el, contentWidth(section), room, opts.scale ?? 1)
          if (fitted && !overflows(section, budget)) {
            warnDiag(opts, "超高图片已缩放适配整页")
            return true
          }
          if (prevStyle == null) el.removeAttribute("style")
          else el.setAttribute("style", prevStyle)
        }
        const pct = room > 0 ? shrinkTextToFit(el, room, opts.scale ?? 1) : null
        if (pct != null) {
          warnDiag(opts, `超高内容块已缩至 ${pct}% 适配整页`)
          return true
        }
        return false
      }
    } else if (unit.outro >= 0) {
      cut = unit.outro                          // 17 行：核心放得下 → 结束语独占下页
    } else {
      return false
    }
  }

  // 孤行控制（layout-core adjustForWidow，策略阈值 STRATEGY.widowFill）。
  // 判据必须是 `u < ui`（确实回退了才改 cut）。写成 `u >= 1` 会在压根没回退时也执行赋值，
  // 把上面算好的精确断点（引语/结束语独占）无条件冲掉 —— 那正是"规则没有主人"的病根。
  // 另外只回退**文档流**单元：把前一个中心内容也拽过来会让一页出现两个核心，
  // 违反"每页最多一个中心内容"。
  if (!remainder && unit.start > 0) {
    const tailBottom = movable[movable.length - 1].bottom
    const widowed = adjustForWidow(
      units, movable.map(row => row.top), ui, tailBottom, budget, STRATEGY.widowFill)
    if (widowed !== null) cut = widowed
  }

  const moving = remainder ? [remainder] : [movable[cut].el]
  for (let i = cut + 1; i < movable.length; i++) moving.push(movable[i].el)

  const cont = newSlideAfter(section)
  if (!cont) return false
  appendContinuationMarker(cont, section, moving, opts)
  for (const el of moving) cont.appendChild(el)
  // 页眉页脚克隆放**最后**：IR 块序必须与 PPTX 形状序一致（fill_deck 的文本
  // 校验按序拼接），而内容在前、家具在后是注入器定下的块序约定。
  for (const el of [...section.children]) {
    if (isFixed(el)) cont.appendChild(el.cloneNode(true))
  }
  return true
}

/**
 * 每页用 header 重复祖先标题路径（`H1 > H2 > H3`），避免翻到续页丢失上下文。
 *
 * 只改写**已经存在**的 `<header>`（绝对定位，不参与布局）。反过来，凭空插入一个
 * `<header>` 会变成 `<section>` 的顶层子块，直接把实测高度搅乱 —— 所以没有就不建。
 *
 * 家具页眉（furniture.js 注入的）除外：它自带路径槽位，两边都写会重复一遍路径。
 */
function applyHeadingPath(doc, separator = " > ") {
  const seen = new Map()
  for (const section of sectionsOf(doc)) {
    for (const el of section.children) {
      const m = /^H([1-6])$/.exec(el.tagName)
      if (!m) continue
      const level = Number(m[1])
      seen.set(level, el.textContent.trim())
      for (let deeper = level + 1; deeper <= 6; deeper++) seen.delete(deeper)
    }
    const path = [1, 2, 3].map(level => seen.get(level)).filter(Boolean).join(separator)
    const header = section.querySelector(`:scope > header:not(.${FURNITURE_CLASS})`)
    if (!path || !header) continue
    let mark = header.querySelector(".md2s-heading-path")
    if (!mark) {
      mark = doc.createElement("span")
      mark.className = "md2s-heading-path"
      header.appendChild(mark)
    }
    mark.textContent = path
  }
}

/**
 * 规则（PAGINATION.md §5.5）：如果代码块可以在一张空白无标题的幻灯片中放下，就不要分割了。
 *
 * 核心在本页放不下、但独占一张**空白无标题**的页放得下时，整块搬过去，绝不按行 / 按项切碎它。
 *
 * 为什么必须实测而不是拿标题高度去估算：裸「（续）」标记段落占多少高度随主题而变，估错就是
 * 一张溢出的页。所以先搬、再量，放不下就把一切还原（块回原位、新页删掉），交给调用方继续走
 * 切分路径 —— 宁可让这一页切碎或溢出，也不留一张必定溢出的废页。
 *
 * @returns {boolean} true 表示已成功分出一张页
 */
function spillToBarePage(section, blocks, opts, budget) {
  const cont = newSlideAfter(section)
  if (!cont) return false
  appendContinuationMarker(cont, section, blocks, opts, true, true)

  const restore = blocks.map(el => ({ el, parent: el.parentNode, next: el.nextSibling }))
  for (const el of blocks) cont.appendChild(el)
  // 家具克隆放最后（同 splitSection：内容在前、家具在后）
  for (const el of [...section.children]) {
    if (isFixed(el)) cont.appendChild(el.cloneNode(true))
  }
  // 放得下、且原页还剩东西 —— 否则这一搬就把原页掏成了只有标题的空壳。
  if (!overflows(cont, budget) && leavesContent(section)) return true

  // 2026-10-25 拍板：超高媒体在裸页上等比缩放、充分使用整个版面——不允许溢出。
  // 可缩高度要扣掉裸页上非图片内容（裸页开头的「（续）」标记段）已占的高度——
  // 否则永远"差几十像素"缩不进，兜底永不生效。
  if (overflows(cont, budget)) {
    // 可缩高度要扣掉裸页上非图片内容（裸页开头的「（续）」标记段）已占的高度。
    // 亚像素/外边距残差：单次贴合可能仍差零点几像素，最多四轮、每轮再收 5%。
    let occupied = 0
    for (const child of cont.children) {
      if (child.tagName === "IMG" || child.querySelector?.("img")) continue
      occupied += child.getBoundingClientRect().height / (opts.scale ?? 1)
    }
    let boxH = Math.max(0, budget - occupied)
    for (let round = 0; round < STRATEGY.mediaFitRounds; round++) {
      fitImagesInPlace(cont, contentWidth(section), boxH, opts.scale ?? 1)
      if (!overflows(cont, budget)) break
      boxH = Math.round(boxH * STRATEGY.mediaFitShrink)
      if (boxH <= 0) break
    }
    if (!overflows(cont, budget) && leavesContent(section)) {
      warnDiag(opts, "超高图片已在整页缩放适配（无标题裸页，不溢出）")
      return true
    }
  }

  restoreBlocks(restore)
  cont.closest?.(SLIDE_SELECTOR)?.remove()
  return false
}

/**
 * Put moved blocks back. Reverse order matters: a block's recorded `next` sibling was moved
 * too, so it only becomes a child of the parent again once the blocks after it are back.
 */
function restoreBlocks(restore) {
  for (const { el, parent, next } of [...restore].reverse()) {
    if (!parent) continue
    if (next && next.parentNode === parent) parent.insertBefore(el, next)
    else parent.appendChild(el)
  }
}

/** Does the content of `section` reach past `budget`? Same measure as the split decision.
 * 家具（HEADER/FOOTER）要滤掉：它们绝对定位贴着幻灯片下缘，"底边"永远超预算。 */
function overflows(section, budget) {
  const rows = blockRows(section).filter(row => !isFixed(row.el))
  return rows.length > 0 && rows[rows.length - 1].bottom > budget
}

/**
 * Does `section` still hold something of its own? A page left with nothing but a heading (or a
 * 续 marker) is the shell page the splitters must never produce — it is the "多个页面只有标题（续）"
 * symptom, and it outweighs "don't slice this block": a shell page is worse than a
 * sliced block, because it carries no information at all.
 */
function leavesContent(section) {
  return [...section.children].some(
    el => !isFixed(el) && !isHeading(el) && !el.classList?.contains(CONT_CLASS),
  )
}

/**
 * Move every top-level block from `startIdx` onwards onto a fresh slide placed right after
 * `section`. Shared by the overflow splitter and by `enforceOneCorePerSlide`.
 */
function spillBlocks(section, startIdx, opts, isContinuation = true, budget = Infinity) {
  const moving = [...section.children].filter(el => !isFixed(el)).slice(startIdx)
  if (!moving.length) return false
  const cont = newSlideAfter(section)
  if (!cont) return false
  appendContinuationMarker(cont, section, moving, opts, isContinuation)

  const restore = moving.map(el => ({ el, parent: el.parentNode, next: el.nextSibling }))
  for (const el of moving) cont.appendChild(el)
  // 家具克隆放最后（同 splitSection：内容在前、家具在后，保 IR 块序 = PPTX 形状序）
  for (const el of [...section.children]) {
    if (isFixed(el)) cont.appendChild(el.cloneNode(true))
  }
  if (!overflows(cont, budget)) return true

  // 裸页规则（PAGINATION.md §5.5）：带标题放不下时，
  // 与其带过去再被搬空（原页就剩一张只有标题的空壳页），不如直接给它一张空白无标题的页。
  const heading = firstContent(cont)
  if (heading && isHeading(heading) && leavesContent(section)) {
    heading.remove()
    appendContinuationMarker(cont, section, moving, opts, isContinuation, true)
    if (!overflows(cont, budget)) return true
  }

  // 两种都放不下：这块高于一整页，拆过去只会留下必然溢出的废页 —— 撤销，交给切分路径。
  restoreBlocks(restore)
  cont.closest?.(SLIDE_SELECTOR)?.remove()
  return false
}

/**
 * 每个中心内容都从新的一页开始（自然也就满足了"每页最多一个"）。
 *
 * 只按"中心内容边界"切，**不做任何高度测量**：核心单元连同它的引语/结束语整体搬到新的一页，
 * 文档流块跟着它所属的那页走。中心内容本身高出整页时这里不管 —— 那属于 PAGINATION.md §5.3 的
 * 切分，交给 splitOverflow 处理。
 *
 * 判据是"它前面还有**足够多**的内容"：核心前面有别的段落时才另起一页，但那段内容必须占到页高的
 * STRATEGY.coreBreakFill 以上 —— 否则原页会剩成一张近乎空白的页，新页还要顶一个重复的"（续）"标题。
 * 纯标题不计入：标题本就该带着它下面的内容，否则会剩下一张只有标题的空页。
 *
 * 新页插在 section 紧后面；外层反复扫全篇直到稳定，这样新页里后续的第二个、第三个核心也会
 * 依次被拆出去，页序保持不变。
 */
function enforceOneCorePerSlide(doc, opts = {}) {
  let added = 0
  // A spill that was undone (the block is taller than any page) fails again on every later
  // pass — remembering it keeps the outer sweep from spinning through all 200 rounds.
  const undone = new WeakMap()
  for (let outer = 0; outer < 200; outer++) {
    let changed = false
    for (const section of sectionsOf(doc)) {
      // 目录页是引擎产物，不参与"每页一个核心"的规整（题名 + 列表天然两块）。
      // 注意与 splitSection 分流不同：高度溢出由 splitTocSection 按 li 边界切。
      if (isTocSlide(section)) continue
      const els = [...section.children].filter(el => !isFixed(el))
      const avail = contentBox(section)
      // 与 `splitSection` 用同一把尺子：`blockRows()` 读的是真实布局位置，块间 margin 天然
      // 计入。这里曾用 `getBoundingClientRect().height` 逐个求和——那样**不含 margin**，
      // 与同文件另一处的测量差出几十像素，正好在阈值边界上决定"这个核心要不要另起一页"。
      // 症状是一页里塞进两个中心内容：demo 里 H3(66)+UL(202)=268 差 2px 没够上 270 的线，
      // 而带上 margin 实测约 290。判据是软的，尺子却必须是准的。
      const rows = blockRows(section).filter(row => !isFixed(row.el))
      const descs = els.map(describeBlock)
      const units = assembleUnits(descs)
      // 选靶在 layout-core（selectCoreBreak，策略阈值 STRATEGY.coreBreakFill）：
      // 找第一个"前面有实内容、且（前单元也是核心 或 前面内容够阈值）"的核心单元。
      const target = selectCoreBreak(units, descs, rows.map(row => row.bottom), avail)
      if (!target) continue
      const tried = undone.get(section)
      if (tried?.has(target.start)) continue
      // 核心边界另起一页 ≠ 续页：它有自己的引语与核心，不该标「（续）」。
      // 带上预算：新页放不下时 spillBlocks 会降级为空白页或整个撤销，避免留下空壳废页。
      if (!spillBlocks(section, target.start, opts, false, avail * (opts.margin ?? STRATEGY.margin))) {
        const set = tried ?? new Set()
        set.add(target.start)
        undone.set(section, set)
        continue
      }
      added += 1
      changed = true
    }
    if (!changed) break
  }
  return added
}

/**
 * Repaginate a loaded deck so that no slide overflows. Returns the number of extra slides
 * created. The document is left in the same display state it was found in.
 *
 * 收敛之后才注入页眉页脚（furniture.js）：页码依赖最终页序，早一步注入数字就是假的；
 * 注入后页面即冻结，家具不参与任何测量（isFixed 白名单 + 绝对定位双保险）。
 */
function splitOverflow(doc, opts = {}) {
  if (!doc) return 0
  let added = 0
  try {
    beginMeasure(doc, opts.slideWidth, opts.slideHeight)
    // 先落实"每页最多一个中心内容"。它只看单元边界、不测量，所以放在测量块里也无妨；
    // 之后再由高度分页处理超长的中心内容与文档流。
    added += enforceOneCorePerSlide(doc, opts)
    const maxPasses = Math.max(1, opts.maxPasses ?? STRATEGY.maxPasses)
    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false
      // Snapshot: continuation slides created during this pass are handled by the next one,
      // which is what keeps the loop from re-visiting what it just produced.
      for (const section of sectionsOf(doc)) {
        // 目录页也走这里：isTocSlide 在 splitSection 内部分流到 splitTocSection
        // （按 li 边界切）。条目一页放不下就切续页，页数由下面的 tocPages 反馈固化。
        if (splitSection(section, { ...opts, scale: scaleOf(section) })) {
          changed = true
          added += 1
        }
      }
      if (!changed) break
    }
    // 兜底：分页过程中搬块有可能又凑出"一页两个核心"（例如续页收下了后续内容），再拆一次。
    // 此时各页都不溢出（上面的循环已收敛），拆开只会更宽松，不会重新引入溢出。
    added += enforceOneCorePerSlide(doc, opts)
    // 目录页分两拍（core/paginate/toc.js）：先插空壳把位置占住，页码定案后再往里
    // 填条目——页码是二阶的，目录页自己也要占一格，先填再数的数字必然是旧的。
    //
    // 每个章的目录要几页，由**上一轮 splitSection 的实测**说话：条目填满后才知道放不
    // 放得下，放不下的在下一轮 pass 循环被 splitTocSection 按 li 边界切开；那些临时
    // 续页继承 data-toc，这里先按章号数一遍再交给 planToc（只增不减，"重建 → 再切"
    // 之间不会震荡），随后被 planToc 连锅删掉、按页数重建为正式多页（续页题名
    // "目录（续）"、页码重填）。慢一轮换来状态永远一致——本拍里绝不边填边切。
    const tocPages = new Map()
    for (const s of sectionsOf(doc)) {
      const n = Number(s.getAttribute(TOC_SLIDE_ATTR))
      if (Number.isInteger(n) && n > 0) tocPages.set(n, (tocPages.get(n) ?? 0) + 1)
    }
    const tocPlan = planToc(doc, { ...opts, tocPages })
    // 目录页插进去了，页码、总页数至此才真正定案。
    renumber(doc)
    fillToc(doc, tocPlan, opts)
    // 填满后才知道放不放得下（空壳阶段量不到）。本拍**只报告、不切**：边填边切必然
    // 把条目填回首页（fillToc 按 plan 数据重建整个列表，不认切割结果），中间态会
    // 条目重复 + 首页仍溢出。如实计入 added 让 settle 再跑一轮——下一轮 pass 循环切、
    // 本拍按 tocPages 重建为正式多页，状态永远一致。
    for (const s of sectionsOf(doc)) {
      if (!isTocSlide(s)) continue
      if (overflows(s, contentBox(s) * (opts.margin ?? STRATEGY.margin))) added += 1
    }
    // → 注入页眉页脚（furniture.js）。
    // 幂等：先删旧再建，settle 多轮 + 染色后回潮反复调用也安全。
    injectFurniture(doc, opts.meta, opts)
    applyHeadingPath(doc, opts.headingPathSeparator)
  } finally {
    endMeasure(doc)
  }
  return added
}

// isFixed / coreTypeOf 同时是 kit/steps.js（步进表）的判块词汇：家具白名单与
// 「什么算内容块」全工程只此一份，分页与步进不许可各漂各的。
module.exports = { splitOverflow, CONT_CSS, CONT_CLASS, coreTypeOf, isFixed }
