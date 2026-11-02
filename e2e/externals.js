"use strict"

/**
 * externals.js — `core/` 在浏览器里 require 到、但我们不打包的那些东西。
 *
 * `bundle.js` 只搬 `core/` 与 `e2e/` 的源码，其余一律登记成 external，由这里在
 * **注入 bundle 之前**挂到 `window.__md2slides_externals` 上。
 *
 * 关键是别把 stub 做得太像真货：`core/` 里凡是要读文件的路径（`loadTheme`、`highlightCss`）
 * 在浏览器里本就不该被调用——样式是 Node 侧 `compose` 拼好带进来的。真被调用了就抛，
 * 让 e2e 立刻知道"这条链路跑到浏览器里去了"，而不是拿到一份空 CSS 继续往下走。
 */

/** `path` 的最小替身：只够模块顶层那几处 `path.resolve(__dirname, …)` 不炸。 */
const pathStub = {
  sep: "/",
  resolve: (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
  join: (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
  dirname: p => String(p).split("/").slice(0, -1).join("/") || ".",
  basename: (p, ext) => {
    const base = String(p).split("/").pop() ?? ""
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
  },
}

const missing = what => () => {
  throw new Error(`e2e externals: 浏览器里没有 ${what}（样式应由 Node 侧 compose 拼好带进来）`)
}

window.__md2slides_externals = {
  fs: { readFileSync: missing("fs.readFileSync"), existsSync: () => false },
  path: pathStub,
  // `lib/highlight.min.js` 由 <script> 先加载：它顶层是 `var hljs = …`，自动落到 window 上。
  // 只有 `core/render/highlight.js` 的 `highlightCode` 需要它。
  "lib/highlight.min.js": window.hljs,
}
