"use strict"

/**
 * kit/lightbox.js — 放映态图片全屏查看器（缩放 / 拖动 / 同页切图）。
 *
 * kit 层的定位与 `kit/player.js` / `kit/swipe.js` 一致：零第三方依赖、不碰 Node API、
 * 不碰编辑器 API，宿主（Typora 放映 iframe、导出件 HTML）只负责接线。
 *
 * **为什么另立这张浮层**：放映时整页被 `transform: scale()` 压进容器，图片的真实像素被
 * 缩小投影——截图、架构图、公式图一类细节在底下根本看不清。课堂上唯一体面的解法是
 * 「点开看原图」，而这事不该由翻页（递进）承担。
 *
 * **为什么一个字节都不碰原图 DOM**（这一条解释了本模块所有的「绕」）：
 *   - 渲染产物是裸 `<img>`（无 wrapper、无 class），IR 靠「P/FIGCAPTION 内唯一可见 img
 *     且无文本」认它（`export/pptx/ir.js`），给它套壳会让 IR 多出一层 group 容器；
 *   - `[data-md2s-activatable]` 正是 IR 的 `skipSelector`——给图片打这个标记等于让它在
 *     导出里消失。**触发因此靠事件委托认 `tagName === "IMG"`，不挂任何标记**；
 *   - 显示用**新建的干净 `<img>`**，不复用原图元素：它被分页的 `fitImagesInPlace` 写过
 *     内联 width/height，且 src 会在抽 IR 前被 `inlineImages()` 就地换成 data URL（还会
 *     写回 live deck）——所以每次打开必须现读 src，不能缓存。
 *   三条合起来 = 对 IR / checkIr / 两种 PPTX 导出**零影响**，可以放心加。
 *
 * 缩放模型：**k 恒为「相对图片原始像素的比例」**（k=1 就是 1:1 原像素），不是相对容器的
 * 比例——否则「适应屏幕 / 1:1 / 双击」的含义会随窗口大小漂移。初始 pose 是
 * `fit = min(1, 视口放得下的比例)`：大图缩到看得完，小图按原始大小显示（不拉伸）。
 *
 * 变换只用 `transform: translate(tx,ty) scale(k)`（GPU 合成；改 width/height 每帧重排、
 * 拖动必卡）。CSS 变换列表从左到右作用于坐标系，`translate` 写在 `scale` 前面意味着平移
 * 在父坐标系结算——**单位不会被后面的 scale 放大**，指头划 100px 就走 100px。
 *
 * 交互全表：
 * | 输入 | 行为 |
 * |---|---|
 * | 单击当前页里的图片 | 打开（底部显示 alt 图注） |
 * | 滚轮 / Ctrl+滚轮 | 以指针为锚缩放（Ctrl+wheel 就是触控板 pinch 的发事件方式，必须接） |
 * | 拖动（鼠标 / 单指） | 平移；到边界钳住，图比视口小时锁死居中 |
 * | 双指 pinch | 以双指中点为锚缩放，同时跟手平移 |
 * | 双击 / 双 tap | 在「适应屏幕 ↔ 1:1 原像素」间切（手指下的像素保持不动） |
 * | ← → | 同页上一张 / 下一张（N/M 计数；跨图重置 pose） |
 * | 0 / 1 / + / − | 适应 / 1:1 / 放大 / 缩小 |
 * | Esc / 点背景 / ✕ | 关闭，回到原来那一页继续放映 |
 *
 * **输入隔离（集成要点）**：浮层 DOM 挂在 `<body>` 而不是 `#deck` 里，所以打开后绝大多数
 * 事件的传播路径压根不经过播放器的 `root`——键盘与触屏滑动天然打不到播放器。唯一还要抢
 * 的是 Esc：exec 结果面板在 **document capture** 上吃 Esc，而捕获顺序是 window → document
 * → … → target，因此本模块把键盘挂在 **window capture**，抢在它前面（独占约定：查看器开着
 * 时 Esc 归查看器）。打开时还会向 window 派发 `md2s-overlay-dismiss`，礼貌地请其它浮层让位。
 */

const CSS_ID = "md2s-lb-css"
const PAD = 24            // 适应屏幕时四周留白（px）
const MAX_SCALE = 8       // 上限：800%（相对原像素）
const MIN_SCALE = 0.1     // 下限：再小就没意义
const TAP_MS = 300        // tap 判定的时长上限
const TAP_PX = 8          // tap 判定的位移上限
const DBL_MS = 320        // 双击 / 双 tap 的时间窗
const DBL_PX = 40         // 双击还要求两下落点够近（否则「快点两处」会被误判成双击）

/** 查看器样式。深色岛 + 少量 !important：主题样式会渗进来（同 exec / quiz 浮层约定）。 */
const LIGHTBOX_CSS = `
.md2s-lb { position: fixed; inset: 0; z-index: 100001; background: rgba(12, 12, 12, 0.94);
  display: flex; align-items: center; justify-content: center; color: #eee;
  overflow: hidden;                       /* 图大于视口时不许溢出到页面上去（会带出滚动条） */
  opacity: 0; transition: opacity .15s ease-out;
  /* 触屏：平移与缩放完全自己接管（放映容器的 touch-action 管不到这张浮层） */
  touch-action: none; user-select: none; -webkit-user-select: none; }
.md2s-lb[hidden] { display: none !important; }
.md2s-lb.md2s-lb-on { opacity: 1; }
/* 居中靠 flex（父级 align/justify: center），**不用 absolute + left/top:50%**：
   那样还得靠 transform 里的 translate(-50%,-50%) 把自身拉回一半，而 transform 是
   apply() 每帧改写的（translate(tx,ty) scale(k)，百分比还按未缩放的盒子算，k≠1 时会歪），
   拉不回来图就整体偏右下。flex 居中天然以「未变换时的盒子中心＝容器中点」为准，
   不压缩：固有尺寸即布局尺寸，必须与 measure() 读到的 nat.w × nat.h 一致。 */
.md2s-lb-img { flex: 0 0 auto; display: block; margin: 0; max-width: none !important;
  max-height: none !important; transform-origin: center center; cursor: grab;
  /* z-index 必须显式给出：transform 非 none 会让 img 自成层叠上下文，参与「z-index:auto 的
     定位元素」那一档并与 DOM 顺序比大小——它在工具条之后，于是放大铺满时**盖住工具条**，
     按钮点不到（elementFromPoint 实测命中的是 img）。显式分层把工具条钉在上面。 */
  z-index: 1;
  box-shadow: 0 12px 48px rgba(0, 0, 0, .55); }
.md2s-lb.md2s-lb-drag .md2s-lb-img { cursor: grabbing; }
.md2s-lb-bar { position: absolute; left: 0; right: 0; top: 0; z-index: 2; display: flex; align-items: center;
  gap: 8px; padding: 10px 14px; background: rgba(0, 0, 0, .5); font-size: 13px; line-height: 1; }
.md2s-lb-bar button { padding: 6px 10px; border: 1px solid #555; border-radius: 4px;
  background: #2a2a2a; color: #eee; font-size: 13px; cursor: pointer; }
.md2s-lb-bar button:hover { background: #3a3a3a; }
.md2s-lb-bar button[disabled] { opacity: .4; cursor: default; }
.md2s-lb-count { min-width: 52px; opacity: .85; }
.md2s-lb-cap { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; padding: 10px 16px;
  text-align: center; font-size: 13px; color: #bbb; background: rgba(0, 0, 0, .5);
  max-height: 20%; overflow: hidden; }
.md2s-lb-cap:empty { display: none; }
`

/**
 * @param {Document} doc  浮层挂进去的文档（放映 iframe 的 document）
 * @param {object} [opts]
 * @param {Function}[opts.currentSlide] 当前页元素查询（默认 `.md2s-current` / `[data-slide].active`）
 * @param {string} [opts.selector]      算图片的元素选择器，默认 `img`
 * @param {string} [opts.ignore]        额外忽略的选择器（默认已跳过本浮层与 exec / quiz 浮层）
 * @param {number} [opts.maxScale]      放大上限（相对原像素），默认 8
 * @param {Function}[opts.onOpen]       ({index, count, alt}) 打开回调
 * @param {Function}[opts.onClose]      关闭回调
 * @returns {{ openAt: Function, close: Function, refresh: Function, destroy: Function,
 *             isOpen: boolean, count: number, index: number, scale: number }}
 */
function mountLightbox(doc, opts = {}) {
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("mountLightbox(doc, opts)：doc 必须是 Document")
  }
  const view = doc.defaultView ?? null
  const body = doc.body ?? doc.documentElement

  if (!doc.getElementById(CSS_ID)) {
    const style = doc.createElement("style")
    style.id = CSS_ID
    style.textContent = LIGHTBOX_CSS
    doc.head.appendChild(style)
  }

  const el = doc.createElement("div")
  el.className = "md2s-lb"
  el.hidden = true
  el.innerHTML =
    '<div class="md2s-lb-bar">' +
    '<span class="md2s-lb-count"></span>' +
    '<button data-act="prev" title="上一张（←）">‹</button>' +
    '<button data-act="next" title="下一张（→）">›</button>' +
    '<button data-act="zoom-out" title="缩小（-）">−</button>' +
    '<button data-act="zoom-in" title="放大（+）">＋</button>' +
    '<button data-act="fit" title="适应屏幕（0）">适应</button>' +
    '<button data-act="one" title="原始像素 1:1（1）">1:1</button>' +
    '<span style="flex:1"></span>' +
    '<button data-act="close" title="关闭（Esc）">✕</button>' +
    "</div>" +
    '<img class="md2s-lb-img" alt="">' +
    '<div class="md2s-lb-cap"></div>'
  body.appendChild(el)

  const img = el.querySelector(".md2s-lb-img")
  const capEl = el.querySelector(".md2s-lb-cap")
  const countEl = el.querySelector(".md2s-lb-count")
  const btn = act => el.querySelector(`.md2s-lb-bar button[data-act="${act}"]`)
  const maxScale = Number(opts.maxScale) > 1 ? Number(opts.maxScale) : MAX_SCALE
  const selector = opts.selector ?? "img"
  const ignore = opts.ignore
    ? `${opts.ignore}, .md2s-lb, .md2s-exec-overlay, .md2s-quiz-panel`
    : ".md2s-lb, .md2s-exec-overlay, .md2s-quiz-panel"

  let items = []            // 打开那一刻当前页里的图片（DOM 序）
  let idx = -1
  let opened = false
  let fit = 1               // 适应比例（相对原像素）
  let k = 1                 // 当前缩放（相对原像素）
  let tx = 0
  let ty = 0
  let nat = { w: 1, h: 1 }  // 图片原始像素尺寸
  const pointers = new Map()   // pointerId -> {x, y}（屏幕坐标）
  let pinch = null             // { d0, cx, cy, k0, tx0, ty0 }  cx/cy 为容器中点系坐标
  let tap = null               // { t, moved } 本次按下
  let lastTap = null           // { t, x, y } 上一次有效 tap（判双击）

  /** 当前放映页：宿主各自的标记不同，故留 opts.currentSlide 覆盖位。 */
  const currentSlide = () => {
    if (typeof opts.currentSlide === "function") return opts.currentSlide(doc) ?? null
    return (
      doc.querySelector(".md2s-current") ??
      doc.querySelector("section[data-slide].active") ??
      null
    )
  }

  /** 当前页里的全部图片；家具、缩略图、以及其它浮层里的不算进来。 */
  const collect = () => {
    const slide = currentSlide()
    if (!slide) return []
    return [...slide.querySelectorAll(selector)].filter(node => {
      if (node.tagName !== "IMG") return false
      if (!node.getAttribute("src")) return false
      try { if (node.closest(ignore)) return false } catch { /* 选择器不合法就不过滤 */ }
      return true
    })
  }

  /** 可视区尺寸（工具条与图注是绝对定位的浮层，不占流，故直接用整屏）。 */
  const viewport = () => ({
    w: el.clientWidth || view?.innerWidth || 800,
    h: el.clientHeight || view?.innerHeight || 600,
  })
  const minScale = () => Math.max(MIN_SCALE, Math.min(fit, maxScale))

  /** 重算解码尺寸与 fit；图换了（异步加载）要重新来一遍。 */
  const measure = () => {
    nat = { w: img.naturalWidth || img.width || 1, h: img.naturalHeight || img.height || 1 }
    const { w, h } = viewport()
    fit = Math.max(MIN_SCALE, Math.min(1, (w - PAD * 2) / nat.w, (h - PAD * 2) / nat.h))
  }

  /** 平移边界：图比视口小就锁死居中；比视口大则最多拖到边缘（不会拖出黑洞）。 */
  const clampPose = () => {
    const { w, h } = viewport()
    const maxX = Math.max(0, (nat.w * k - w) / 2)
    const maxY = Math.max(0, (nat.h * k - h) / 2)
    tx = Math.min(maxX, Math.max(-maxX, tx))
    ty = Math.min(maxY, Math.max(-maxY, ty))
    k = Math.min(maxScale, Math.max(minScale(), k))
  }

  const apply = () => {
    clampPose()
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`
    countEl.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : items.length ? "1 / 1" : ""
  }

  /**
   * 以容器坐标 (sx, sy) 为锚缩放到 next：这一点的图像像素保持不动。
   * 推导：屏幕坐标 S = C + T + k·(p − C)（C = 容器中点，也是图片未变换时的中心），
   * 令 p 不变、k→k' 求解 T' ⇒ T' = T + (1 − k'/k)·(S − C − T)。
   */
  const zoomAt = (next, sx, sy) => {
    const { w, h } = viewport()
    const ratio = next / k
    tx = tx + (sx - w / 2 - tx) * (1 - ratio)
    ty = ty + (sy - h / 2 - ty) * (1 - ratio)
    k = next
    apply()
  }

  /** 屏幕坐标 → 容器坐标（锚点公式要的这个坐标系）。 */
  const localOf = e => {
    const rect = el.getBoundingClientRect?.() ?? { left: 0, top: 0 }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const zoomBy = factor => zoomAt(k * factor, viewport().w / 2, viewport().h / 2)

  /** 双击 / 双 tap：在「适应屏幕」与「1:1」之间来回；小图（fit=1）时退化为 1 ↔ 2×。 */
  const toggleZoom = anchor => {
    const nearly = a => Math.abs(k - a) < Math.max(a, 0.01) * 0.02
    let target = fit
    if (nearly(fit)) target = fit < 1 ? 1 : 2
    else if (nearly(1)) target = fit < 1 ? fit : 1
    zoomAt(Math.min(maxScale, Math.max(minScale(), target)), anchor.x, anchor.y)
  }

  const show = i => {
    if (!items.length) return
    idx = (i + items.length) % items.length
    const node = items[idx]
    tx = 0
    ty = 0
    capEl.textContent = node.getAttribute("alt") ?? ""
    const loaded = () => { measure(); k = fit; apply() }
    img.onload = loaded
    img.onerror = () => {
      const note = `图片加载失败：${node.getAttribute("src") ?? ""}`
      capEl.textContent = capEl.textContent ? `${capEl.textContent} · ${note}` : note
    }
    img.src = node.currentSrc || node.getAttribute("src") || ""
    if (img.complete && img.naturalWidth) loaded()
    else { k = fit; apply() }     // 还没解码：先按当前 fit 摆着，load 后再量
    for (const act of ["prev", "next"]) btn(act).disabled = items.length < 2
    opts.onOpen?.({ index: idx, count: items.length, alt: capEl.textContent })
  }

  const openAt = node => {
    if (!node || node.tagName !== "IMG") return false
    items = collect()
    const at = items.indexOf(node)
    if (at < 0) return false
    // 独占：礼貌地请其它 md2s 浮层让位（没监听也只是共存——Esc 仍归查看器，我们抢在
    // window capture）。不去点它们的关闭按钮：那是它们自己的清理逻辑，外人别碰。
    try {
      const Ctor = view?.CustomEvent ?? null
      if (Ctor) view.dispatchEvent(new Ctor("md2s-overlay-dismiss", { detail: { by: "lightbox" } }))
    } catch { /* 没有 CustomEvent 就算了，不因此打不开 */ }
    opened = true
    el.hidden = false
    if (view?.requestAnimationFrame) view.requestAnimationFrame(() => el.classList.add("md2s-lb-on"))
    else el.classList.add("md2s-lb-on")
    view?.addEventListener?.("keydown", onKey, true)
    show(at)
    return true
  }

  const close = () => {
    if (!opened) return
    opened = false
    pointers.clear()
    pinch = null
    tap = null
    unbindPointer()
    view?.removeEventListener?.("keydown", onKey, true)
    el.hidden = true
    el.classList.remove("md2s-lb-on", "md2s-lb-drag")
    img.removeAttribute("src")
    opts.onClose?.()
  }

  /**
   * 打开期间的键盘（window capture）。挂 capture 是为了抢在 exec 面板的 document capture
   * 之前拿到 Esc；对自己的热键一律 stopPropagation，其余键也拦下——不让它们溜到放映器。
   */
  const onKey = e => {
    if (!opened) return
    switch (e.key) {
      case "Escape": close(); break
      case "ArrowRight": if (items.length > 1) show(idx + 1); break
      case "ArrowLeft": if (items.length > 1) show(idx - 1); break
      case "+": case "=": zoomBy(1.2); break
      case "-": case "_": zoomBy(1 / 1.2); break
      case "0": zoomAt(fit, viewport().w / 2, viewport().h / 2); break
      case "1": zoomAt(1, viewport().w / 2, viewport().h / 2); break
      default: break
    }
    if (e.cancelable) e.preventDefault()
    e.stopPropagation()
  }

  // —— 打开入口：事件委托认 IMG，图片 DOM 上一个属性都不加 ——
  const onClick = e => {
    if (opened) return
    const node = e.target
    if (!node || node.tagName !== "IMG") return
    if (e.button !== undefined && e.button !== 0) return
    try { if (node.closest(ignore)) return } catch { /* 忽略 */ }
    if (!openAt(node)) return
    if (e.cancelable) e.preventDefault()
    e.stopPropagation()
  }

  // —— 滚轮缩放（含触控板 pinch 的 ctrl+wheel） ——
  const onWheel = e => {
    if (!opened) return
    if (e.cancelable) e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
    const step = e.ctrlKey ? 0.01 : 0.0022     // pinch 给的 delta 小得多，步长要分开
    const p = localOf(e)
    zoomAt(k * Math.exp(-e.deltaY * unit * step), p.x, p.y)
  }

  // —— 拖动 / pinch / tap ——
  const pair = () => [...pointers.values()].slice(0, 2)
  const dist2 = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y)

  /** 工具条 / 图注是「真按钮区域」：放行给原生 click，这里一概不接管。 */
  const chromeHit = t => {
    try { return !!t?.closest?.(".md2s-lb-bar, .md2s-lb-cap") } catch { return false }
  }

  /**
   * move / up 挂到 window，而不是用 `setPointerCapture`。
   * 指针捕获会把后续 pointerup、**乃至兼容性 mouse 与 click 事件**的 target 统统改写成
   * 捕获元素（这里是浮层 el）于是：① 拖完松手，浏览器补发的 click 落在 el 上，被当成
   * 「点了背景」→ 直接关掉预览；② 工具条按钮的 click 也再也拿不到 data-act（2026-10-30
   * 实测：适应 / 1:1 / ＋ / − 全失效，点它们反而退出）。改用「按下时才绑、松手即摘」，
   * target 保持真实命中元素，代价是要自己管生命周期。
   */
  let bound = false
  const bindPointer = () => {
    if (bound || !view?.addEventListener) return
    bound = true
    view.addEventListener("pointermove", onPointerMove)
    view.addEventListener("pointerup", endPointer)
    view.addEventListener("pointercancel", endPointer)
  }
  const unbindPointer = () => {
    if (!bound) return
    bound = false
    view.removeEventListener("pointermove", onPointerMove)
    view.removeEventListener("pointerup", endPointer)
    view.removeEventListener("pointercancel", endPointer)
  }

  const onPointerDown = e => {
    if (!opened || !el.contains(e.target)) return
    if (chromeHit(e.target)) return       // 放行工具条：它的 click 由浏览器原生派发
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    bindPointer()
    if (pointers.size === 2) {
      const [a, b] = pair()
      pinch = { d0: dist2([a, b]) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, k0: k, tx0: tx, ty0: ty }
    }
    if (pointers.size === 1) {
      el.classList.add("md2s-lb-drag")
      // target 按下时就记住：松手时再问 pointerup 的 target 会被各种重定目标搅乱
      tap = { t: Date.now(), x: e.clientX, y: e.clientY, moved: 0, target: e.target }
    }
    if (e.cancelable) e.preventDefault()   // 挡掉浏览器的原生图片拖影
  }

  const onPointerMove = e => {
    if (!opened || !pointers.has(e.pointerId)) return
    const prev = pointers.get(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && pointers.size >= 2) {
      const [a, b] = pair()
      const d = dist2([a, b])
      const r = Math.min(maxScale, Math.max(minScale(), pinch.k0 * (d / pinch.d0))) / pinch.k0
      // 双指 = 「以起始中点为锚缩放」+「中点平移」一次算干净，不分两步累加（分两步会把
      // 这一帧的位移也算进下一次的锚点，越缩越飘）。上式由 T' = C + T + k(p − C) 推来。
      const rect = el.getBoundingClientRect?.() ?? { left: 0, top: 0 }
      const { w, h } = viewport()
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const sx = mx - rect.left
      const sy = my - rect.top
      const s0x = pinch.mx - rect.left
      const s0y = pinch.my - rect.top
      k = pinch.k0 * r
      tx = sx - w / 2 - r * (s0x - w / 2 - pinch.tx0)
      ty = sy - h / 2 - r * (s0y - h / 2 - pinch.ty0)
      apply()
      return
    }
    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    if (tap) tap.moved += Math.abs(dx) + Math.abs(dy)
    tx += dx
    ty += dy
    apply()
  }

  const endPointer = e => {
    if (!opened) return
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (pointers.size === 0) { el.classList.remove("md2s-lb-drag"); unbindPointer() }
    const hit = tap
    tap = null
    // 「是不是 tap」看按下→松手的全过程位移，绝不能看 pointerup 的 target：拖完之后浏览器
    // 还会补一个 click（target 可能是任一祖先），若照 target 判断就会「松手即退出」。
    const wasTap = hit && Date.now() - hit.t <= TAP_MS && hit.moved <= TAP_PX
    if (!wasTap) return
    const now = Date.now()
    // 双击 / 双 tap：除了时间窗，还得要求两下**落在同一处**——只看时间的话，在图上
    // 「先点这里再快点那里」会被当成双击忽然跳到 1:1/适应，看着就像乱跳（2026-10-30）。
    const near = lastTap && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= DBL_PX
    const isDouble = !!lastTap && now - lastTap.t <= DBL_MS && near
    lastTap = isDouble ? null : { t: now, x: e.clientX, y: e.clientY }
    if (isDouble) toggleZoom(localOf(e))
    else if (!img.contains(hit.target)) close()   // 背景 tap = 关闭（用「按下时」的 target 判）
  }

  /**
   * 容器尺寸变了（旋转屏幕 / 投影换分辨率）：重算 fit。若当时正处在「适应」状态就跟着
   * 新的 fit 走；用户手动放大过则保持他的缩放，只把平移夹回新边界——突兀地重新适应会
   * 让正在讲解的图跳回去。
   */
  const onResize = () => {
    if (!opened) return
    const wasFit = Math.abs(k - fit) < Math.max(fit, 0.01) * 0.02
    measure()
    if (wasFit) { k = fit; tx = 0; ty = 0 }
    apply()
  }

  el.addEventListener("wheel", onWheel, { passive: false })
  el.addEventListener("pointerdown", onPointerDown)
  // 注意：move / up 由 bindPointer() 按需挂到 window（见那里的注释）
  // 双击只走上面的 pointer 层判定（鼠标与触屏同一套）；不再监听原生 dblclick，
  // 否则鼠标双击会被 toggleZoom 连做两次、等于没反应。
  el.addEventListener("click", e => {
    if (!opened) return
    const act = e.target?.getAttribute?.("data-act")
    if (!act) return          // 非工具条一律不管：关闭由 tap 逻辑负责，别再听 click 的
    if (act === "close") close()
    else if (act === "prev") show(idx - 1)
    else if (act === "next") show(idx + 1)
    else if (act === "zoom-in") zoomBy(1.2)
    else if (act === "zoom-out") zoomBy(1 / 1.2)
    else if (act === "fit") zoomAt(fit, viewport().w / 2, viewport().h / 2)
    else if (act === "one") zoomAt(1, viewport().w / 2, viewport().h / 2)
  })
  doc.addEventListener("click", onClick, true)
  view?.addEventListener?.("resize", onResize)

  return {
    /** 打开某张图（必须是当前页里的 IMG 元素）*/
    openAt,
    close,
    /** 重新收集当前页图片（宿主换页后可选调用；openAt 每次都会现收，一般不用管）*/
    refresh: () => { if (opened) { items = collect(); apply() } },
    /** 拆掉委托与浮层 DOM（宿主停止放映时调用）*/
    destroy: () => {
      close()
      doc.removeEventListener("click", onClick, true)
      view?.removeEventListener?.("resize", onResize)
      el.remove()
    },
    get isOpen() { return opened },
    get count() { return items.length },
    get index() { return idx },
    get scale() { return k },
  }
}

module.exports = { mountLightbox, LIGHTBOX_CSS }
