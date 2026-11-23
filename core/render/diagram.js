/**
 * Rasterize the diagram SVGs that Typora has already rendered into PNG data URLs.
 *
 * Why PNG instead of injecting the live SVG (what this plugin used to do):
 *  - an SVG carries Typora's on-screen pixel size, so on a 1920x1080 slide it renders tiny;
 *  - mermaid/graphviz SVGs mix `width="100%"` with a fixed `height`, so once marp puts them
 *    inside a `foreignObject` the aspect ratio distorts and labels spill out of their boxes;
 *  - a self-contained bitmap removes every dependency on Typora's stylesheet, so preview and
 *    the exported PPTX agree.
 * This matches the offline toolchain, where `build.py` renders diagrams with `dot -Tpng -Gdpi=192`.
 *
 * `rasterizeSvg` resolves `null` (never throws) when the SVG cannot be rasterized — notably
 * when it contains `<foreignObject>`, which Chrome refuses to paint for an SVG loaded as an
 * image. Callers fall back to the live SVG so a diagram is never silently lost.
 */

const XMLNS = "http://www.w3.org/2000/svg"

/** Intrinsic size: prefer viewBox, then width/height attributes, then the laid-out box. */
const svgSize = svg => {
  const viewBox = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number)
  if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] }
  }
  const width = Number.parseFloat(svg.getAttribute("width"))
  const height = Number.parseFloat(svg.getAttribute("height"))
  if (width > 0 && height > 0) return { width, height }
  const rect = svg.getBoundingClientRect()
  return { width: rect.width || 300, height: rect.height || 150 }
}

/**
 * Largest box with the source aspect ratio that still fits inside `boxW` x `boxH`.
 * `maxUpscale` caps how far a diagram may be magnified when it is smaller than the box:
 * 1 means "never enlarge, only shrink to fit" so a small graph keeps its natural size.
 */
const fitBox = (size, boxW, boxH, maxUpscale = Infinity) => {
  const ratio = Math.min(boxW / size.width, boxH / size.height, maxUpscale)
  return { width: size.width * ratio, height: size.height * ratio }
}

/**
 * slideDisplay — 幻灯片媒介上的显示尺寸规则（新七类 SVG 图表用）。
 *
 * 编辑器里的「固有尺寸」是网页媒介的语义（vega-lite 缺省画布宽只有 200px，
 * flowchart.js 跟着内容走），直接 1x 搬上 1920×1080 的幻灯片只占 10–30% 宽，
 * 教室后排根本读不了（2026-11-23 视觉验收抓出「映视图都偏矮」）。svgHost 的既有
 * 立场是「固有尺寸不是幻灯片显示尺寸」（viewBox ×2 显示），这里把它推广成一条
 * 可测试的规则：
 *
 *   显示宽 = clamp(固有宽, 640, 1100)——小图放大到可读下限（640 ≈ 33% 页宽），
 *   大图钳到 1100（≈57% 页宽，防独占）；高度等比，但**钳在 maxHeight（缺省 820）内**
 *   ——竖长图（flowchart 230×593 这种）按宽放大会把高度顶过页高，宽度规则让位给高度。
 *   栅格倍率自适应：位图 ≥ 2× 显示像素（retina 级清晰），上限 6（矢量栅格很便宜）。
 *
 * 作者显式声明的尺寸不走这条规则（vega spec 写了数值 width、chart 写了 @width）——
 * 声明就是意图，按声明显示。
 *
 * @returns {{width: number, height: number, scale: number}|null} 固有尺寸非法时 null
 */
const slideDisplay = (
  width,
  height,
  { min = 640, max = 1100, maxHeight = 820, density = 2, maxScale = 6 } = {},
) => {
  if (!(width > 0) || !(height > 0)) return null
  let ratio = Math.min(max, Math.max(min, width)) / width
  if (height * ratio > maxHeight) ratio = maxHeight / height
  const scale = Math.min(maxScale, Math.max(2, Math.ceil(ratio * density)))
  return { width: Math.round(width * ratio), height: Math.round(height * ratio), scale }
}

/**
 * PlantUML 会往 SVG 里写 `<!--?plantuml-src …-->` 注释，注释内容里带 `--`。
 * XML 注释不允许出现连续两个连字符，于是整个 SVG **不是合法 XML**——Chrome 会拒绝把它当作
 * 图片加载（`image.onerror`），表现为：这张图退化成内联 SVG 留在 deck 里；更糟的是它还会
 * 拖挂整页栅格（html-to-image 把整页包进 SVG 后同样解析失败），让整次图片型导出全盘失败。
 * 注释只是元数据（版本号、源码哈希），去掉它不影响画面。
 */
function stripComments(root) {
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) {
        node.removeChild(child)
        continue
      }
      if (child.nodeType === 1) walk(child)
    }
  }
  walk(root)
}

/**
 * @param {SVGElement} svg a rendered diagram
 * @param {number} scale raster scale relative to the SVG's intrinsic size
 * @param {string} [fill="#ffffff"] 位图底色。深色主题（sunset）传实测的 section 背景，
 *   图表位图不再带白疤；浅色主题量出来就是白，与旧版逐字节一致。
 * @returns {Promise<string|null>} PNG data URL, or null when the raster came out blank
 */
const rasterizeSvg = (svg, scale, fill = "#ffffff") => new Promise(resolve => {
  const { width, height } = svgSize(svg)
  const clone = svg.cloneNode(true)
  clone.setAttribute("xmlns", XMLNS)
  stripComments(clone)
  // An SVG used as an image needs explicit dimensions or it falls back to 300x150.
  clone.setAttribute("width", width)
  clone.setAttribute("height", height)

  const image = new Image()
  image.onload = () => {
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext("2d")
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    if (isBlank(ctx, canvas, fill)) {
      console.warn("[md2slides] diagram rasterized blank (foreignObject?), falling back to SVG")
      resolve(null)
      return
    }
    resolve(canvas.toDataURL("image/png"))
  }
  image.onerror = () => {
    console.warn("[md2slides] diagram SVG could not be loaded as an image, falling back to SVG")
    resolve(null)
  }
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone))
})

/** fill 的 RGB 通道：收 #rgb/#rrggbb 与 rgb()/rgba()，解析不了按白处理。 */
const fillChannels = fill => {
  const text = String(fill ?? "#ffffff")
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text)
  if (rgb) {
    const parts = rgb[1].split(/[\s,]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) return parts.slice(0, 3)
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1]
    return [0, 2, 4].map(i => Number.parseInt(digits.slice(i, i + 2), 16))
  }
  return [255, 255, 255]
}

/** A diagram that drew nothing is worse than no rasterization at all, so detect it.
 *  「墨水」= 与底色偏离的像素：白底时等价于旧的 `通道 < 245`（255-245=10），深底
 *  同样成立——底就是参照系，整张画布只会因为真的画了东西才偏离底色。 */
const isBlank = (ctx, canvas, fill = "#ffffff") => {
  const [fr, fg, fb] = fillChannels(fill)
  if (!canvas.width || !canvas.height) return true
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const stride = 4 * 37 // sample sparsely; an actual diagram leaves far more than 0.05% ink
  let total = 0
  let ink = 0
  for (let i = 0; i < data.length; i += stride) {
    total += 1
    if (
      Math.abs(data[i] - fr) > 10 ||
      Math.abs(data[i + 1] - fg) > 10 ||
      Math.abs(data[i + 2] - fb) > 10
    ) ink += 1
  }
  return total > 0 && ink / total < 0.0005
}

module.exports = { svgSize, fitBox, slideDisplay, rasterizeSvg, fillChannels }
