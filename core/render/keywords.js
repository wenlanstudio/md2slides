"use strict"
// keywords.js — front-matter 的 `keywords` → 正文关键词高亮。
//
// README/USAGE 早就写着"渲染时 keywords 突出显示"，这个模块就是那句话的落地：
// 声明 `keywords: 事实表, 度量` 后，正文里每出现一次就包一层
// `<mark class="md2s-kw">`，样式在 base.css——与 **加粗** 的 <strong> 同款（红字 + 700）。
//
// 为什么在渲染产物上做而不是写个 marked 扩展：
//   1. 关键词可能跨行内元素（`**事实**表` 渲染成 strong + 文本），扩展得处理 token 流，
//      DOM 一遍走完天然跨过；
//   2. 与语法高亮（highlight.js）同一层：都是"渲染后的 DOM 加工"，互不打扰；
//   3. 预览 / IR / PPTX 三处同源——PPTX 的 run 读实测色（runStyleOf），
//      浏览器里看到的强调色就是导出后的强调色（背景除外，run 没有背景概念）。
//
// 两条边界（写进 USAGE §3.1）：
//   · **代码块与标题不高亮**——代码归 highlight.js 管，标题自带强调，
//     再糊一层高亮只会糊；
//   · 封面与页眉页脚不受影响：封面在 compose 里于本模块之后生成，家具在物理分页
//     收敛后才注入，两者都赶在关键词扫描之前/之后，天然擦肩而过。

/** 高亮标记的类名。作者手写的 `<mark>` 不带这个类，样式双保险。 */
const KW_CLASS = "md2s-kw"

/** 不进这些子树：代码（含行内 code）、脚本、样式、SVG。 */
const SKIP_TAGS = new Set(["PRE", "CODE", "SCRIPT", "STYLE", "TEXTAREA", "SVG", "MATH"])
const RE_HEADING = /^H[1-6]$/

/** 防御性上限：关键词写成"的"这种超高频词时，避免把 DOM 吹爆。 */
const MAX_MARKS = 5000

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isWordEdge = ch => /[A-Za-z0-9_]/.test(ch)

/**
 * 关键词 → 一个大小写不敏感的总则。长词排前面（alternation 从左往右试，
 * "事实表"必须抢在"事实"前面）；首尾是单词字符的边缘补 `\b`，
 * 免得 `A` 命中 "Java" 里的 a、`C++` 被 `\b` 毁掉。
 */
const buildRegex = keywords => {
  const parts = keywords
    .map(k => String(k).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(k => {
      const left = isWordEdge(k[0]) ? "\\b" : ""
      const right = isWordEdge(k[k.length - 1]) ? "\\b" : ""
      return left + escapeRe(k) + right
    })
  return parts.length ? new RegExp(parts.join("|"), "gi") : null
}

/** 把一个文本节点里命中的片段换成 mark 序列，返回包了几个。 */
const wrapTextNode = (textNode, re, document) => {
  const text = textNode.nodeValue
  if (!text) return 0
  const matches = [...text.matchAll(re)].filter(m => m[0])
  if (!matches.length) return 0

  const frag = document.createDocumentFragment()
  let last = 0
  for (const m of matches) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)))
    const mark = document.createElement("mark")
    mark.className = KW_CLASS
    mark.textContent = m[0]
    frag.appendChild(mark)
    last = m.index + m[0].length
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
  textNode.parentNode.replaceChild(frag, textNode)
  return matches.length
}

/**
 * HTML 字符串 → 关键词高亮后的 HTML 字符串。
 *
 * 空关键词 / 空 html / 没有 document（Node 里裸调）时原样返回——
 * 调用方（compose）只在 `meta.keywords` 非空时才走到这儿。
 *
 * @param {string} html       markdown 渲染出的片段
 * @param {string[]} keywords 关键词数组（parseKeywords 的产物）
 * @param {Document} document 解析用的 Document（compose 透传的那个）
 * @returns {string}
 */
const highlightKeywords = (html, keywords, document) => {
  const list = (keywords ?? []).map(k => String(k).trim()).filter(Boolean)
  if (!html || !list.length || !document) return html

  const re = buildRegex(list)
  if (!re) return html

  const host = document.createElement("div")
  host.innerHTML = html
  let marks = 0

  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (marks >= MAX_MARKS) return
      if (child.nodeType === 3) {
        marks += wrapTextNode(child, re, document)
        continue
      }
      if (child.nodeType !== 1) continue
      if (SKIP_TAGS.has(child.tagName) || RE_HEADING.test(child.tagName)) continue
      walk(child)
    }
  }
  walk(host)
  return host.innerHTML
}

module.exports = { highlightKeywords, KW_CLASS, buildRegex }
