"use strict"

/**
 * markdown.js — Markdown 文本 → HTML 片段。
 *
 * 这是自建渲染引擎的第一段，取代原来 `marp.render()` 里"把 md 变成 HTML"的那一半。
 * 它只做解析：**不分页**（`core/split/sectionize.js`）、**不套主题**（`core/render/theme.js`）。
 *
 * 为什么切页不在源码层做：往 md 里插 `---` 的做法得小心跳过代码围栏——围栏里的 `---`
 * 和 `# 注释` 长得跟分页符、标题一模一样。这里在 **HTML 层**切，
 * markdown-it 已经把围栏变成了 `<pre><code>`，那些文本根本不在顶层块里，问题不存在。
 *
 * 本模块不碰 DOM，所以浏览器和 Node 都能跑（分页那一步才需要真实布局）。
 */

const MarkdownIt = require("../../lib/markdown-it")
const plugins = require("../../lib/markdown-it-plugins")
const { RE_FRONT_MATTER } = require("./frontMatter")
const { registerQuiz } = require("../quiz/parse")

// KaTeX 是可选的：拿不到就把公式原样留着，总好过整个解析器起不来。
let katex = null
try {
  katex = require("../../lib/katex/katex")
} catch {
  katex = null
}

/**
 * 插件按"讲义会用到的 Markdown 方言"挑选，不是全量：
 *  - footnote：结束语可以是脚注（PAGINATION.md §3 的结束语定义）；
 *  - tasklist / alert：实验步骤与注意事项常用；
 *  - mark / sub / sup / ins：行内标记，成本极低。
 * 数学公式（KaTeX）见下面的 registerMath。
 */
const PLUGINS = ["footnote", "tasklist", "alert", "mark", "sub", "sup", "ins"]

/** 文档正文：去掉 front-matter 之后的部分。空文档返回空串。 */
const bodyOf = text => {
  const fm = RE_FRONT_MATTER.exec(text)
  return fm ? text.slice(fm[0].length) : text
}

let cached = null

/**
 * 一个共享的 markdown-it 实例。插件是注册在实例上的，反复 new 既浪费又容易漏挂。
 *
 * `html: true` 是必须的：讲义里有 `<br>`、`<img width=…>` 这类内联 HTML，
 * marp 当初也是这么开的（`offline/render.js` 的 `coreOptions = { html: true }`）。
 */
const md = () => {
  if (cached) return cached
  const instance = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
  })
  for (const name of PLUGINS) {
    const plugin = plugins[name]
    if (typeof plugin === "function") instance.use(plugin)
  }

  // 脚注插件按 HTML 文档的规矩输出 `<section class="footnotes">`，可我们的 `<section>` 是
  // **页面容器**（`section[data-slide]`），主题里 `section { width/height }` 会把这个脚注块
  // 直接撑成一整页。改成 div：class 选择器照样命中，层级上却不再冒充一页。
  instance.renderer.rules.footnote_block_open = () =>
    '<div class="footnotes">\n<ol class="footnotes-list">\n'
  instance.renderer.rules.footnote_block_close = () => "</ol>\n</div>\n"

  // —— 源码行号：块级元素带上 data-src-start / data-src-end ——
  // 约定：1 基、含端点，值域 = 该块在 md 里占据的行（围栏代码含 ``` 两行）。
  // markdown-it 的 token.map 是 0 基半开区间 [start, end)，换算即 start+1 与 end。
  // 消费方：IR 的 block.srcRange（ir.js）→ 宿主的「点击幻灯片跳源码行」与增量重排。
  // renderToken 覆盖所有走默认渲染的块开标签（paragraph / heading / list / li /
  // table / tr / blockquote…，行为探针验证过全带 map）；fence 与 math_block 有
  // 自己的渲染规则，单独包一层。
  const withSrcAttrs = token => {
    if (token.map) {
      token.attrSet("data-src-start", String(token.map[0] + 1))
      token.attrSet("data-src-end", String(token.map[1]))
    }
  }
  const defaultRenderToken = instance.renderer.renderToken.bind(instance.renderer)
  instance.renderer.renderToken = (tokens, idx, options) => {
    withSrcAttrs(tokens[idx])
    return defaultRenderToken(tokens, idx, options)
  }
  const defaultHtmlBlock = instance.renderer.rules.html_block
  instance.renderer.rules.html_block = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const html = defaultHtmlBlock(tokens, idx, options, env, self)
    // 原样输出的 HTML 块（如作者手写的 <img>）也带行号：注入到首个开标签
    if (!token.map) return html
    const attrs = ` data-src-start="${token.map[0] + 1}" data-src-end="${token.map[1]}"`
    return html.replace(/^<\w+/, m => m + attrs)
  }

  const defaultFence = instance.renderer.rules.fence
  instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const html = defaultFence(tokens, idx, options, env, self)
    // 默认 fence 规则不渲染 token.attrs 到 <pre> 上（attrs 全给了 <code>），注入到开标签。
    // 本实例没配 options.highlight，输出恒以 <pre> 开头；以防万一仍做前缀判断。
    if (!token.map || !html.startsWith("<pre>")) return html
    const attrs = ` data-src-start="${token.map[0] + 1}" data-src-end="${token.map[1]}"`
    return html.replace("<pre>", `<pre${attrs}>`)
  }

  if (katex) registerMath(instance)

  // 课堂竞答题标记（`<!--quiz {...}-->`）：挂在 core 规则链上，改写题干/选项的属性。
  // 必须早于 sectionize——sectionize 只搬元素节点，注释节点会被丢掉，
  // 那时再想认题已经晚了。
  registerQuiz(instance)

  cached = instance
  return cached
}

/**
 * 数学公式：`$…$` 行内、`$$…$$` 块级。
 *
 * 两条护栏是必须的，不然讲义里到处都是误伤：
 *  - `$` 紧跟空白（`5 美元， $ 100`）、或结束 `$` 前是空白，都不算公式；
 *  - 规则挂在 fence / backtick **之后**，代码块和行内代码里的 `$` 根本走不到这里。
 *
 * 块级公式用 `displayMode: true`，KaTeX 会输出 `.katex-display` ——
 * 正好是 `core/paginate/overflow.js::coreTypeOf` 认的「中心内容」，于是公式会被保护起来
 * （宁可独占一页，也不切成两半），不用额外配置。
 */
function registerMath(instance) {
  const escapeHtml = s =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

  const render = (tex, displayMode) => {
    try {
      return katex.renderToString(tex, { throwOnError: false, displayMode })
    } catch {
      return `<code>${escapeHtml(tex)}</code>`
    }
  }

  const mathInline = (state, silent) => {
    const start = state.pos
    if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false
    if (state.src.charCodeAt(start + 1) === 0x24) return false      // 块级交给 block 规则
    const after = state.src.charCodeAt(start + 1)
    if (after === 0x20 || after === 0x09 || after === 0x0a) return false

    let pos = start + 1
    let found = -1
    while (pos < state.posMax) {
      const c = state.src.charCodeAt(pos)
      if (c === 0x5c /* \ */) { pos += 2; continue }
      if (c === 0x24 /* $ */) {
        const prev = state.src.charCodeAt(pos - 1)
        if (prev === 0x20 || prev === 0x09) return false            // "$ 100" 不是公式
        found = pos
        break
      }
      if (c === 0x0a) return false                                  // 行内公式不跨行
      pos += 1
    }
    if (found < 0) return false

    const content = state.src.slice(start + 1, found)
    if (!content.trim()) return false
    if (!silent) {
      const token = state.push("math_inline", "", 0)
      token.content = content
      token.markup = "$"
    }
    state.pos = found + 1
    return true
  }

  const mathBlock = (state, startLine, endLine, silent) => {
    const begin = state.bMarks[startLine] + state.tShift[startLine]
    const end = state.eMarks[startLine]
    if (begin + 2 > end) return false
    if (state.src.slice(begin, begin + 2) !== "$$") return false
    if (silent) return true

    const firstLine = state.src.slice(begin + 2, end)
    const lines = []
    let closed = false
    let lastLine = startLine

    if (firstLine.trim().endsWith("$$")) {
      lines.push(firstLine.trim().slice(0, -2))
      closed = true
    } else {
      if (firstLine.trim()) lines.push(firstLine)
      for (let line = startLine + 1; line < endLine; line++) {
        const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
        if (text.trim().endsWith("$$")) {
          lines.push(text.trim().slice(0, -2))
          closed = true
          lastLine = line
          break
        }
        lines.push(text)
      }
    }
    if (!closed) return false

    state.line = lastLine + 1
    const token = state.push("math_block", "", 0)
    token.content = lines.join("\n").trim()
    token.markup = "$$"
    // 行号：block 规则要自己设 map（markdown-it 不会代劳），渲染层才注得出 data-src-*
    token.map = [startLine, state.line]
    return true
  }

  // after("backticks") / after("fence")：让代码先被吃掉，公式规则才不会去啃代码里的 $。
  // （规则名是复数 backticks —— 写成 backtick 会直接抛 "Parser rule not found"。）
  instance.inline.ruler.after("backticks", "math_inline", mathInline)
  instance.block.ruler.after("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  })
  instance.renderer.rules.math_inline = (tokens, idx) => render(tokens[idx].content, false)
  instance.renderer.rules.math_block = (tokens, idx) => {
    const token = tokens[idx]
    const html = render(token.content, true)
    // KaTeX 输出的首标签注入行号（不能包一层 div——coreTypeOf / ir.js 都认 katex-display 类本身）
    if (token.map) {
      const attrs = ` data-src-start="${token.map[0] + 1}" data-src-end="${token.map[1]}"`
      return html.replace(/^<\w+/, m => m + attrs)
    }
    return html
  }
}

/** Markdown 正文 → HTML 片段（不含 front-matter）。 */
const renderMarkdown = text => md().render(bodyOf(text ?? ""))

module.exports = { renderMarkdown, bodyOf, md }
