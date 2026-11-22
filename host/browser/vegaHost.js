"use strict";

/**
 * vegaHost.js — **浏览器侧**渲染 vega-lite（图表渲染渠道归 host，core 不碰）。
 *
 * 与编辑器同规格（wenlan muya render.ts:311-339）：spec 只认 JSON（编辑器就是
 * JSON.parse，宽松解析是 chart/wavedrom 那一族的待遇），svg 渲染器，tooltip/actions
 * 关掉、ast:true（表达式走解释器，不 eval）。渲染产物是一张纯 SVG（无 foreignObject），
 * 栅格成 PNG 走与 mermaid 同一条路。
 *
 * 运行时三件套（vega → vega-lite → vega-embed，UMD externals 决定顺序）由
 * libAssets 表管理，页面按需注入。
 */

const { rasterizeSvg, svgSize } = require("../../core/render/diagram")

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {number} [opts.scale=2] 栅格倍数（相对 SVG 固有尺寸）
 * @returns {Promise<{dataUrl: string, width?: number, height?: number}>}
 * @throws {Error} 没有运行时 / spec 不是 JSON / 渲染失败 / 栅格空白 —— 一律硬失败
 */
const renderVegaLite = async (block, opts = {}) => {
  const embed = globalThis.vegaEmbed
  if (!embed) {
    throw new Error("页面里没有 vega-lite 运行时（globalThis.vegaEmbed 未定义）——先注入 host/lib/vega.min.js、vega-lite.min.js、vega-embed.min.js（顺序不能反）")
  }

  const text = String(block.source ?? "").trim()
  if (!text) throw new Error("vega-lite 块是空的")
  let spec
  try {
    spec = JSON.parse(text)
  } catch (error) {
    throw new Error(`vega-lite spec 不是合法 JSON：${error.message}`)
  }

  // 离屏容器：不能 display:none（量不到尺寸），挪到屏幕外即可。
  const host = document.createElement("div")
  host.style.cssText = "position:absolute;left:-99999px;top:0;"
  document.body.appendChild(host)

  try {
    // 编辑器同款选项；主题不带（deck 侧没有 vegaTheme 偏好，用 vega 缺省）。
    await embed(host, spec, { actions: false, tooltip: false, renderer: "svg", ast: true })
    const svg = host.querySelector("svg")
    if (!svg) throw new Error("vega-lite 渲染完没有产出 SVG")

    const size = svgSize(svg)
    // fill 缺省白：分派点（index.js）会注入实测的 section 背景色，深色主题位图不再白疤。
    const dataUrl = await rasterizeSvg(svg, opts.scale ?? 2, opts.fill ?? "#ffffff")
    if (!dataUrl) throw new Error("vega-lite SVG 栅格失败：画出来是空白（多半含外链图片/字体）")

    return { dataUrl, width: size?.width, height: size?.height }
  } finally {
    host.remove()
  }
}

module.exports = { renderVegaLite }
