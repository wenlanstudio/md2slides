"use strict";

/**
 * index.js — **浏览器侧**（页面里）能渲染的图表类型，在这里集中分派。
 *
 * 跟 `host/thin/index.js` 是对称的两半：那边是 Node 侧会的（graphviz 走 `dot` CLI、
 * plantuml 走 `java -jar`），这边是浏览器才有的（mermaid / echarts / vega-lite /
 * flowchart / sequence / wavedrom / chart / abc 是 JS 库，```svg 的栅格要 `Image` +
 * `canvas`，drawio 要真 iframe）。两边都只管自己会的那几种，
 * 最后由 `assertDiagramsRendered()` 兜底。
 *
 * 用户：Typora 壳的 iframe（deck-entry 的页面侧预通行）与 e2e 的页面侧预通行
 * （e2e/pageDiagram.js 是转发 shim）——同一份分派，两个宿主形态。
 */

const { renderMermaid } = require("./mermaidHost")
const { renderEcharts } = require("./echartsHost")
const { renderSvg } = require("./svgHost")
const { renderVegaLite } = require("./vegaHost")
const { renderFlowchart } = require("./flowchartHost")
const { renderSequence } = require("./sequenceHost")
const { renderWavedrom } = require("./wavedromHost")
const { renderChart } = require("./chartHost")
const { renderAbc } = require("./abcHost")
const { renderDrawio } = require("./drawioHost")

// svg 没有第三方运行时，但栅格必须发生在真页面里（jsdom 没有 canvas），故归浏览器侧。
// runner.injectRuntime 的 deferred 里出现 svg 时不需要注入任何 lib。
// 新七类与编辑器（wenlan muya）对齐：vega-lite / flowchart / sequence / wavedrom /
// chart / abc 有各自的 UMD 运行时（host/lib，清单在 libAssets.js），drawio 走
// diagrams.net embed（无本地运行时，见 drawioHost.js）。运行时文件按 deferred 类型
// 由 runner.injectRuntime / deck-full-entry.ensureDiagramLibs 按需注入。
const BROWSER_TYPES = [
  "mermaid",
  "echarts",
  "svg",
  "vega-lite",
  "flowchart",
  "sequence",
  "wavedrom",
  "chart",
  "abc",
  "drawio",
]

/**
 * 宿主位图的底色跟主题走：量当前页面 section 的实测背景（computed backgroundColor 是
 * rgb() 纯色），mermaid / 手写 svg 的栅格与 echarts 的画布都用它——深色主题（sunset
 * #1a1233）的图表位图不再带一块白疤（2026-11-22 视觉验收抓出），浅色主题量出白与
 * 旧版逐字节一致。量不到 section（游离 DOM / 预通行过早）或背景是渐变/透明时回退
 * #ffffff：echarts 透明底会在 PPTX 里发灰，宁可白底卡片也不给透明。
 */
const slideFill = () => {
  try {
    const section = document.querySelector("section")
    if (!section) return "#ffffff"
    const bg = getComputedStyle(section).backgroundColor
    return bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" ? bg : "#ffffff"
  } catch {
    return "#ffffff"
  }
}

/**
 * @param {{type: string, source: string}} block
 * @throws {Error} 类型不认识 —— 硬失败，不接受降级
 */
const renderDiagram = (block, opts = {}) => {
  // 宿主显式传入的 fill/background 优先（作者知道自己在干什么）；没传才用实测底色。
  const fill = opts.fill ?? slideFill()
  switch (block.type) {
    case "mermaid":
      return renderMermaid(block, { ...opts, fill })
    case "echarts":
      return renderEcharts(block, { ...opts, background: opts.background ?? fill })
    case "svg":
      return renderSvg(block, { ...opts, fill })
    case "vega-lite":
      return renderVegaLite(block, { ...opts, fill })
    case "flowchart":
      return renderFlowchart(block, { ...opts, fill })
    case "sequence":
      return renderSequence(block, { ...opts, fill })
    case "wavedrom":
      return renderWavedrom(block, { ...opts, fill })
    case "chart":
      return renderChart(block, { ...opts, background: opts.background ?? fill })
    case "abc":
      return renderAbc(block, { ...opts, fill })
    case "drawio":
      // drawio 的位图底色由 embed 导出决定（通常自带白底），fill 不硬塞。
      return renderDrawio(block, opts)
    default:
      throw new Error(`页面侧也没有 ${block.type} 的渲染器（图表必须真渲染，不接受降级）`)
  }
}

module.exports = { renderDiagram, BROWSER_TYPES }
