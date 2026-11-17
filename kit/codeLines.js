"use strict"

/**
 * kit/codeLines.js — 代码块行级 DOM 包装：把 `pre > code` 的每一行包进
 * `<span class="code-line">`，供步进表（steps.js）按行切步。
 *
 * 为什么这里做、怎么做：
 *
 * 时机 —— 必须等染色（highlight.js 塞 .hljs-* span）与物理分页（overflow.js 用
 * textContent 重建续片）全部收敛之后。它们任何一个都会摧毁预先包好的行结构：
 *   - highlightCode 用 `code.innerHTML = …` 整段覆盖；
 *   - splitCodeBlock 用 `code.textContent = lines.slice(…).join("\\n")` 重建，span 全丢。
 * 所以本模块由 steps.js 在 buildStepPlan（建步进表那一刻，DOM 已稳定）惰性调用，
 * 而不是渲染期。行包装是**纯展示层**：不进 IR、不影响分页几何（span 是行内块，
 * 不改变换行），PPTX/IR 抽取时读 textContent 不受影响。
 *
 * 跨行 span —— highlight.js 的输出里，换行符是**裸文本节点**，可能落在某个
 * `<span class="hljs-…">` 的中间（多行字符串、块注释）。直接 `split("\\n")` 会把
 * span 撕成不匹配的碎片。这里按文本节点遍历、遇换行切行，用标签栈在行边界
 * 闭合/重开跨行标签——每行内部仍是合法闭合的 HTML 片段，CSS 高亮颜色不丢。
 *
 * 幂等 —— 已包装（code 里已存在 .code-line）则原样返回，重复调用不叠加。
 */

const CODE_LINE_CLASS = "code-line"

/** 代码块里取语言标记（`language-x` → x，小写；没有返回 null）。 */
function langOf(code) {
  const cls = [...(code.classList ?? [])].find(c => c.startsWith("language-"))
  return cls ? cls.slice("language-".length).toLowerCase() : null
}

/** 是不是代码块（`pre > code`）。与 overflow.js 的 canSplit 同源判断：PRE 即代码块。 */
function isCodeBlock(el) {
  return !!el && el.tagName === "PRE" && !!el.querySelector("code")
}

/**
 * 把 code 元素按行包进 .code-line span。就地修改，返回生成的行元素数组（空行也算）。
 *
 * @param {Element} code `pre > code` 元素（已染色或纯文本皆可）
 * @returns {Element[]} 每行一个 span.code-line
 */
function wrapCodeLines(code) {
  const existing = code.querySelectorAll(`.${CODE_LINE_CLASS}`)
  if (existing.length) return [...existing]

  const lines = splitIntoLines(code)
  code.textContent = ""
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = code.ownerDocument.createElement("span")
    line.className = CODE_LINE_CLASS
    line.innerHTML = lines[i]
    code.appendChild(line)
    // 行间补换行文本节点，保持 textContent 与原始逐字一致（IR / expect / 后续分页读它不漂移）。
    if (i < lines.length - 1) code.appendChild(code.ownerDocument.createTextNode("\n"))
    out.push(line)
  }
  return out
}

/**
 * 按文本节点切行，跨行 span 用标签栈闭合/重开。返回每行的 HTML 片段数组。
 *
 * 算法：DFS 遍历 code 子树（含文本节点），维护「从根到当前节点」的打开标签栈。
 * 遇文本节点把内容按 \n 切段；段间（换行处）闭合栈、压入当前行、再按原顺序重开
 * 栈（跨行标签在下一行原样延续），段内容拼到新行。空块返回 [""]（至少一行）。
 */
function splitIntoLines(code) {
  const lines = []
  let buf = ""
  const stack = [] // { open, close }，从根到当前节点的打开标签序列

  const walk = node => {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? ""
      const parts = text.split("\n")
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          // 换行：闭合所有打开标签，收束当前行，再原序重开
          const opened = [...stack]
          for (let k = opened.length - 1; k >= 0; k--) buf += opened[k].close
          lines.push(buf)
          buf = ""
          for (const t of opened) buf += t.open
        }
        buf += parts[i]
      }
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.tagName.toLowerCase()
    const attrs = [...node.attributes]
      .map(a => `${a.name}="${a.value.replace(/"/g, "&quot;")}"`)
      .join(" ")
    const entry = {
      open: `<${tag}${attrs ? " " + attrs : ""}>`,
      close: `</${tag}>`,
    }
    stack.push(entry)
    buf += entry.open
    for (const child of [...node.childNodes]) walk(child)
    stack.pop()
    buf += entry.close
  }

  for (const child of [...code.childNodes]) walk(child)

  if (buf !== "" || lines.length === 0) lines.push(buf)
  // 尾随 \n 产生的空行不是真内容，弹掉（保留至少一行）。
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()

  return lines.length ? lines : [""]
}

module.exports = { wrapCodeLines, isCodeBlock, langOf, CODE_LINE_CLASS, splitIntoLines }
