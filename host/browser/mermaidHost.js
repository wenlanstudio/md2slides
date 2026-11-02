"use strict";

/**
 * mermaidHost.js — **浏览器侧**渲染 mermaid（图表渲染渠道归 host，core 不碰）。
 *
 * 住 `host/browser/` 而不是 `e2e/`：渲染器是宿主资产，壳（Typora 插件的 iframe）与
 * e2e（回归）用的是**同一份代码**——mermaid 只在页面里跑得了，两份实现必然漂移，
 * 漂移的后果是「预览什么样，导出就什么样」这条承诺破产。e2e 下的同名文件是转发 shim。
 *
 * 为什么必须栅格成 PNG：与 graphviz 那条路保持一致——都是 `<img>` → IR image 块
 * → media 落盘 → sidecar 插图。中间夹一个裸 SVG 会让落盘出来的 .png 名不副实。
 */

const { rasterizeSvg, svgSize } = require("../../core/render/diagram")

let seq = 0

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {number} [opts.scale=2]        栅格倍数（相对 SVG 固有尺寸）
 * @param {object} [opts.initialize]     追加给 `mermaid.initialize` 的配置
 * @returns {Promise<{dataUrl: string, svg: string, width?: number, height?: number}>}
 * @throws {Error} 没有运行时 / 解析失败 / 栅格失败 —— 一律硬失败，不降级
 */
const renderMermaid = async (block, opts = {}) => {
  const mermaid = globalThis.mermaid
  if (!mermaid?.render) {
    throw new Error("页面里没有 mermaid 运行时（globalThis.mermaid 未定义）——先注入 host/lib/mermaid.min.js")
  }

  // startOnLoad 必须关掉：它会去扫页面里所有 `.mermaid` 元素并就地渲染，
  // 那是编辑器预览的用法，在这儿会和分页抢 DOM。我们要的是 `render()` 直接给回 SVG。
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose", ...(opts.initialize ?? {}) })

  const id = `md2slides-mermaid-${++seq}`
  // v10+ 的 render 是 async，返回 `{ svg, bindFunctions }`；老版本是字符串。两种都兜。
  const out = await mermaid.render(id, block.source)
  const svgText = typeof out === "string" ? out : out?.svg
  if (!svgText) throw new Error("mermaid.render 没返回 svg")

  // 必须是合法 XML：DOMParser 解析失败是**静默**的（只塞一个 <parsererror>），
  // 那样后面拿到的节点高度为 0，物理分页据此做的每个决定都是错的。宁可在这里炸。
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml")
  if (parsed.querySelector("parsererror") || parsed.documentElement.nodeName !== "svg") {
    throw new Error("mermaid 输出的 SVG 解析失败（不是合法 XML）")
  }

  const svgEl = parsed.documentElement
  const size = svgSize(svgEl)
  const dataUrl = await rasterizeSvg(svgEl, opts.scale ?? 2)
  if (!dataUrl) {
    throw new Error("mermaid SVG 栅格失败：画出来是空白，多半含 foreignObject（浏览器不给画）")
  }

  return { dataUrl, svg: svgText, width: size?.width, height: size?.height }
}

module.exports = { renderMermaid }
