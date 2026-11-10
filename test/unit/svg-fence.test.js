"use strict"

/**
 * ```svg 围栏单测。
 *
 * 真栅格要 canvas，留给 `e2e/svg-fence-real.js` 在真浏览器里验；这里验的是不依赖
 * 浏览器 API 的那一半：类型登记、围栏识别、固有尺寸解析、注释清洗、硬失败分支。
 */

const test = require("node:test")
const assert = require("node:assert/strict")
const { JSDOM } = require("jsdom")

const { DIAGRAM_TYPES, chartBlocksOf } = require("../../core/render/diagramHost")
const { renderMarkdown } = require("../../core/parse/markdown")
const { BROWSER_TYPES } = require("../../host/browser")
const { NODE_TYPES } = require("../../host/thin")
const { renderSvg, svgIntrinsicSize, svgOpenTag, stripSvgComments } = require("../../host/browser/svgHost")

const svg = (attrs = 'viewBox="0 0 200 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="200" height="100" fill="#f00"/></svg>`

test("core 认识 ```svg 这个围栏语言", () => {
  assert.equal(DIAGRAM_TYPES.svg, "svg")
})

test("svg 归浏览器侧（栅格要 canvas），不归 Node 侧", () => {
  assert.ok(BROWSER_TYPES.includes("svg"))
  assert.ok(!NODE_TYPES.includes("svg"))
})

test("renderMarkdown 出来的 ```svg 被 chartBlocksOf 认成图表块", () => {
  const html = renderMarkdown(["", "```svg", svg(), "```", ""].join("\n"))
  const dom = new JSDOM(`<body>${html}</body>`)
  const blocks = chartBlocksOf(dom.window.document)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "svg")
  assert.equal(blocks[0].lang, "svg")
  assert.match(blocks[0].source, /<svg /)
})

test("固有尺寸：viewBox 优先于百分比 width/height", () => {
  assert.deepEqual(svgIntrinsicSize(svg('width="100%" height="100%" viewBox="0 0 320 180"')), {
    width: 320,
    height: 180,
    from: "viewBox",
  })
})

test("固有尺寸：逗号分隔的 viewBox、数值 width/height", () => {
  assert.deepEqual(svgIntrinsicSize(svg('viewBox="0, 0, 640, 360"')), {
    width: 640,
    height: 360,
    from: "viewBox",
  })
  assert.deepEqual(svgIntrinsicSize(svg('width="240" height="120px"')), {
    width: 240,
    height: 120,
    from: "width/height",
  })
})

test("开标签扫描跳过引号里的 >（编辑器导出的 aria-label 常带）", () => {
  const src = svg('aria-label="a > b" viewBox="0 0 480 240"')
  assert.match(svgOpenTag(src), /viewBox="0 0 480 240"/)
  assert.deepEqual(svgIntrinsicSize(src), { width: 480, height: 240, from: "viewBox" })
  assert.equal(svgOpenTag("<circle r='10'/>"), "")
})

test("固有尺寸：没有可量基准的一律 null（交给调用方硬失败，不猜 300×150）", () => {
  assert.equal(svgIntrinsicSize(svg('width="100%" height="100%"')), null)
  assert.equal(svgIntrinsicSize(svg('width="10cm" height="5cm"')), null)
  assert.equal(svgIntrinsicSize(svg('viewBox="0 0 0 100"')), null)
  assert.equal(svgIntrinsicSize("<circle r='10'/>"), null)
})

test("stripSvgComments 连非法 XML 注释（内含 --）也剥得掉", () => {
  const dirty = `<?xml version="1.0"?><!--?plantuml-src abc-- def-- -->${svg()}`
  const clean = stripSvgComments(dirty)
  assert.ok(!clean.includes("<!--"))
  assert.ok(clean.includes("<svg "))
  assert.ok(clean.includes("<?xml"))
})

test("renderSvg 对空围栏 / 非 SVG / 缺尺寸给硬失败 + 人话", async () => {
  await assert.rejects(() => renderSvg({ type: "svg", source: "  \n " }), /svg 围栏是空的/)
  await assert.rejects(() => renderSvg({ type: "svg", source: "x.png" }), /完整的 <svg/)
  await assert.rejects(
    () => renderSvg({ type: "svg", source: svg('width="100%" height="100%"') }),
    /量不出尺寸/,
  )
})
