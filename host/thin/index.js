"use strict"

/**
 * index.js — 独立薄宿主（A 形态：editor-independent 的 @wenlanstudio/md2slides）。
 *
 * 它自己带上图表渲染器，复用 `core` 那条管线（解析 → 逻辑分页 → 主题 → 物理分页 → IR）。
 * core 一行不改：真正的出图只发生在这里。
 *
 * 所谓"薄"：这里只做「接渲染器 → 喂给 core」，没有编辑器、没有 UI、没有放映层。
 */

/**
 * 薄宿主在 **Node 侧**能渲染的图表类型。
 *
 * mermaid / echarts 是浏览器运行时，Node 侧没有，留给页面那一遍（见 `e2e/pageDiagram.js`）。
 * 注意这不是"降级跳过"：它们只是换了个环境渲染，最后统一由
 * `assertDiagramsRendered()` 兜底，谁都没接手就硬失败。
 */
const NODE_TYPES = ["graphviz", "plantuml"]

const { renderGraphviz } = require("./graphviz")
const { renderPlantuml } = require("./plantuml")

/**
 * @param {{type: string, source: string, lang: string}} block
 * @returns {Promise<{png?: Buffer, dataUrl?: string, svg?: string, width?: number, height?: number}>}
 * @throws {Error} 没有对应渲染器 → 硬失败（图表必须真渲染，不接受占位降级）
 */
const renderDiagram = async block => {
  switch (block.type) {
    case "graphviz":
      return renderGraphviz(block.source)
    case "plantuml":
      return renderPlantuml(block.source)
    default:
      // 铁律：不接受占位降级。渲染不了就明明白白报错，让构建停下来，别拿灰块糊弄。
      throw new Error(`薄宿主还没接 ${block.type} 的渲染器（图表必须真渲染，不接受降级）`)
  }
}

module.exports = { renderDiagram, NODE_TYPES }
