"use strict"

/**
 * toc.js — 章节目录页：每个章节起始页之前插一页目录，当前章（及其子项）高亮。
 *
 * 形态（2026-10-30 拍板）：不是"封面后一张总目录"，而是**每章一页目录**——
 * 讲完一章翻到下一章之前，先落一页"我们在哪"。条目 = 全部章节（章级标题）
 * + 当前章的子项（章级 +1），当前章那条及其子项打 `.md2s-toc-current`。
 * 文档只有一章时不插：那种目录页只是把唯一的标题再抄一遍，零信息量。
 *
 * 为什么它不能像封面那样在 `compose` 里一次性生成：
 *   封面不依赖页码，目录依赖。**页码是二阶的**——物理分页每插一张续页，
 *   后面所有页的页码就整体后移；目录页自己插进去又要再挤一格。
 *   所以目录页分两拍（`planToc` 插空壳 → `renumber` → `fillToc` 填条目）：
 *   空壳先把位置占住，页码定案后再往里写数字，写进去的只是文本、不改版面。
 *
 * 两拍之间靠 **Element 引用** 而不靠页码/索引传值：续页是 `cloneNode(false)`
 * 插在后面的，已有节点不会被搬走，引用跨轮稳定。章节序号走 `data-toc-chapter`
 * 属性（compose 阶段打的），续页克隆会继承同一序号，取**首次出现**即可去重。
 *
 * 条目一页放不下怎么办（2026-10-30 用户拍板：排不下就新增幻灯片，不许砍条目）：
 *   **首轮每章一页**（空壳量不出高度，本轮不切，只在末尾如实报告"还没稳"）→
 *   下一轮 `splitOverflow` 的 pass 循环经 `splitTocSection` 按 li 边界实测切割 →
 *   同轮 `planToc` 前按章统计实际页数（`tocPages`，只增不减）→ 重建为正式多页。
 *   切割只发生在轮初、本拍只填不切——边填边切会把条目填回首页（fillToc 按 plan
 *   数据重建整个列表，不认切割结果），中间态会条目重复 + 首页仍溢出。
 *   组内均分，均分后仍放不下的下轮再切，最多条目数个 group 必然收敛。
 *   续页继承 `data-toc` 与 `md2s-toc` class（cloneNode(false)），furniture / steps /
 *   IR 的目录页口径自动覆盖它。
 *
 * IR v1 契约零改动：目录页就是普通 `<section data-slide>` + `<p>` + `<ol><li>`，
 * `coreTypeOf` 与 ir.js 都当普通段落/列表收，不需要任何新块类型。
 */

const { sectionsOf, PAGINATION_ATTR } = require("../section")

/** 目录页 section 的类名与标记属性。 */
const TOC_CLASS = "md2s-toc"
const TOC_SLIDE_ATTR = "data-toc"
/** 目录页是所在章的第几页 / 共几页（多页目录，fillToc 写"（续）"题名用）。 */
const TOC_PAGE_ATTR = "data-toc-page"
const TOC_PAGES_ATTR = "data-toc-pages"
/** 章节序号，打在章节起始页上（compose 阶段）。 */
const CHAPTER_ATTR = "data-toc-chapter"
/** 章级（1–6），与 CHAPTER_ATTR 同批打上。 */
const LEVEL_ATTR = "data-toc-level"
/** 目录页属于哪一章的文本，furniture.js 的面包屑靠它（不让目录页顶着上一章的路径）。 */
const PATH_ATTR = "data-toc-path"

const TOC_TITLE_CLASS = "md2s-toc-title"
const TOC_LIST_CLASS = "md2s-toc-list"
const TOC_ITEM_CLASS = "md2s-toc-item"
/** 子项语义类：级别比所在章深的条目。字号分级靠它，不按 `-hN` 后缀猜——
    章的级别随文档而变（H1/H2/H3 都可能是章），后缀硬编码必然误伤。 */
const TOC_SUB_CLASS = "md2s-toc-sub"
const TOC_TEXT_CLASS = "md2s-toc-text"
const TOC_PAGE_CLASS = "md2s-toc-page"
const TOC_CURRENT_CLASS = "md2s-toc-current"

/** 续页标记类名（与 furniture.js / overflow.js 各写一份，同工程约定）。 */
const CONT_CLASS = "md2s-cont"

/** 目录页标题（作者可经 opts.tocTitle 改；主题与 IR 只认结构）。 */
const TOC_TITLE = "目录"
/** 章数上限：每章一页目录，章节比这还多，光目录就能翻半天——宁可跳过也不刷屏。 */
const MAX_CHAPTERS = 14

const isFixed = el => el.tagName === "HEADER" || el.tagName === "FOOTER"
const levelOf = el => {
  const m = /^H([1-6])$/.exec(el?.tagName ?? "")
  return m ? Number(m[1]) : 0
}

/** 页的直接子标题（家具与容器 div 不算）。 */
const childHeadings = section => [...(section?.children ?? [])]
  .filter(el => !isFixed(el))
  .map(el => ({ el, level: levelOf(el) }))
  .filter(h => h.level > 0)

/** 标题文本：剥掉续页克隆带过来的「（续）」，再压空白。 */
const headingText = el => {
  const clone = el.cloneNode(true)
  clone.querySelectorAll(`.${CONT_CLASS}`).forEach(node => node.remove())
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim()
}

/**
 * 标题的源码行号（markdown.js 写进 data-src-*，1 基含端点；与 ir.js 的 srcOf 同约定）。
 *
 * 目录项自己没有源码，但它**指向**一个标题——把目标的行号抄过来，目录页的块
 * 在 IR 里就有了合法 srcRange（"这个条目说的是源码第 N 行"），不必为它破例豁免。
 * 顺带让行号按章递增，页内不回跳的校验也照常成立。
 */
const srcRangeOf = el => {
  const start = Number(el?.getAttribute?.("data-src-start"))
  if (!Number.isInteger(start) || start <= 0) return null
  const end = Number(el.getAttribute("data-src-end"))
  return [start, Number.isInteger(end) && end >= start ? end : start]
}

/** 目录页判据：overflow.js（跳过分页）与 steps.js（整页一步）共用。 */
const isTocSlide = el => !!el?.getAttribute?.(TOC_SLIDE_ATTR)

/**
 * 给每个章节起始页打序号（compose 阶段，物理分页之前）。
 *
 * 章级 = 文档里出现过的最小标题级别（多数讲义是 H1；通篇只用 H2 起步的文档
 * 就按 H2 分章），自适应，不给作者加约定。续页还没产生，因此这里打的属性
 * 是"原始章节结构"的快照，分页再也改不动它。
 *
 * @param {Element} deck sectionize（+封面）产出的 `.md2slides-deck`
 * @returns {number} 标记了几个章节起始页（0 = 文档没有标题，目录无从谈起）
 */
function markChapters(deck) {
  const sections = [...(deck?.children ?? [])]
  let level = 0
  for (const section of sections) {
    for (const h of childHeadings(section)) level = level === 0 ? h.level : Math.min(level, h.level)
  }
  if (!level) return 0

  let n = 0
  for (const section of sections) {
    const head = childHeadings(section).find(h => h.level === level)
    if (!head) continue
    n += 1
    section.setAttribute(CHAPTER_ATTR, String(n))
    section.setAttribute(LEVEL_ATTR, String(level))
  }
  return n
}

/**
 * 分页收敛后回读章节结构：章级标题 + 每章到下一章之间的子标题。
 *
 * 续页克隆会继承 CHAPTER_ATTR，用 `seen` 只认首次出现——那才是真正的章节起始页。
 * 子标题同理：一个子项横跨多页，每张续页都带同一标题，按文本去重只收首次出现。
 */
function collectChapters(doc) {
  const sections = sectionsOf(doc)
  const chapters = []
  const seen = new Set()
  sections.forEach((section, at) => {
    const n = Number(section.getAttribute(CHAPTER_ATTR))
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) return
    seen.add(n)
    const level = Number(section.getAttribute(LEVEL_ATTR)) || 1
    const head = childHeadings(section).find(h => h.level === level)
    chapters.push({
      index: n, slide: section, at, level,
      text: head ? headingText(head.el) : "",
      src: head ? srcRangeOf(head.el) : null,
      subs: [],
    })
  })
  chapters.forEach((chapter, k) => {
    const end = k + 1 < chapters.length ? chapters[k + 1].at : sections.length
    // 同一子项横跨多页时，续页（cloneNode）也带着同一个标题：按文本去重，只认
    // 首次出现——那才是这一节真正的起始页（页码也最小）。不按 data-src 去重：
    // 克隆标题不带行号，而行号一致的判定对不上续页。
    const seenSub = new Set()
    for (let i = chapter.at; i < end; i++) {
      for (const h of childHeadings(sections[i])) {
        if (h.level !== chapter.level + 1) continue
        const text = headingText(h.el)
        if (!text || seenSub.has(text)) continue
        seenSub.add(text)
        chapter.subs.push({ section: sections[i], text, src: srcRangeOf(h.el) })
      }
    }
  })
  return chapters
}

/** 诊断：与 overflow.js 的 warnDiag 同形（进 opts.diags + console.warn）。 */
function warn(opts, message) {
  if (Array.isArray(opts?.diags)) opts.diags.push({ level: "warning", message })
  console.warn(`[md2slides] ${message}`)
}

/**
 * `toc` 声明的三种写法（front-matter 或 opts 直接给）：
 *   false            → 关
 *   true / 缺省      → 开
 *   数字 1–6         → 开，且子项列到该级（< 章级+1 时不列子项）
 */
function tocState(opts = {}) {
  const declared = opts.toc ?? opts.meta?.toc
  if (declared === false || declared === "false") return { on: false, depth: 0 }
  // 只有**数字**才是深度声明。`true` 走进来会被 Number() 折成 1，于是"开"反而
  // 变成"子项列到 1 级"（= 不列子项）——布尔必须先挡掉。
  const n = typeof declared === "number" ? declared : NaN
  return { on: true, depth: Number.isFinite(n) && n >= 1 ? Math.min(6, Math.trunc(n)) : 0 }
}

/**
 * 把条目顺序均分成 N 组（N = 该章目录需要的页数）。
 *
 * 均分而不是按高度贪心：splitTocSection 上一轮已经按实测高度切过，反馈回来的页数
 * 就是"实测要几页"，顺序均分通常与切割边界一致；万一某组仍偏高，splitTocSection
 * 会再切一刀 → 页数反馈 +1 → 下一轮重分，单调收敛。
 */
function chunkItems(items, pages) {
  const n = Math.max(1, Math.trunc(pages) || 1)
  if (n <= 1 || items.length <= 1) return [items]
  const size = Math.ceil(items.length / n)
  const groups = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

/**
 * 第一拍：删掉上一轮留下的目录页，插好这一轮的空壳。
 *
 * 幂等是硬要求——settle 与"染色后回潮"会反复调用 splitOverflow，目录页每次都要
 * 从头来过。旧页连同被切出来的续页一起删（`newSlideAfter` 的 `cloneNode(false)`
 * 会让续页继承 `data-toc`，正是靠这一点一次删干净）。
 *
 * 空壳只占位、不填内容：页码要等 `renumber` 定案，而页码又依赖"目录页占不占位置"。
 *
 * @param {Document} doc
 * @param {object} [opts] { toc, meta, diags, tocPages }
 *   tocPages: Map<章号, 上轮实测页数>——splitOverflow 主流程在调本函数前统计。
 *   条目一页放不下时就多生成几页（用户 2026-10-30：排不下新增幻灯片，不砍条目）。
 * @returns {Array<{slide: Element, items: object[], chapter: object, page: number, pages: number}>}
 *   交给 `fillToc`；一个章可能对应多条（多页目录）。
 */
function planToc(doc, opts = {}) {
  if (!doc) return []
  for (const el of doc.querySelectorAll(`section[${TOC_SLIDE_ATTR}]`)) el.remove()

  const state = tocState(opts)
  if (!state.on) return []

  const chapters = collectChapters(doc).filter(ch => ch.text)
  if (chapters.length < 2) return []      // 单章：目录页只是复读标题
  if (chapters.length > MAX_CHAPTERS) {
    warn(opts, `章节过多（${chapters.length} > ${MAX_CHAPTERS}），已跳过章节目录页`)
    return []
  }

  const subLevel = state.depth > 0 ? state.depth : chapters[0].level + 1
  const pagesOf = chapter => {
    const n = Number(opts.tocPages?.get?.(chapter.index))
    return Number.isInteger(n) && n > 0 ? n : 1
  }
  const plan = []

  for (const chapter of chapters) {
    const items = []
    for (const other of chapters) {
      items.push({
        level: other.level,
        text: other.text,
        section: other.slide,
        src: other.src,
        current: other.index === chapter.index,
      })
      if (other.index === chapter.index && subLevel > other.level) {
        for (const sub of chapter.subs) {
          items.push({ level: subLevel, text: sub.text, section: sub.section, src: sub.src, current: true })
        }
      }
    }
    // 一页放不下就分几页（页数由上一轮实测反馈，见 tocPages）。条目不砍：
    // 章节主干与当前章子项都是目录的正文，砍任何一样都是在藏信息。
    const groups = chunkItems(items, pagesOf(chapter))
    for (const [k, group] of groups.entries()) {
      const slide = doc.createElement("section")
      slide.setAttribute("data-slide", "")
      slide.setAttribute(TOC_SLIDE_ATTR, String(chapter.index))
      slide.setAttribute(TOC_PAGE_ATTR, String(k + 1))
      slide.setAttribute(TOC_PAGES_ATTR, String(groups.length))
      slide.className = TOC_CLASS
      // 依次插在章起始页之前：insertBefore 到同一 ref 前保持插入序
      chapter.slide.parentNode?.insertBefore(slide, chapter.slide)
      plan.push({ slide, items: group, chapter, page: k + 1, pages: groups.length })
    }
  }
  return plan
}

/**
 * 第二拍：页码定案后往空壳里填条目。
 *
 * 页码从 `data-pagination` 读（renumber 刚刷过，是最权威的真值）；
 * deck 没要 paginate 时退到序号——目录页照样能用，只是不显示页码条。
 *
 * @returns {number} 填了几页
 */
function fillToc(doc, plan, opts = {}) {
  if (!doc || !plan?.length) return 0
  const sections = sectionsOf(doc)
  const pageOf = section => {
    const n = Number(section?.getAttribute?.(PAGINATION_ATTR))
    if (Number.isInteger(n) && n > 0) return String(n)
    const i = sections.indexOf(section)
    return String(i >= 0 ? i + 1 : 1)
  }

  let filled = 0
  for (const { slide, items, chapter, page, pages } of plan) {
    slide.textContent = ""
    slide.setAttribute(PATH_ATTR, chapter.text)
    slide.setAttribute(TOC_PAGE_ATTR, String(page ?? 1))
    slide.setAttribute(TOC_PAGES_ATTR, String(pages ?? 1))

    const title = doc.createElement("p")
    title.className = TOC_TITLE_CLASS
    const base = opts.tocTitle ?? TOC_TITLE
    // 多页目录的续页题名带"（续）"：与续页标记同款语言，读者知道这页接着上页列
    title.textContent = page > 1 ? `${base}（续）` : base
    // 行号取**第一条**（= 第一章）而不是本章：目录页的条目总是从头列起，
    // 标题若标本章行号就会比第一条还大，IR 的"页内行号不回跳"校验立刻炸。
    if (items[0]?.src) {
      title.setAttribute("data-src-start", String(items[0].src[0]))
      title.setAttribute("data-src-end", String(items[0].src[1]))
    }
    slide.appendChild(title)

    const list = doc.createElement("ol")
    list.className = TOC_LIST_CLASS
    for (const item of items) {
      const li = doc.createElement("li")
      li.className = [
        TOC_ITEM_CLASS,
        `${TOC_ITEM_CLASS}-h${item.level}`,
        item.level > chapter.level ? TOC_SUB_CLASS : "",
        item.current ? TOC_CURRENT_CLASS : "",
      ].filter(Boolean).join(" ")
      const text = doc.createElement("span")
      text.className = TOC_TEXT_CLASS
      text.textContent = item.text
      const page = doc.createElement("span")
      page.className = TOC_PAGE_CLASS
      page.textContent = pageOf(item.section)
      // 行号抄自所指的标题（见 srcRangeOf）：目录项没有自己的源码，但指向有源码的东西
      if (item.src) {
        li.setAttribute("data-src-start", String(item.src[0]))
        li.setAttribute("data-src-end", String(item.src[1]))
      }
      li.append(text, page)
      list.appendChild(li)
    }
    slide.appendChild(list)
    filled += 1
  }
  return filled
}

/**
 * 目录页的样式（引擎产物的兜底，与 CONT_CSS 同性质）。
 *
 * 主题 CSS（base.css + 皮肤）里也写了一份完整的：那边是"长什么样"，
 * 这里是"没有就难看"的下限——样式跟着**运行代码**的版本走，
 * 老主题 / 宿主没加载主题 CSS 时目录页也不会裸奔。
 */
const TOC_CSS = `
:where(section.${TOC_CLASS} > p.${TOC_TITLE_CLASS}) {
  margin: 0 0 0.4em 0;
  text-indent: 0;
  font-size: 1em;
  font-weight: 600;
  opacity: 0.8;
}
:where(section.${TOC_CLASS} > ol.${TOC_LIST_CLASS}) {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 2em;
}
:where(section.${TOC_CLASS} > ol.${TOC_LIST_CLASS} > li.${TOC_ITEM_CLASS}) {
  display: flex;
  align-items: baseline;
  gap: 0.6em;
  margin: 0.12em 0;
  line-height: 1.25;
  opacity: 0.5;
}
:where(section.${TOC_CLASS} > ol.${TOC_LIST_CLASS} > li.${TOC_CURRENT_CLASS}) { opacity: 1; }
/* 字号归主题：目录标题跟 2 级标题、条目跟 3 级标题；当前章只加粗/换色，子项只缩进。
   子项认语义类 md2s-toc-sub（级别比章深），不认 -hN 后缀：章的级别随文档而变。
   这里不再写 font-size，避免零特异性兜底压过主题。 */
:where(section.${TOC_CLASS} > ol.${TOC_LIST_CLASS} > li.${TOC_TEXT_CLASS}) { flex: 1 1 auto; min-width: 0; }
:where(section.${TOC_CLASS} > ol.${TOC_LIST_CLASS} > li > .${TOC_PAGE_CLASS}) {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
`

module.exports = {
  markChapters,
  planToc,
  fillToc,
  isTocSlide,
  chunkItems,
  TOC_CSS,
  TOC_CLASS,
  TOC_SLIDE_ATTR,
  TOC_PAGE_ATTR,
  TOC_PAGES_ATTR,
  CHAPTER_ATTR,
  LEVEL_ATTR,
  PATH_ATTR,
  TOC_TITLE_CLASS,
  TOC_LIST_CLASS,
  TOC_ITEM_CLASS,
  TOC_SUB_CLASS,
  TOC_TEXT_CLASS,
  TOC_PAGE_CLASS,
  TOC_CURRENT_CLASS,
}
