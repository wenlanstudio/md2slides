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
 * @returns {Promise<string|null>} PNG data URL, or null when the raster came out blank
 */
const rasterizeSvg = (svg, scale) => new Promise(resolve => {
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
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    if (isBlank(ctx, canvas)) {
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

/** A diagram that drew nothing is worse than no rasterization at all, so detect it. */
const isBlank = (ctx, canvas) => {
  if (!canvas.width || !canvas.height) return true
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const stride = 4 * 37 // sample sparsely; an actual diagram leaves far more than 0.05% ink
  let total = 0
  let ink = 0
  for (let i = 0; i < data.length; i += stride) {
    total += 1
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ink += 1
  }
  return total > 0 && ink / total < 0.0005
}

module.exports = { svgSize, fitBox, rasterizeSvg }
