"use strict";

/**
 * wavedromHost.js — **浏览器侧**渲染 wavedrom（数字波形/时序图）。
 *
 * 与编辑器同规格（wenlan muya render.ts:406-424）：块配置走 parseJsonBlock
 * （BlockCodeConfig 头 + 宽松 JSON，core/render/blockSource.js 是那份规则的移植），
 * `renderAny(0, value, waveSkin)` 产出 ONML 树再 stringify 成标记——muya 注释里
 * 点名的坑在这里同样要躲：`renderWaveForm` 走 document 全局 id 查找，同页两张
 * 波形图会互相顶；renderAny+stringify 是纯函数式的，无此竞态。
 *
 * 运行时是 wavedrom 的 unpkg UMD（globalThis.wavedrom，含 renderAny/waveSkin/onml）。
 */

const { rasterizeSvg, svgSize, slideDisplay } = require("../../core/render/diagram")
const { parseJsonBlock } = require("../../core/render/blockSource")

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {number} [opts.scale=2] 栅格倍数（相对 SVG 固有尺寸）
 * @returns {Promise<{dataUrl: string, width?: number, height?: number}>}
 * @throws {Error} 没有运行时 / 配置解析失败 / 没产出 SVG / 栅格空白 —— 一律硬失败
 */
const renderWavedrom = async (block, opts = {}) => {
  const wavedrom = globalThis.wavedrom
  if (!wavedrom?.renderAny) {
    throw new Error("页面里没有 wavedrom 运行时（globalThis.wavedrom 未定义）——先注入 host/lib/wavedrom.min.js")
  }

  let value
  try {
    ;({ value } = parseJsonBlock(block.source))
  } catch (error) {
    throw new Error(`wavedrom 配置解析失败（JSON，容忍块配置头/注释/尾逗号）：${error.message}`)
  }

  const host = document.createElement("div")
  host.style.cssText = "position:absolute;left:-99999px;top:0;"
  document.body.appendChild(host)

  try {
    const onml = wavedrom.renderAny(0, value, wavedrom.waveSkin)
    host.innerHTML = wavedrom.onml.stringify(onml)
    const svg = host.querySelector("svg")
    if (!svg) throw new Error("wavedrom 渲染完没有产出 SVG")

    // 显示尺寸走 slideDisplay：波形图固有宽（~350px 级）1x 上幻灯片偏小。
    const size = svgSize(svg)
    const box = slideDisplay(size.width, size.height)
    const scale = opts.scale ?? box?.scale ?? 2
    const dataUrl = await rasterizeSvg(svg, scale, opts.fill ?? "#ffffff")
    if (!dataUrl) throw new Error("wavedrom SVG 栅格失败：画出来是空白")

    return { dataUrl, width: box?.width ?? size?.width, height: box?.height ?? size?.height }
  } finally {
    host.remove()
  }
}

module.exports = { renderWavedrom }
