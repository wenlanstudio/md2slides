"use strict"

/**
 * sectionize.js — HTML 片段 → section 流，也就是 README 里的「逻辑分页」。
 *
 * 与"往 Markdown 源码里插 `---`"的老做法相对：那里改的是**作者的源码**，这里改的是**渲染产物**，
 * 源码一个字都不动。
 *
 * 顺带解决了三个源码层绕不开的坑：
 *  - 代码围栏里的 `# 注释` 与 `---` 不再需要"跳过围栏"的特判：markdown-it 已经把它们关在
 *    `<pre><code>` 里，根本到不了顶层块；
 *  - 作者手写的 `---` 和自动分页不再混为一谈——两者在 HTML 里都只是 `<hr>`，一视同仁地切；
 *  - 切页结果可以被重新计算（改个 divider 重跑即可），不必像插入 text 那样还要管回滚。
 *
 * 输出的每页是 `<section data-slide>`，这是 `core/section.js` 认的契约。
 * 物理上是否放得下不归这里管，那是 `core/paginate/overflow.js` 的事。
 */

const RE_HEADING = /^H([1-6])$/

const headingLevel = el => {
  const m = RE_HEADING.exec(el.tagName ?? "")
  return m ? Number(m[1]) : 0
}

/**
 * 把 HTML 挂到一个游离文档上取回节点。
 *
 * 用 `createHTMLDocument` 而不是 `DOMParser` 解析整篇：这个文档没有 browsing context，
 * 设置 innerHTML 不会去加载 `<img src>`，切页时才不会顺带打一堆网络请求。
 */
const toHost = (html, document) => {
  const doc = document.implementation.createHTMLDocument("md2slides")
  const host = doc.createElement("div")
  host.innerHTML = html ?? ""
  return { doc, host }
}

/**
 * 按标题级别切开顶层块。
 *
 * `divider` 沿用 marp `headingDivider` 的语义：级别 ≤ divider 的标题另起一页。
 * 想让 h4/h5/h6 也分页，给 `divider: 6` 即可 —— 原来那句"四级标题不分页"的抱怨，
 * 在这里只是个配置值，不再是引擎的限制。
 *
 * `<hr>`（作者手写的 `---`）同样分页，且 hr 本身不入页：它是分页符，不是内容。
 *
 * @param {string} html      markdown-it 渲染出的片段
 * @param {object} [opts]
 * @param {number} [opts.divider=3]    触发分页的最大标题级别（1–6）
 * @param {Document} [opts.document]   Node 环境注入（浏览器里用全局 document）
 * @returns {{ html: string, slideCount: number, doc: Document, deck: Element }}
 *          `deck` 挂在返回文档的 body 上，调用方可以在序列化前继续加工（比如打页码）。
 */
const sectionize = (html, opts = {}) => {
  const divider = Math.min(6, Math.max(1, opts.divider ?? 3))
  const document = opts.document ?? globalThis.document
  if (!document?.implementation) {
    throw new Error("sectionize needs a Document; pass opts.document (Node: use jsdom)")
  }

  const { doc, host } = toHost(html, document)
  const deck = doc.createElement("div")
  deck.className = "md2slides-deck"
  doc.body.appendChild(deck)

  let current = null
  const openSlide = () => {
    current = doc.createElement("section")
    current.setAttribute("data-slide", "")
    deck.appendChild(current)
    return current
  }

  for (const el of [...host.children]) {
    // 只有**裸** `<hr>` 才是作者手写的分页符。带 class 的是插件产物
    // （脚注插件会吐一个 `<hr class="footnotes-sep">`），把它当分页符会凭空多切一刀。
    if (el.tagName === "HR" && !el.hasAttribute("class")) {
      current = null       // 分页符本身不进页；下一块来时再开，不留空页
      continue
    }
    const level = headingLevel(el)
    if (level > 0 && level <= divider) openSlide()
    if (!current) openSlide()
    current.appendChild(el)
  }

  // 兜底：理论上到不了，但空页对后面的物理分页是个陷阱（量出 0 高、还占页码），清掉。
  for (const section of [...deck.children]) {
    if (!section.children.length) section.remove()
  }

  return { html: deck.innerHTML, slideCount: deck.children.length, doc, deck }
}

module.exports = { sectionize, headingLevel }
