"use strict";

/**
 * abcHost.js — **浏览器侧**渲染 abc（abcjs，乐谱/简谱记谱）。
 *
 * 与编辑器同规格（wenlan muya render.ts:431-436）：块配置头（BlockCodeConfig）
 * 用 parseDiagramBlock 拎出展示选项，正文交给 `renderAbc`；编辑器给
 * `{responsive: 'resize'}`（svg 铺满容器跟随缩放），deck 给固定容器让 abcjs 出
 * 自然谱宽——位图尺寸稳定，分页量得准。
 *
 * 一个围栏多支曲子时 abcjs 会落不止一张 SVG：单张走与 mermaid 同款的
 * rasterizeSvg；多张把整个容器经 html-to-image 一次性 compose 成 PNG（两页之间
 * 不该被拆开的两张谱面，栅格后仍是一张图）。html-to-image 在两种宿主形态里都
 * 随管线常驻（deck-full bundle / e2e 注入），缺了就是环境残缺，硬失败。
 */

const { rasterizeSvg, svgSize } = require("../../core/render/diagram")
const { parseDiagramBlock, pixelSize } = require("../../core/render/blockSource")

const DEFAULT_WIDTH = 720

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {number} [opts.scale=2] 栅格倍数（相对 SVG 固有尺寸）
 * @returns {Promise<{dataUrl: string, width?: number, height?: number}>}
 * @throws {Error} 没有运行时 / 空围栏 / 没产出 SVG / 栅格失败 —— 一律硬失败
 */
const renderAbc = async (block, opts = {}) => {
  // abcjs 的 UMD 挂大写的 `ABCJS`（v6 官方发行版如此），容个旧键。
  const abcjs = globalThis.ABCJS ?? globalThis.abcjs
  if (!abcjs?.renderAbc) {
    throw new Error("页面里没有 abc 运行时（globalThis.ABCJS 未定义）——先注入 host/lib/abcjs-basic-min.js")
  }

  const { options, body } = parseDiagramBlock(block.source)
  if (!body) throw new Error("abc 块是空的")

  const host = document.createElement("div")
  host.style.cssText =
    `position:absolute;left:-99999px;top:0;width:${pixelSize(options.width) ?? DEFAULT_WIDTH}px;`
  document.body.appendChild(host)

  try {
    abcjs.renderAbc(host, body, {})
    const svgs = [...host.querySelectorAll("svg")]
    if (!svgs.length) throw new Error("abc 渲染完没有产出 SVG（记谱语法错了？）")

    if (svgs.length === 1) {
      const size = svgSize(svgs[0])
      const dataUrl = await rasterizeSvg(svgs[0], opts.scale ?? 2, opts.fill ?? "#ffffff")
      if (!dataUrl) throw new Error("abc SVG 栅格失败：画出来是空白")
      return { dataUrl, width: size?.width, height: size?.height }
    }

    // 多支曲子：整容器 compose（html-to-image 的 pixelRatio 与单张栅格的 scale 对齐）。
    if (!globalThis.htmlToImage?.toPng) {
      throw new Error("页面里没有 html-to-image（栅格 abc 多谱面要用）——两种宿主形态都应随管线注入")
    }
    const dataUrl = await globalThis.htmlToImage.toPng(host, { pixelRatio: opts.scale ?? 2 })
    if (!dataUrl) throw new Error("abc 多谱面 compose 失败")
    const first = svgSize(svgs[0])
    // 显示尺寸取第一张谱面的固有宽度 × 张数方向的容器实测——按容器实测最稳。
    const box = host.getBoundingClientRect()
    return { dataUrl, width: box.width || first?.width, height: box.height || first?.height }
  } finally {
    host.remove()
  }
}

module.exports = { renderAbc, DEFAULT_WIDTH }
