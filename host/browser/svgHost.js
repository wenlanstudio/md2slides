"use strict";

/**
 * svgHost.js — **浏览器侧**渲染 ```svg 围栏：把作者手写的 SVG 源码栅格成 PNG。
 *
 * 这是「md 里怎么放矢量图」的正式答案，与上一轮讨论的三条断链一一对应：
 *   · md 里只有可读的 SVG 文本，不是几百行内联 XML 混在正文里（diff / 编辑器 / 块身份都干净）；
 *   · 预通行结束时围栏已换成 `<img class="md2slides-diagram">`，分页把它当**图片核心**保护，
 *     `fitImagesInPlace` 会等比缩放，lightbox 点得开，步进高亮框套得上；
 *   · 落到 IR 的是 PNG data URL → media 落盘 .png → python-pptx `add_picture` 认得，
 *     两种 PPTX 导出都通。离线单文件 HTML 也天然自带（data URL，不依赖相对路径）。
 *
 * 为什么归 `host/browser` 而不是 core：栅格要用 `Image` + `canvas`，jsdom 没有。
 * 与 mermaid / echarts 同属浏览器运行时，由 `BROWSER_TYPES` 分派，最后统一过
 * `assertDiagramsRendered()` 闸门。core 依旧一行渲染代码都不碰。
 *
 * 安全：SVG 是作为 `<img>` 的 data URL 加载的（Chrome 的 secure static mode），
 * 不执行脚本、不加载外部资源——但这也意味着 `<foreignObject>`、外链图片、外部字体
 * 画不出来，所以对这几样直接给硬失败 + 人话，不做静默降级。
 */

const { rasterizeSvg } = require("../../core/render/diagram")

const XMLNS = "http://www.w3.org/2000/svg"
const RE_SVG_START = /<svg\b/i
const RE_VIEWBOX = /\bviewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*["']/i
const RE_WIDTH = /\bwidth\s*=\s*["']([^"']+)["']/i
const RE_HEIGHT = /\bheight\s*=\s*["']([^"']+)["']/i
const RE_COMMENT = /<!--[\s\S]*?-->/g

/** 只认无单位或 px 的数值；`100%` / `10cm` / `2em` 在幻灯片里没有可量的基准，一律不认。 */
const pxOf = value => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(String(value ?? ""))
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 取 `<svg …>` 开标签原文。
 *
 * 不能用 `/<svg[^>]*>/` 一刀切：从编辑器导出的 SVG 常带
 * `aria-label="a > b"` 这类属性，引号里的 `>` 会把正则截在半路，
 * 排在后面的 viewBox 就读不到了。这里手动跳过引号再找真正的收尾 `>`。
 */
const svgOpenTag = source => {
  const text = String(source ?? "")
  const start = RE_SVG_START.exec(text)?.index ?? -1
  if (start < 0) return ""
  let quote = ""
  for (let i = start + 4; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ""
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ">") {
      return text.slice(start, i + 1)
    }
  }
  return ""
}

/**
 * 从 `<svg>` 开标签里读固有尺寸（纯字符串，Node 侧也能跑，便于单测）。
 *
 * 优先 viewBox：从 Illustrator / 在线工具导出的 SVG 常写 `width="100%" height="100%"`，
 * 只有 viewBox 才是真正的画面坐标系。没有 viewBox 时接受数值 width/height。
 * 两者都没有就返回 null —— 让调用方硬失败，绝不猜一个 300×150 糊过去。
 *
 * @returns {{width: number, height: number, from: "viewBox"|"width/height"}|null}
 */
const svgIntrinsicSize = source => {
  const open = svgOpenTag(source)
  if (!open) return null
  const vb = RE_VIEWBOX.exec(open)
  if (vb) {
    const width = Number(vb[3])
    const height = Number(vb[4])
    if (width > 0 && height > 0) return { width, height, from: "viewBox" }
  }
  const width = pxOf(RE_WIDTH.exec(open)?.[1])
  const height = pxOf(RE_HEIGHT.exec(open)?.[1])
  return width && height ? { width, height, from: "width/height" } : null
}

/**
 * 剥掉 XML 注释。
 *
 * PlantUML 会往 SVG 里写 `<!--?plantuml-src …-->`，注释内容里带 `--`，
 * 而 XML 注释不允许连续两个连字符 ⇒ 整个 SVG 不是合法 XML。DOMParser 会
 * 直接拒绝，`rasterizeSvg` 更下游的 stripComments 根本没机会跑。注释只是
 * 元数据（版本号、源码哈希），去掉不影响画面。见 core/render/diagram.js:43。
 */
const stripSvgComments = source => String(source ?? "").replace(RE_COMMENT, "")

/** 严格 XML 解析；DOMParser 失败是静默的（塞 <parsererror>），必须显式验根。 */
const parseSvgDocument = text => {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml")
  const root = doc?.documentElement
  const ok = !!root && root.nodeName === "svg" && !doc.querySelector("parsererror")
  return { doc, root, ok }
}

/**
 * @param {{type: string, source: string}} block
 * @param {{scale?: number}} [opts] scale = 栅格倍率，默认 2（与 mermaid 一致， retina 清晰）
 * @returns {Promise<{dataUrl: string, width: number, height: number}>}
 * @throws {Error} 空围栏 / 非 SVG / 缺尺寸 / 非法 XML / foreignObject / 栅格空白 —— 一律硬失败
 */
const renderSvg = async (block, opts = {}) => {
  const source = String(block?.source ?? "").trim()
  if (!source) throw new Error("svg 围栏是空的：请在围栏里放完整的 <svg>…</svg>")
  if (!svgOpenTag(source)) {
    throw new Error('svg 围栏里要放完整的 <svg viewBox="0 0 宽 高">…</svg>，不接受 SVG 片段或外链路径')
  }

  const size = svgIntrinsicSize(source)
  if (!size) {
    throw new Error(
      'svg 围栏量不出尺寸：请给 <svg> 写 viewBox="0 0 宽 高"（推荐），或写数值 width/height。' +
        'width="100%" 这类百分比在幻灯片里没有可量的基准。',
    )
  }

  // 先严格解析；失败且源码含注释时，剥掉注释再试一次（PlantUML 那个坑）。
  let parsed = parseSvgDocument(source)
  if (!parsed.ok && source.includes("<!--")) {
    parsed = parseSvgDocument(stripSvgComments(source))
  }
  if (!parsed.ok) {
    throw new Error(
      "svg 围栏不是合法 XML：检查标签是否闭合、属性引号是否成对、" +
        "& 是否写成 &amp;（HTML 实体 &nbsp; 在 XML 里未定义，要写 &#160;）。",
    )
  }

  const svg = parsed.root
  // 手写 SVG 常漏 xmlns；作为 <img src="data:image/svg+xml,…"> 加载时它是必需的。
  svg.setAttribute("xmlns", XMLNS)
  // 覆盖百分比 width/height：rasterizeSvg 需要显式数值，否则回退成 300×150。
  svg.setAttribute("width", String(size.width))
  svg.setAttribute("height", String(size.height))

  if (svg.getElementsByTagName("foreignObject").length > 0) {
    throw new Error(
      "svg 围栏含 <foreignObject>：浏览器不绘制塞进 <img> 的 foreignObject（画出来是空白）。" +
        "请改用纯 SVG 图元 / <text>，或先导出成 PNG 用 ![](x.png)。",
    )
  }

  const dataUrl = await rasterizeSvg(svg, opts.scale ?? 2)
  if (!dataUrl) {
    throw new Error(
      "SVG 栅格出来是空白：多半用了外链图片、外部字体或 foreignObject（SVG-as-image 不加载外部资源）。" +
        "请把素材内嵌或先导出成 PNG 用 ![](x.png)。",
    )
  }

  return { dataUrl, width: size.width, height: size.height }
}

module.exports = { renderSvg, svgIntrinsicSize, svgOpenTag, stripSvgComments, pxOf }
