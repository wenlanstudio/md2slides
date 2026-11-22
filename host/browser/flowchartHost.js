"use strict";

/**
 * flowchartHost.js — **浏览器侧**渲染 flowchart.js（图表渲染渠道归 host，core 不碰）。
 *
 * 与编辑器同规格（wenlan muya render.ts:341-345）：`flowchart.parse(code)` →
 * `drawSVG(target, {})`——编辑器对 flowchart 不传任何选项（sequence 才有主题），
 * deck 一样。运行时是 flowchart.js + raphael 闭包的 IIFE（tools/build-diagram-libs.js
 * 从 wenlan 的 muya 依赖产出，同库同版本）。
 *
 * flowchart.js 经 Raphael 同步出 SVG（尺寸写在 width/height 属性上），栅格走
 * 与 mermaid 同一条路。
 */

const { rasterizeSvg, svgSize } = require("../../core/render/diagram")

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {number} [opts.scale=2] 栅格倍数（相对 SVG 固有尺寸）
 * @returns {Promise<{dataUrl: string, width?: number, height?: number}>}
 * @throws {Error} 没有运行时 / DSL 解析失败 / 没产出 SVG / 栅格空白 —— 一律硬失败
 */
const renderFlowchart = async (block, opts = {}) => {
  const flowchart = globalThis.flowchart
  if (!flowchart?.parse) {
    throw new Error("页面里没有 flowchart 运行时（globalThis.flowchart 未定义）——先注入 host/lib/flowchart.min.js")
  }

  const text = String(block.source ?? "").trim()
  if (!text) throw new Error("flowchart 块是空的")
  // 语法错误由 flowchart.js 抛出（带行号），DiagramError 会把源码首行带上。
  const diagram = flowchart.parse(text)

  const host = document.createElement("div")
  host.style.cssText = "position:absolute;left:-99999px;top:0;"
  document.body.appendChild(host)

  try {
    diagram.drawSVG(host, {})
    const svg = host.querySelector("svg")
    if (!svg) throw new Error("flowchart 渲染完没有产出 SVG")

    const size = svgSize(svg)
    const dataUrl = await rasterizeSvg(svg, opts.scale ?? 2, opts.fill ?? "#ffffff")
    if (!dataUrl) throw new Error("flowchart SVG 栅格失败：画出来是空白")

    return { dataUrl, width: size?.width, height: size?.height }
  } finally {
    host.remove()
  }
}

module.exports = { renderFlowchart }
