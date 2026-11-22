"use strict";

/**
 * sequenceHost.js — **浏览器侧**渲染 sequence（js-sequence-diagrams，手绘/简洁两主题）。
 *
 * 与编辑器同库同版本：muya 把 js-sequence-diagrams（bramp, BSD-2）vendor 成 snap.svg
 * 渲染版（sequence-diagram-snap.js），本运行时由 tools/build-diagram-libs.js 从那份
 * 源打包成 IIFE 挂 `globalThis.SequenceDiagram`。主题缺省 `hand`——与文览偏好缺省
 * （sequenceTheme: 'hand'）一致。
 *
 * hand 主题用 danielbd 手写字体：drawSVG 内部经 webfontloader 等字体就绪后才落 SVG，
 * 所以这里必须先注入 @font-face（字体文件在 lib/sequence-fonts/，URL 走
 * `window.__md2slides_assetBase`——pack 形态是包根、e2e 是 /host/lib/），再轮询等
 * SVG 真正出现（drawSVG 是主题回调式的，不返回 Promise）。字体取不到时
 * webfontloader 的 inactive 分支放行、退回等宽字体，图不会缺。
 */

const { rasterizeSvg, svgSize } = require("../../core/render/diagram")

const FONT_FAMILY = "danielbd"
const WAIT_TIMEOUT_MS = 8000
const WAIT_INTERVAL_MS = 50

let fontInjected = false

/** danielbd 的 @font-face：一处注入，整页生命周期有效。 */
const injectFontFace = () => {
  if (fontInjected) return
  const base = String(globalThis.__md2slides_assetBase ?? "")
  const style = document.createElement("style")
  style.textContent = [
    `@font-face {`,
    `  font-family: ${FONT_FAMILY};`,
    `  src: url('${base}sequence-fonts/danielbd.woff2') format('woff2'),`,
    `       url('${base}sequence-fonts/danielbd.woff') format('woff');`,
    `  font-weight: normal;`,
    `  font-style: normal;`,
    `}`,
  ].join("\n")
  document.head.appendChild(style)
  fontInjected = true
}

/** drawSVG 是回调式的：轮询到容器里出现带尺寸的 SVG 为止（字体就绪才会落）。 */
const waitForSvg = async container => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const svg = container.querySelector("svg")
    if (svg && (svg.getAttribute("width") || svg.getAttribute("viewBox"))) return svg
    await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL_MS))
  }
  return null
}

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {string} [opts.theme="hand"]    hand（手绘）/ simple（简洁）
 * @param {number} [opts.scale=2]         栅格倍数（相对 SVG 固有尺寸）
 * @returns {Promise<{dataUrl: string, width?: number, height?: number}>}
 * @throws {Error} 没有运行时 / DSL 解析失败 / 超时没产出 SVG / 栅格空白 —— 一律硬失败
 */
const renderSequence = async (block, opts = {}) => {
  const Diagram = globalThis.SequenceDiagram?.Diagram
  if (!Diagram?.parse) {
    throw new Error("页面里没有 sequence 运行时（globalThis.SequenceDiagram 未定义）——先注入 host/lib/sequence.min.js")
  }

  const text = String(block.source ?? "").trim()
  if (!text) throw new Error("sequence 块是空的")
  const diagram = Diagram.parse(text)

  const host = document.createElement("div")
  host.style.cssText = "position:absolute;left:-99999px;top:0;"
  document.body.appendChild(host)

  try {
    injectFontFace()
    // 编辑器对 sequence 只传主题（render.ts:320-322），deck 同款；hand 是文览的缺省。
    diagram.drawSVG(host, { theme: opts.theme ?? "hand" })
    const svg = await waitForSvg(host)
    if (!svg) {
      throw new Error(`sequence ${WAIT_TIMEOUT_MS}ms 内没画出 SVG（字体就绪等待超时）`)
    }

    const size = svgSize(svg)
    const dataUrl = await rasterizeSvg(svg, opts.scale ?? 2, opts.fill ?? "#ffffff")
    if (!dataUrl) throw new Error("sequence SVG 栅格失败：画出来是空白")

    return { dataUrl, width: size?.width, height: size?.height }
  } finally {
    host.remove()
  }
}

module.exports = { renderSequence, injectFontFace }
