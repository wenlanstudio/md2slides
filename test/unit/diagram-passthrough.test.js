"use strict"

/**
 * diagram-passthrough.test.js — 新七类透传的 core 侧回归：
 *
 *  · DIAGRAM_TYPES 与编辑器（wenlan muya fence.ts）对齐：七类新类型 + 别名都在；
 *  · 图表块识别（chartBlocksOf / typeOfBlock）对围栏语言别名（chartjs）同样命中；
 *  · blockSource（Typora 块配置头 + 宽松 JSON）与编辑器同规格——chart/wavedrom/
 *    drawio 的围栏里带着 `// ==BlockCodeConfig==` 头、`config = {...}` 赋值与
 *    尾逗号也解析得出；
 *  · drawioHost 的纯函数面（XML/graphConfig 判别、本地路径→/f?p= 改道、PNG IHDR）。
 *
 * 渲染本身是浏览器的活，在 e2e（fixtures/diagram-more.md）里真浏览器回归。
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")
const { JSDOM } = require("jsdom")

const {
  DIAGRAM_TYPES,
  typeOfBlock,
  chartBlocksOf,
} = require("../../core/render/diagramHost")
const { slideDisplay } = require("../../core/render/diagram")
const { parseDiagramBlock, parseJsonBlock, pixelSize } = require("../../core/render/blockSource")
const { embedUrl, pngSize, sourcePath, localUrl } = require("../../host/browser/drawioHost")
const { DIAGRAM_LIBS, LIB_KEY_OF_LANG } = require("../../host/browser/libAssets")

test("DIAGRAM_TYPES 补齐编辑器已支持的七类（含别名）", () => {
  for (const [lang, type] of Object.entries({
    "vega-lite": "vega-lite",
    flowchart: "flowchart",
    sequence: "sequence",
    wavedrom: "wavedrom",
    chart: "chart",
    chartjs: "chart",
    abc: "abc",
    drawio: "drawio",
  })) {
    assert.equal(DIAGRAM_TYPES[lang], type, `围栏语言 ${lang} 必须映射到 ${type}`)
  }
})

test("围栏识别：chartjs 别名命中 chart、vega-lite 带连字符照认", () => {
  const dom = new JSDOM(``)
  const doc = dom.window.document
  const pre = doc.createElement("pre")
  const code = doc.createElement("code")
  code.setAttribute("class", "language-chartjs")
  code.textContent = "config = { type: 'bar' }"
  pre.appendChild(code)
  doc.body.appendChild(pre)

  const blocks = chartBlocksOf(doc.body)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "chart")
})

test("块配置头：@width/@height 拎出、赋值前缀剥掉、尾逗号容忍", () => {
  // 与编辑器同规格：注释/尾逗号/无引号键容忍；字符串要双引号（编辑器的
  // relaxJson 原样保留引号串，单引号 JSON.parse 必挂——deck 不偷偷放宽）。
  const source = [
    "// ==BlockCodeConfig==",
    "// @width 560px",
    "// @height 300px",
    "// @backgroundColor transparent",
    "// ==/BlockCodeConfig==",
    "",
    "config = {",
    '  type: "bar",',
    "  data: { labels: [\"一\", \"二\"], datasets: [{ data: [1, 2,] }] },",
    "}",
  ].join("\n")

  const { options, value } = parseJsonBlock(source)
  assert.equal(options.width, "560px")
  assert.equal(options.height, "300px")
  assert.equal(options.backgroundcolor, "transparent")
  assert.equal(value.type, "bar")
  assert.deepEqual(value.data.datasets[0].data, [1, 2])
  assert.equal(pixelSize(options.width), 560)
  assert.equal(pixelSize(options.height), 300)
})

test("块配置头没收尾标记时在第一行真代码处结束", () => {
  const { options, body } = parseDiagramBlock([
    "// ==BlockCodeConfig==",
    "// @height 120px",
    "X:1",
    "T:音阶",
  ].join("\n"))
  assert.equal(options.height, "120px")
  assert.ok(body.startsWith("X:1"), "真代码必须留在 body 里")
})

test("URL 里的 // 不被当注释吃掉", () => {
  const { value } = parseJsonBlock('{ "url": "http://cdn.example/a.png" }')
  assert.equal(value.url, "http://cdn.example/a.png")
})

test("drawio sourcePath：file://、Windows 盘符、绝对路径、相对路径", () => {
  assert.equal(sourcePath("file:///D:/图/a.drawio"), "D:/图/a.drawio")
  assert.equal(sourcePath("D:\\图\\a.drawio"), "D:/图/a.drawio")
  assert.equal(sourcePath("/home/me/a.drawio"), "/home/me/a.drawio")
  assert.equal(sourcePath("diagrams/a.drawio"), null, "相对路径按 mdDir 拼，不做盲转换")
})

test("drawio localUrl：相对路径按 __md2slides_mdDir 拼进 /f?p=", () => {
  globalThis.location = new JSDOM("", { url: "http://127.0.0.1:1/" }).window.location
  try {
    globalThis.__md2slides_mdDir = "D:\\讲义\\第四章"
    const url = localUrl("figures/a.drawio")
    assert.ok(url.startsWith("http://127.0.0.1:1/f?p="), url)
    const target = decodeURIComponent(url.split("/f?p=")[1])
    assert.equal(target, "D:/讲义/第四章/figures/a.drawio")
  } finally {
    delete globalThis.__md2slides_mdDir
    delete globalThis.location
  }
})

test("drawio embedUrl 与编辑器同一条 URL 形状", () => {
  assert.equal(
    embedUrl("https://embed.diagrams.net"),
    "https://embed.diagrams.net/?embed=1&proto=json&ui=min&libraries=0&saveAndExit=0&noSaveBtn=1&noExitBtn=1&keepstyle=1",
  )
  assert.ok(embedUrl("https://example.com/").startsWith("https://example.com/?embed=1"), "尾斜杠要剥")
})

test("pngSize 读 PNG IHDR；非 PNG 返回 null", () => {
  // 1×1 透明 PNG 的 base64
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  assert.deepEqual(pngSize(png), { width: 1, height: 1 })
  assert.equal(pngSize("data:image/jpeg;base64,AAAA"), null)
})

test("libAssets：七类都有运行时清单；drawio 无本地运行时", () => {
  for (const type of ["vega-lite", "flowchart", "sequence", "wavedrom", "chart", "abc"]) {
    assert.ok(Array.isArray(DIAGRAM_LIBS[type]) && DIAGRAM_LIBS[type].length > 0, `${type} 要有 lib 清单`)
  }
  assert.equal(DIAGRAM_LIBS.drawio, undefined, "drawio 走 embed，不该有本地运行时")
  assert.equal(DIAGRAM_LIBS["vega-lite"].length, 3, "vega 三件套顺序固定")
  assert.equal(LIB_KEY_OF_LANG.chartjs, "chart")
})

test("slideDisplay：小图放大到可读下限、大图钳顶、栅格倍率自适应", () => {
  // vega 缺省 200px 宽 → 放大到 640，高度等比；栅格倍率要盖住 2× 显示密度
  //（ceil(3.2×2)=7，但被 maxScale=6 钳顶——矢量栅格 6 倍已是 1200px 位图，够清）。
  const tiny = slideDisplay(200, 180)
  assert.equal(tiny.width, 640)
  assert.equal(tiny.height, 576)
  assert.equal(tiny.scale, 6)

  // 已够宽的谱面（abc ~770）保持原样；倍率回落到下限 2。
  const wide = slideDisplay(770, 144)
  assert.equal(wide.width, 770)
  assert.equal(wide.height, 144)
  assert.equal(wide.scale, 2)

  // 特大图钳到 1100 防独占。
  const huge = slideDisplay(1600, 900)
  assert.equal(huge.width, 1100)
  assert.equal(huge.height, Math.round(900 * (1100 / 1600)))

  // 竖长图：宽度规则让位给高度钳制（flowchart 230×593 若按宽放大 2.78 倍会到
  // 1650 高——超页高；钳到 820 高后宽 ~318，竖图就该吃纵向空间）。
  const tall = slideDisplay(230, 593)
  assert.equal(tall.height, 820)
  assert.equal(tall.width, Math.round(230 * (820 / 593)))

  // 非法固有尺寸直接 null，让调用方走兜底。
  assert.equal(slideDisplay(0, 100), null)
  assert.equal(slideDisplay(100, -1), null)
})
