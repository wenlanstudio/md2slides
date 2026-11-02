"use strict"

/**
 * frontMatter.js — the document preamble, defined once.
 *
 * Front-matter 只在文档最顶上才有效，所以每个碰文档头部的环节（默认指令注入、主题
 * 读取、正文剥离）都得对「前言到哪结束」达成一致。一条正则、一组 helper，不留第二
 * 份意见——这里替换掉的三份副本当年就已经漂移过（有的不许围栏两侧有空格，有的允许）。
 */

const RE_FRONT_MATTER = /^[ \t]*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/

/** 没声明 front-matter 的文档用的缺省键值。宿主可经 compose 的 opts.defaults 覆盖。 */
const DEFAULT_FRONTMATTER = { headingDivider: 3, theme: "lecture" }

/** The preamble including its `---` fences, or `null` when the document has none. */
const frontMatterOf = text => {
  const m = RE_FRONT_MATTER.exec(text)
  return m ? m[0] : null
}

const hasFrontMatter = text => frontMatterOf(text) !== null

/** A scalar declared in the preamble, or `null` when the key is absent. */
const frontMatterValue = (text, key) => {
  const fm = frontMatterOf(text)
  if (!fm) return null
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(fm)
  return m ? m[1] : null
}

/**
 * front-matter 的标量：数字、布尔、去引号的字符串。够用了，不必为几个键拖进 js-yaml。
 *
 * `date: 2026-10-24` 因此**不会**变成日期对象——原样字符串进 IR，
 * 解析在 sidecar（Python 侧 strptime）。宽容度与"没有第二种解释"两边都保住。
 */
const scalar = raw => {
  if (raw == null) return undefined
  const s = String(raw).trim().replace(/^["']|["']$/g, "")
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true"
  return s
}

/** front-matter → 纯文本键值对。解析不出东西就返回空对象，绝不抛。 */
const frontMatterPairs = text => {
  const fm = frontMatterOf(text ?? "")
  if (!fm) return {}
  const inner = fm.replace(/^[ \t]*---[ \t]*\r?\n/, "").replace(/\r?\n---[ \t]*\r?\n?$/, "")
  const out = {}
  for (const line of inner.split(/\r?\n/)) {
    const m = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = scalar(m[2])
  }
  return out
}

/** 标量 → 非空字符串或 null。数字也收（`title: 2026` 说得通）。 */
const asText = value => (value == null || value === "" ? null : String(value))

/**
 * `keywords` 声明 → 去重后的关键词数组（大小写不敏感地去重，保留首见形式）。
 *
 * 收三种写法：`keywords: A, B, C`（逗号分隔，USAGE §3.1 示例）、`keywords: [A, B, C]`
 * （YAML 流式列表）、分隔符兼容 `,` `，` `;` `；` `、`。没声明 / 空声明 → `[]`——
 * 高亮模块看到空数组直接跳过，不白跑一遍 DOM。
 */
const parseKeywords = value => {
  if (value == null) return []
  const items = Array.isArray(value) ? value : [value]
  const out = []
  const seen = new Set()
  for (const item of items) {
    const s = String(item ?? "").trim().replace(/^\[/, "").replace(/\]$/, "")
    for (const part of s.split(/[,，;；、]/)) {
      const kw = part.trim()
      if (!kw) continue
      const key = kw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(kw)
    }
  }
  return out
}

/**
 * deckMeta — front-matter 的八键全局配置（文档元数据入口）。
 *
 * 四组，各有一个明确去向，互不越界：
 *   封面/文件属性组 `title` / `subtitle` / `author` / `date`
 *                     → 封面页（题名 / 副标题 / 作者 / 日期）+ PPTX 文件属性
 *                       （title→标题、subtitle→主题、author→作者）
 *   家具开关组 `header` / `footer`          → 三态：缺省 `true`（开）/ `false`（关）/
 *                                             字符串（自定义文本）。渲染落地在后续版本，
 *                                             这里只负责把声明读成封闭的三态，不猜第四种。
 *   归属组     `book`                        → 书籍/课程名，页眉左侧的内容源
 *   渲染组     `keywords`                    → 关键词数组，正文命中即高亮（见 render/keywords.js）
 *   放映组     `show` / `page`               → 放映形态（2026-10-26 用户设计评审）：
 *                                              show: "page"（默认，整页全显）| "element"（渐进揭示）
 *                                              page: 仅 show=page 有意义——true（默认）逐元素
 *                                              游走（全显 + 高亮步进，翻页笔走到 ▶ 按 Enter 运行）
 *                                              / false 纯整页翻。决策在 shell 的 resolveGranularity
 *                                              （文档级 > config 全局缺省 > 引擎缺省）。
 *   目录组     `toc`                          → 章节目录页（2026-10-30 拍板，core/paginate/toc.js）：
 *                                              true（缺省）= 每章前一页目录、当前章高亮 /
 *                                              false = 关 / 数字 1–6 = 子项列到该级。
 *                                              章节数 < 2 时任何写法都不插（那种目录页零信息量）。
 *
 * `date` 主键、`datetime` 别名（marp 兼容）：两边都写时主键优先。
 * 未声明的键不补默认值（标量键为 `null`，`keywords` 为 `[]`）——文件属性缺一项比塞默认标题好。
 */
const deckMeta = text => {
  const fm = frontMatterPairs(text)
  return {
    title: asText(fm.title),
    subtitle: asText(fm.subtitle),
    author: asText(fm.author),
    date: asText(fm.date ?? fm.datetime),
    book: asText(fm.book),
    header: fm.header === undefined ? true : fm.header,
    footer: fm.footer === undefined ? true : fm.footer,
    keywords: parseKeywords(fm.keywords),
    show: asText(fm.show),
    // null = 未声明（shell 回退 config）；已声明时收窄为布尔
    page: fm.page === undefined ? null : fm.page === true,
    // 章节目录页：true（缺省）开 / false 关 / 数字 = 子项列到几级（< 章级+1 即不列子项）
    toc: fm.toc === undefined ? true : fm.toc,
  }
}

/**
 * Prepend the default preamble when the document declares none, so a bare `.md` still becomes
 * a deck (a heading divider + a theme) instead of one long unstyled page.
 * A document that already has a preamble is returned untouched: the author's words win.
 */
const ensureFrontMatter = (text, defaults) => {
  if (!defaults || !Object.keys(defaults).length) return text
  if (hasFrontMatter(text)) return text
  const body = Object.entries(defaults).map(([key, value]) => `${key}: ${value}`).join("\n")
  return `---\n${body}\n---\n\n${text}`
}

module.exports = {
  RE_FRONT_MATTER,
  DEFAULT_FRONTMATTER,
  frontMatterOf,
  hasFrontMatter,
  frontMatterValue,
  frontMatterPairs,
  deckMeta,
  ensureFrontMatter,
}
