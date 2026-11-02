"use strict";

/**
 * index.js — **浏览器侧**（页面里）能渲染的图表类型，在这里集中分派。
 *
 * 跟 `host/thin/index.js` 是对称的两半：那边是 Node 侧会的（graphviz 走 `dot` CLI、
 * plantuml 走 `java -jar`），这边是浏览器才有的（mermaid、echarts 都是 JS 库）。
 * 两边都只管自己会的那几种，最后由 `assertDiagramsRendered()` 兜底。
 *
 * 用户：Typora 壳的 iframe（deck-entry 的页面侧预通行）与 e2e 的页面侧预通行
 * （e2e/pageDiagram.js 是转发 shim）——同一份分派，两个宿主形态。
 */

const { renderMermaid } = require("./mermaidHost")
const { renderEcharts } = require("./echartsHost")

const BROWSER_TYPES = ["mermaid", "echarts"]

/**
 * @param {{type: string, source: string}} block
 * @throws {Error} 类型不认识 —— 硬失败，不接受降级
 */
const renderDiagram = (block, opts = {}) => {
  switch (block.type) {
    case "mermaid":
      return renderMermaid(block, opts)
    case "echarts":
      return renderEcharts(block, opts)
    default:
      throw new Error(`页面侧也没有 ${block.type} 的渲染器（图表必须真渲染，不接受降级）`)
  }
}

module.exports = { renderDiagram, BROWSER_TYPES }
