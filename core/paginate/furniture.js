"use strict"
// furniture.js — 页眉页脚注入：分页收敛后，把每页重复的"家具"盖上去。
//
// 家具（slide furniture）= 演示设计里的既有术语：页码、页眉、页脚这类每页重复、
// 但不属于作者内容的元素。为什么必须由引擎注入而不是作者手写：
//   1. 页码依赖**最终**页序与总页数——只有 splitOverflow 收敛后才知道；
//   2. 手写的家具会进 DOM 参与高度测量，把分页搅乱；
//   3. 预览 / IR / PPTX 三处各写一份必然漂移，注入保证同源。
//
// 所以注入点就在 splitOverflow 末尾（renumber 旁边）：页码已定、页面已冻结。
// 家具是 HEADER/FOOTER 标签 + 绝对定位——overflow.js 的 isFixed 白名单认这个组合，
// 不参与内容测量；块序上排在 section 子元素**末尾**，让 IR 块序与 PPTX 形状序
// 保持一致（fill_deck 的文本校验按序拼接，见 export/pptx/sidecar/fill_deck.py）。
//
// 内容模型是封闭的（不开放自由格式）：默认页眉左 `%book%`，
// 默认页脚左 `%path%`、右 `%page% / %total%`（2026-10-24 拍板：面包屑从页眉右上
// 搬到页脚左下——右上抢标题的视线，左下与页码同线才是阅读收尾的位置）。
// front-matter 的 `header` / `footer` 三态：
//   true（缺省）= 默认内容；false = 关；字符串 = 自定义模板（同一套变量）。
// 变量集：%book %title %author %date %page %total %path。

const { sectionsOf } = require("../section")

/** 家具元素类名（ir.js 靠它把每个槽位抽成独立块；entry.js 靠它做 e2e 断言）。 */
const FURNITURE_CLASS = "md2s-furniture"
/** 槽位类名：左 / 右。绝对定位由主题 CSS 负责，JS 只建结构。 */
const SLOT_CLASS = "md2s-slot"
const SLOT_LEFT_CLASS = "md2s-slot-left"
const SLOT_RIGHT_CLASS = "md2s-slot-right"

// 下面三个判据是 overflow.js / entry.js 既有实现的镜像，**故意各写一份**：
// 家具注入在分页管内部，与那边若漂移了应当让测试炸出来，而不是悄悄共用。
// （项目里 entry.js 的 coreTypeOf 也是同样策略。）
const CONT_CLASS = "md2s-cont"
// 目录页（core/paginate/toc.js）：与 CONT_CLASS 同款"各写一份"——它注入在分页管内部，
// 若与 toc.js 漂移了应当让测试炸出来，而不是悄悄共用。
const TOC_CLASS = "md2s-toc"
const TOC_PATH_ATTR = "data-toc-path"
const isFixed = el => el.tagName === "HEADER" || el.tagName === "FOOTER"
const isHeading = el => /^H[1-6]$/.test(el.tagName)

/** 默认内容模板。页脚不放 date/author——每页顶日期太吵，课件排版的常识（已拍板）。 */
const DEFAULT_HEADER = { left: "%book%", right: "" }
const DEFAULT_FOOTER = { left: "%path%", right: "%page% / %total%" }

/**
 * 扉页：只剩标题 /「（续）」标记的页。与 entry.js report 的 divider 同口径。
 * 目录页同列：它没有标题，路径沿用上一章是错的（顶着"上一章的名字"讲下一章），
 * 豁免页眉与页脚路径、保留页码即可——与扉页同款判据。
 */
const isDivider = section => {
  if (section.classList?.contains(TOC_CLASS)) return true
  const kids = [...section.children].filter(el => !isFixed(el))
  return kids.length > 0 && !kids.some(el => !isHeading(el) && !el.classList?.contains(CONT_CLASS))
}

/**
 * 逐页的标题路径（`H1 > H2 > H3`），口径基本同 overflow.js::applyHeadingPath：
 * 边扫边记每级最后一次出现的标题，深于当前级的全部作废，只取 1–3 级。
 * 家具自己算一份：`%path%` 要能出现在任何模板里（含自定义页脚），
 * 不能依赖 applyHeadingPath 的事后回填。
 *
 * H1 就是层级 1，照常计入（2026-10-24 规范，USAGE.md §3.0：正文里没有"题名"这种
 * 特殊元素，H1–H6 都是标题）。封面题名不用担心：它住在 `div.cover` 里，不是
 * section 的直接子元素，这里的标题扫描天然扫不到它。
 */
const headingPaths = (sections, separator = " > ") => {
  const seen = new Map()
  return sections.map(section => {
    // 目录页自带"属于哪一章"（toc.js 写入），不参与标题累积。
    const own = section.getAttribute?.(TOC_PATH_ATTR)
    if (own) return own
    for (const el of section.children) {
      const m = /^H([1-6])$/.exec(el.tagName)
      if (!m) continue
      const level = Number(m[1])
      seen.set(level, el.textContent.trim())
      for (let deeper = level + 1; deeper <= 6; deeper++) seen.delete(deeper)
    }
    return [1, 2, 3].map(level => seen.get(level)).filter(Boolean).join(separator)
  })
}

/** 模板展开：未知变量原样留着（让作者看见自己的笔误），不静默吞掉。 */
const expand = (tpl, vars) => String(tpl ?? "").replace(/%(\w+)%/g, (whole, key) =>
  (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : whole))

/**
 * 建一个家具元素；所有槽位展开后均为空则返回 null（不留空壳）。
 * @param {Document} doc
 * @param {"header"|"footer"} tag
 * @param {{left: string, right: string}} tpl 两个槽位的模板
 * @param {object} vars 变量表
 */
const buildFurniture = (doc, tag, tpl, vars) => {
  const el = doc.createElement(tag)
  el.className = FURNITURE_CLASS
  let slots = 0
  for (const [side, tpl2] of [["left", tpl.left], ["right", tpl.right]]) {
    const text = expand(tpl2, vars).trim()
    if (!text) continue
    const span = doc.createElement("span")
    span.className = side === "left" ? `${SLOT_CLASS} ${SLOT_LEFT_CLASS}` : `${SLOT_CLASS} ${SLOT_RIGHT_CLASS}`
    span.textContent = text
    el.appendChild(span)
    slots += 1
  }
  return slots ? el : null
}

/**
 * 给每一页盖上页眉页脚。幂等：先删旧再建（settle 多轮分页会反复调用）。
 *
 * 豁免规则（2026-10-24 拍板）：
 *   · 封面（第一页）：两样都豁免——封面页顶个页眉很傻；
 *   · 扉页（只有标题的页）：页眉豁免、页脚的**路径**也豁免、页码保留——扉页下一页
 *     的页脚还挂着同一条路径，连续两页同一路径就是"零信息量重复"
 *     （e2e dividerRepeat 判据的同款逻辑）。
 *
 * @param {Document} doc
 * @param {object|null} meta compose 透出的 deckMeta。缺省按默认开。
 * @param {object} [opts] { headingPathSeparator }
 * @returns {number} 注入了几个家具元素
 */
function injectFurniture(doc, meta, opts = {}) {
  if (!doc) return 0
  const sections = sectionsOf(doc)
  if (!sections.length) return 0

  const m = meta ?? {}
  const headerState = m.header === undefined ? true : m.header
  const footerState = m.footer === undefined ? true : m.footer
  const total = sections.length
  const paths = headingPaths(sections, opts.headingPathSeparator)

  let injected = 0
  sections.forEach((section, i) => {
    // 收敛可能被反复调用（settle 多轮 + 染色后回潮）：先清掉旧的再建，保证幂等。
    section.querySelectorAll(`:scope > header.${FURNITURE_CLASS}, :scope > footer.${FURNITURE_CLASS}`)
      .forEach(el => el.remove())
    if (i === 0) return // 封面豁免

    const vars = {
      book: m.book ?? m.title ?? "", // 书名缺退标题：页眉左边总得有个东西
      title: m.title ?? "",
      author: m.author ?? "",
      date: m.date ?? "",
      page: String(i + 1),
      total: String(total),
      path: paths[i] ?? "",
    }
    const divider = isDivider(section)

    // 页眉：默认只有左槽书名（缺失退标题；两者都空则整个页眉省略）。
    // 扉页豁免（与 dividerRepeat 同款判据——扉页下一页的页眉是同一条书名，
    // 连续两页零信息量）。自定义字符串是作者点名要的横幅，不受约束，
    // 但仍让位于封面/扉页豁免。
    if (headerState !== false && !divider) {
      const tpl = typeof headerState === "string"
        ? { left: headerState, right: "" }
        : DEFAULT_HEADER
      const header = buildFurniture(doc, "header", tpl, vars)
      if (header) {
        section.appendChild(header)
        injected += 1
      }
    }
    // 页脚：左槽章节路径、右槽页码（2026-10-24 拍板：面包屑搬家到左下）。
    // 扉页的路径同样豁免——下一页页脚还挂着同一条路径，复读而已；页码保留。
    // 单页文档不显示"N / 1"，只显示"N"。
    if (footerState !== false) {
      const tpl = typeof footerState === "string"
        ? { left: footerState, right: "" }
        : {
            left: divider ? "" : DEFAULT_FOOTER.left,
            right: total > 1 ? DEFAULT_FOOTER.right : "%page%",
          }
      const footer = buildFurniture(doc, "footer", tpl, vars)
      if (footer) {
        section.appendChild(footer)
        injected += 1
      }
    }
  })
  return injected
}

module.exports = {
  injectFurniture,
  headingPaths,
  FURNITURE_CLASS,
  SLOT_CLASS,
  SLOT_LEFT_CLASS,
  SLOT_RIGHT_CLASS,
}
