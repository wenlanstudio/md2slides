"use strict"

/**
 * diagramHost.js — 图表预通行：**core 调度，host 渲染**。
 *
 * 三条铁律（见 README「架构铁律」）：
 *
 *  1. **core 不渲染任何图表**（mermaid / echarts / plantuml / graphviz 一个都不碰）。
 *     它只做「认出图表块 → 问宿主要图 → 把图塞回 DOM」这三件事，出图的是宿主。
 *  2. **预通行必须发生在物理分页实测之前**。IR 的几何是 `getBoundingClientRect()` 量出来的，
 *     图表那一刻已经是带真实尺寸的 DOM 节点，几何才可信；晚一步量到的就是 0 或错值。
 *  3. **不接受缺图降级**。宿主没给钩子 / 返回空 / 渲染抛错 → 直接抛 `DiagramError`，
 *     构建中止，绝不拿占位块糊弄，也绝不把 0 尺寸的块喂给 IR。
 *
 * 本模块不碰 Node 专有 API，所以浏览器里也能跑（会被 `e2e/bundle.js` 原样搬进页面）。
 */

/** 围栏语言 → 图表类型。认不出的语言不是图表，原样当代码块处理。 */
const DIAGRAM_TYPES = {
  mermaid: "mermaid",
  dot: "graphviz",
  graphviz: "graphviz",
  gv: "graphviz",
  plantuml: "plantuml",
  puml: "plantuml",
  echarts: "echarts",
  // svg 是作者手写的完整 <svg> 源码：浏览器侧栅格成 PNG（见 host/browser/svgHost）。
  // 不是"把 SVG 塞进 deck"——预通行结束时它已经是 <img>，与其余图表同一份位图契约。
  svg: "svg",
  // matplotlib 不是浏览器运行时：core 只认类型，真出图由宿主 spawn Python（见 host/thin）。
  matplotlib: "matplotlib",
}

/**
 * 图表位图缓存（进程/页面内）。key = `${type} ${source}`。
 * 仅缓存成功出位的位图结果；defer 的块不缓存。
 *
 * 注意：diagramHost 在浏览器 page 内运行，engine 每次 render 新建 page，
 * 故本缓存在跨 render（反复放映）间不生效——跨放映秒开由 engine 整 deck
 * 层（render.js 的 deckCache）保证。此处缓存服务于单次 render 内多遍
 * only 调度复用，且不依赖任何 Node 专有 API（浏览器侧也可用）。
 */
const diagramCache = new Map()
const DIAGRAM_CACHE_MAX = 600
const diagramCacheKey = (type, source) => `${type} ${source}`
function diagramCacheGet(type, source) {
  const k = diagramCacheKey(type, source)
  const v = diagramCache.get(k)
  if (v) {
    diagramCache.delete(k)
    diagramCache.set(k, v) // 最近使用移到末尾（简易 LRU）
  }
  return v
}
function diagramCacheSet(type, source, payload) {
  const k = diagramCacheKey(type, source)
  if (diagramCache.has(k)) diagramCache.delete(k)
  diagramCache.set(k, payload)
  while (diagramCache.size > DIAGRAM_CACHE_MAX) {
    const oldest = diagramCache.keys().next().value
    if (oldest == null) break
    diagramCache.delete(oldest)
  }
}
function clearDiagramCache() {
  diagramCache.clear()
}

/** 图表渲染的硬失败。带 type / source，好让报错直接指到是哪一块图。 */
class DiagramError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = "DiagramError"
    this.type = detail.type
    this.source = detail.source
  }
}

const RE_LANG = /(?:^|\s)language-([\w+#.-]+)/

/** `<code class="language-x">` → `x`（小写）。 */
const langOf = el => {
  const m = RE_LANG.exec(el?.getAttribute?.("class") ?? "")
  return m ? m[1].toLowerCase() : ""
}

/** 这个 `<code>` 是不是图表围栏；是则返回图表类型，否则 null。 */
const typeOfBlock = code => DIAGRAM_TYPES[langOf(code)] ?? null

const firstLine = s => String(s ?? "").split("\n").find(l => l.trim())?.slice(0, 80) ?? ""

/**
 * 找出文档里所有**还没渲染**的图表块。
 *
 * markdown-it 把 ```dot 渲染成 `<pre><code class="language-dot">`，所以认 `pre > code`。
 * 已经渲染过的会被换成 `<img>`，自然不再出现在这里——这也是"渲染后不重复处理"的保证。
 */
const chartBlocksOf = root => {
  const scope = root?.querySelectorAll ? root : (root?.body ?? root)
  if (!scope?.querySelectorAll) return []
  const out = []
  for (const code of scope.querySelectorAll("pre > code")) {
    const type = typeOfBlock(code)
    if (!type) continue
    out.push({
      pre: code.parentElement,
      code,
      lang: langOf(code),
      type,
      source: code.textContent ?? "",
    })
  }
  return out
}

/**
 * 把宿主渲染好的图塞进 DOM，替换掉原来的 `<pre>`。
 *
 * 用 `<img>` 而不是内联 `<svg>`：`ir.js` 见到 `IMG` 直接出 image 块（data URL → media
 * 落盘 → sidecar 插图）；内联 SVG 要先栅格，栅格失败还会退化成 `custom` 被 sidecar 跳过。
 *
 * `max-width:100%` + `height:auto` = **只缩不放**，量到的高度就是真正会画出来的高度，
 * 于是物理分页据此做的每个决定都是对的。
 */
const injectDiagram = (doc, pre, { type, png, dataUrl, width, height }) => {
  const src = dataUrl ?? (png ? `data:image/png;base64,${png}` : null)
  const img = doc.createElement("img")
  img.className = "md2slides-diagram"
  img.setAttribute("data-diagram", type ?? "unknown")
  // 源码行号跟着块走：围栏换成了图，「点击页跳源码行」仍要能定位到图的源码
  for (const name of ["data-src-start", "data-src-end"]) {
    const value = pre.getAttribute?.(name)
    if (value) img.setAttribute(name, value)
  }
  if (src) img.setAttribute("src", src)
  if (width > 0) img.setAttribute("width", String(Math.round(width)))
  if (height > 0) img.setAttribute("height", String(Math.round(height)))
  img.style.maxWidth = "100%"
  img.style.height = "auto"
  pre.replaceWith(img)
  return img
}

/**
 * 等几帧让布局稳定。
 *
 * 异步渲染的图表（mermaid / echarts）要等它们把画布画完，否则量到的是空节点的高度。
 * Node 侧（jsdom 没开 pretendToBeVisual）没有 rAF，直接跳过——那边本来也没有布局。
 */
const settle = async (doc, frames = 2) => {
  const view = doc?.defaultView
  const raf = view?.requestAnimationFrame
  if (typeof raf !== "function") return
  for (let i = 0; i < frames; i++) {
    await new Promise(resolve => raf.call(view, () => resolve()))
  }
}

/**
 * 图表预通行：跑在**物理分页实测之前**。
 *
 * 分环境跑多遍是常态：graphviz 是 CLI，只能在 Node 侧渲染；mermaid 是浏览器运行时，
 * 只能在页面里渲染。给 `only` 就能让这一遍只管自己会的那几种，其余留给下一遍；
 * 钩子返回 `{defer: true}` 是**块级**版的"留给下一遍"——同类型的不同块归宿不同时
 * （如 mermaid：Typora 画出了 panel 的父侧收割，没 panel 的留给页面兜底）只有它表达得了。
 * 最后统一由 `assertDiagramsRendered()` 把关——谁都没接手的就是硬失败。
 *
 * @param {Document} doc   compose 产出的文档（浏览器里就是当前 document）
 * @param {object}  [opts]
 * @param {Function}[opts.renderDiagram] 宿主注入的渲染器 `(block) => {dataUrl|png}`；
 *        返回 `{defer: true}` = 这一遍不接这块，原样留着给下一遍
 * @param {string[]}[opts.only]          这一遍只处理这些类型，其余留给别的遍
 * @param {boolean} [opts.settle]         是否等几帧（浏览器里异步图要等），默认 true
 * @param {number}  [opts.frames]         等几帧，默认 2
 * @returns {Promise<{rendered: number, types: string[], pending: string[]}>}
 *          pending = 被 defer 遗留的类型（去重）——调用方据此决定下一遍要谁接手
 * @throws {DiagramError} 缺钩子 / 返回空 / 渲染抛错 —— 不接受缺图降级
 */
const renderDiagrams = async (doc, opts = {}) => {
  const only = Array.isArray(opts.only) ? opts.only : null
  const blocks = chartBlocksOf(doc?.body ?? doc).filter(b => !only || only.includes(b.type))
  if (!blocks.length) return { rendered: 0, types: [], pending: [] }

  const hook = opts.renderDiagram
  if (typeof hook !== "function") {
    const types = [...new Set(blocks.map(b => b.type))]
    throw new DiagramError(
      `文档里有 ${blocks.length} 个图表块（${types.join("、")}），宿主却没有注入 renderDiagram。` +
        `本项目不接受缺图降级——图表必须真渲染。宿主请传 renderDiagram(block)。`,
      { type: types[0] },
    )
  }

  const done = []
  const deferred = []
  const useCache = opts.cache !== false
  for (const block of blocks) {
    // 命中进程/页面内位图缓存：同一图表源码（type+source）跳过昂贵的运行时重绘。
    if (useCache) {
      const cached = diagramCacheGet(block.type, block.source)
      if (cached) {
        injectDiagram(doc, block.pre, { ...cached, type: block.type })
        done.push(block.type)
        continue
      }
    }
    let result
    try {
      result = await hook(block)
    } catch (error) {
      throw new DiagramError(
        `渲染 ${block.type} 图表失败：${error?.message ?? error}` +
          `\n  图表源码首行：${firstLine(block.source)}`,
        { type: block.type, source: block.source },
      )
    }
    // 块级 defer：这一遍不接，原样留给下一遍（父侧收割不了的浏览器类型图走这条）。
    if (result && result.defer) {
      deferred.push(block.type)
      continue
    }
    // 只要位图，不要裸 SVG：IR 的 image 块走 media 落盘、sidecar 照图放，
    // 中间夹一个 SVG 会让落盘出来的 .png 名不副实。要 SVG 就由宿主先栅格成 PNG。
    if (!result || !(result.dataUrl || result.png)) {
      throw new DiagramError(
        `renderDiagram 对 ${block.type} 图表没给出位图（要 dataUrl 或 png；` +
          `SVG 请先由宿主栅格成 PNG）。不接受占位降级，图表必须真渲染。` +
          `\n  图表源码首行：${firstLine(block.source)}`,
        { type: block.type, source: block.source },
      )
    }
    injectDiagram(doc, block.pre, { ...result, type: block.type })
    if (useCache) {
      diagramCacheSet(block.type, block.source, {
        dataUrl: result.dataUrl,
        png: result.png,
        width: result.width,
        height: result.height,
      })
    }
    done.push(block.type)
  }

  if (opts.settle !== false) await settle(doc, opts.frames ?? 2)

  return { rendered: done.length, types: [...new Set(done)], pending: [...new Set(deferred)] }
}

/**
 * 闸门：全篇必须**一个**未渲染的图表围栏都不剩。
 *
 * 所有预通行跑完之后调一次。分环境跑多遍时，某一遍 `only` 掉的类型归下一遍管，
 * 但谁都没接手的会在这里炸出来——这正是"不接受缺图降级"的兜底。
 *
 * @throws {DiagramError} 还有图表没渲染
 */
const assertDiagramsRendered = doc => {
  const left = chartBlocksOf(doc?.body ?? doc)
  if (!left.length) return { pending: 0 }
  const types = [...new Set(left.map(b => b.type))]
  throw new DiagramError(
    `还有 ${left.length} 个图表块没渲染（${types.join("、")}）——不接受缺图降级。` +
      `宿主要么接上对应渲染器，要么就别在文档里用它。` +
      `\n  第一块源码首行：${firstLine(left[0].source)}`,
    { type: types[0], source: left[0].source },
  )
}

module.exports = {
  DIAGRAM_TYPES,
  DiagramError,
  langOf,
  typeOfBlock,
  chartBlocksOf,
  injectDiagram,
  renderDiagrams,
  assertDiagramsRendered,
  clearDiagramCache,
}
