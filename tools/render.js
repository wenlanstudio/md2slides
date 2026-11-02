"use strict"

/**
 * render.js — 命令行跑一遍新渲染引擎，产出一份可在浏览器里看的 HTML。
 *
 *   node tools/render.js examples/demo.md -o out.html [--divider 6] [--theme lecture]
 *
 * 只跑到「逻辑分页」为止：物理分页要真实布局，得在浏览器/headless 里由 overflow.js 接手。
 * 所以这份 HTML 里可能有一两页内容溢出——那是 overflow.js 的活，不是这步的 bug。
 */

const fs = require("fs")
const path = require("path")
const { JSDOM } = require("jsdom")
const { compose } = require("../core/compose")

const argv = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[i + 1] ?? "")
  else if (argv[i] === "-o") flags.set("o", argv[++i])
  else positional.push(argv[i])
}

const input = positional[0]
if (!input) {
  console.error("用法: node tools/render.js <input.md> [-o out.html] [--divider N] [--theme NAME]")
  process.exit(1)
}

const md = fs.readFileSync(input, "utf8")
const document = new JSDOM("").window.document
// 字体用绝对地址：输出文件可能落在任何地方，相对路径会指不到 lib/katex/fonts。
const katexFontsUrl = `file:///${path
  .resolve(__dirname, "../lib/katex/fonts")
  .replace(/\\/g, "/")}/`

const deck = compose(md, {
  document,
  katexFontsUrl,
  ...(flags.has("theme") ? { defaults: { headingDivider: 3, theme: flags.get("theme") } } : {}),
})
// divider 走 front-matter 才是正道；命令行只是临时覆盖一下方便试。
if (flags.has("divider")) {
  const again = compose(`---\nheadingDivider: ${flags.get("divider")}\n---\n\n${md}`, {
    document,
    katexFontsUrl,
  })
  Object.assign(deck, again)
}

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${path.basename(input)}</title>
<style>${deck.css}</style>
<style>
  /* 预览用：铺满、显示全部页、页间留缝。正式放映时由宿主接管。 */
  html, body { margin: 0; background: #2b2f36; }
  .md2slides-deck { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px 0; }
  section[data-slide] { width: ${deck.slideWidth}px; height: ${deck.slideHeight}px; }
</style>
</head><body>
<div class="md2slides-deck">${deck.html}</div>
</body></html>
`

const out = flags.get("o")
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, page, "utf8")
  console.log(`${deck.slideCount} 页 · ${deck.slideWidth}x${deck.slideHeight} · 主题 ${deck.theme} → ${out}`)
} else {
  console.log(page)
}
