"use strict"

/**
 * compose.js — 把三段串成一份可渲染的幻灯片文档。
 *
 * ```
 * md ──ensureFrontMatter──▶ 配置（theme / divider / paginate）
 *    ──splitSemicolons────▶ 「A；B；C。」分号并列段落 → 列表（semicolons: false 可关）
 *    ──expandColumns──────▶ <!-- begin/split/end --> 三注释分栏展开
 *    ──renderMarkdown─────▶ HTML
 *    ──highlightKeywords──▶ front-matter keywords 命中处包 <mark>（无关键词则跳过）
 *    ──sectionize─────────▶ <section data-slide> 流
 *    ──cover──────────────▶ 剥手写封面 div · front-matter 有 title 才生成自动封面
 *    ──loadTheme + 打页码─▶ { html, css, slideWidth, slideHeight }
 * ```
 *
 * 它就是取代 `marp.render()` 的那个调用点。物理分页不在这里——那一步要真实布局，
 * 得等文档进了浏览器（或 headless）由 `core/paginate/overflow.js` 接手。
 *
 * 这里**不改写 Markdown 源码**：所有变换都发生在渲染出来的 DOM 上，
 * 原文件一个字都不会动（这也是不在源码层插 `---` 的原因）。
 */

const { ensureFrontMatter, frontMatterOf, frontMatterPairs, deckMeta } = require("./parse/frontMatter")
const { renderMarkdown } = require("./parse/markdown")
const { sectionize } = require("./split/sectionize")
const { expandColumns } = require("./split/cols")
const { splitSemicolons } = require("./split/splitSemicolons")
const { buildCover, stripHandwrittenCover } = require("./cover")
const { highlightKeywords } = require("./render/keywords")
const { loadTheme, katexCss } = require("./render/theme")
const { markChapters } = require("./paginate/toc")
const { codeCss } = require("./render/style")
const { highlightCode, highlightCss } = require("./render/highlight")

/**
 * 默认值。与 `frontMatter.js` 的 DEFAULT_FRONTMATTER 同值：那边是"无 front-matter 文档"
 * 的兜底，这边是 compose 可被 opts.defaults 覆盖的默认。
 */
const DECK_DEFAULTS = { headingDivider: 3, theme: "lecture" }

/** 分页级别钳到 1–6：6 表示"所有标题都分页"。 */
const clampDivider = value => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(6, Math.max(1, Math.trunc(n))) : DECK_DEFAULTS.headingDivider
}

/**
 * @param {string} md    Markdown 源文本
 * @param {object} [opts]
 * @param {Document} [opts.document]     sectionize 需要的 Document（浏览器里用全局的）
 * @param {object}  [opts.defaults]      默认 front-matter，默认 DECK_DEFAULTS
 * @param {boolean} [opts.expandCols]    是否展开 `<!-- begin/split/end -->` 分栏，默认 true
 * @param {boolean} [opts.codeWrap]      代码块是否换行（不换行就只能整体缩小），默认 true
 * @param {string}  [opts.themesDir]     主题目录
 * @param {Function}[opts.readFile]      读文件实现（浏览器宿主注入）
 * @returns {{ html: string, css: string, slideWidth: number, slideHeight: number,
 *             slideCount: number, theme: string|null, columns: number,
 *             coverDiags: object[], meta: object, doc: Document }}
 */
const compose = (md, opts = {}) => {
  const text = ensureFrontMatter(md ?? "", opts.defaults ?? DECK_DEFAULTS)
  const fm = frontMatterPairs(text)
  const meta = deckMeta(text)
  const divider = clampDivider(fm.headingDivider)

  // 分号转列表（默认开；front-matter `semicolons: false` 或 opts.semicolons: false 关）：
  // 「A；B；C。」→ 列表，并列短语得以按项切分而不是生切段落。护栏见 splitSemicolons.js。
  const semicolonsOn = (opts.semicolons ?? true) && fm.semicolons !== false
  const semicoloned = semicolonsOn ? splitSemicolons(text) : { text, count: 0 }
  const expanded = (opts.expandCols ?? true)
    ? expandColumns(semicoloned.text)
    : { text: semicoloned.text, count: 0, diagnostics: [] }
  // 关键词高亮赶在 sectionize 之前：那之后 DOM 已被切成 section 流，
  // 而封面（cover.js）与家具（furniture.js）都生成在更后面，天然扫不到。
  const rendered = renderMarkdown(expanded.text)
  const marked = meta.keywords.length
    ? highlightKeywords(rendered, meta.keywords, opts.document ?? globalThis.document)
    : rendered
  const { deck, doc } = sectionize(
    marked,
    { divider, document: opts.document ?? globalThis.document },
  )

  // 封面（USAGE.md §3.0 文档撰写规范）：先剥手写封面 div（规范不再收它），
  // 再按 front-matter 生成自动封面。两件事都赶在打页码之前——封面是第一页，
  // 页码要从它开始数。没有 title 就没有封面，第一页即正文第一页。
  const coverDiags = stripHandwrittenCover(deck)
  const cover = buildCover(doc, meta)
  if (cover) deck.prepend(cover)
  // 章节序号：赶在物理分页之前打——那是"原始章节结构"的快照。续页由 cloneNode(false)
  // 产出、会继承同一序号，目录页（toc.js）取首次出现即可认出真正的章节起始页。
  const chapters = markChapters(deck)
  const slideCount = deck.children.length

  // 页码：只在文档要了 paginate 时才打。`renumber()` 靠"有没有这个属性"判断要不要重排，
  // 所以这里不打，后面就不会凭空出现页码。
  // 注意要在打完之后再序列化 —— `sectionize` 返回的 html 是加工前的快照。
  if (fm.paginate === true) {
    ;[...deck.children].forEach((section, i) => {
      section.setAttribute("data-pagination", String(i + 1))
    })
  }

  const theme = loadTheme(fm.theme ?? DECK_DEFAULTS.theme, {
    themesDir: opts.themesDir,
    readFile: opts.readFile,
  })
  // 高亮在这里上一次，让离线产物（CLI 出片）也有颜色。
  // 浏览器里跑完物理分页后宿主还得再上一次：overflow.js 按行切代码块会把 span 全丢掉。
  const painted = (opts.highlight ?? true) ? highlightCode(doc) : 0

  // 按需拼 CSS：没公式不背 KaTeX，没代码不背高亮配色。
  const cssParts = [theme?.css]
  if ((opts.math ?? true) && /class="katex/.test(deck.innerHTML)) {
    cssParts.push(katexCss({ readFile: opts.readFile, fontsUrl: opts.katexFontsUrl }))
  }
  if (painted > 0) cssParts.push(highlightCss({ readFile: opts.readFile }))
  cssParts.push(codeCss(opts.codeWrap ?? true))
  const css = cssParts.filter(Boolean).join("\n")

  return {
    html: deck.innerHTML,
    css,
    slideWidth: theme?.slideWidth ?? 1920,
    slideHeight: theme?.slideHeight ?? 1080,
    slideCount,
    theme: theme?.name ?? null,
    columns: expanded.count,
    columnDiags: expanded.diagnostics ?? [],
    // 转成列表的分号段落数（0 = 未开启或没有命中）
    semicolons: semicoloned.count,
    coverDiags,
    // 章节数（目录页的原料；0 = 文档没有标题，目录无从谈起）
    chapters,
    // 八键文档元数据（title/subtitle/author/date/book/header/footer/keywords）：
    // 宿主透传给 IR 与 sidecar（keywords 只驱动渲染时高亮，不进文件属性）
    meta,
    highlighted: painted,
    keywords: meta.keywords.length,
    doc,
  }
}

module.exports = { compose, DECK_DEFAULTS, frontMatterPairs, clampDivider }
