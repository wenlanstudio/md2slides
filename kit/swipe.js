"use strict"

/**
 * kit/swipe.js — 触屏手势识别（kit 层：零依赖、不碰 Node API，浏览器里跑）。
 *
 * 两件事，都只描述「指头干了什么」，不掺业务：
 *   ① **划**：按下 → 拖动 → 抬手，满足条件时报一次 `left / right / up / down`
 *      （**指头移动的方向**，不是内容滚动的方向）。
 *   ② **点**：按在哪儿、几乎没动、很快抬手 → 报一次 `onTap({x, y, target})`。
 * 左滑是翻页还是步进、点左半还是右半该干什么、要不要跟手动画，全是消费方的事——
 * 手势层不知道幻灯片的存在，宿主才能单独复用它（放映器、画廊、预览窗都能接）。
 * 本仓库里唯一的消费方是 `kit/player.js`：划的方向映射成键盘的同义导航键，点位
 * 按左右半区映射成前进/后退（触屏没键盘也没翻页笔时唯一的翻页手段）。
 *
 * 划与点**共用一套状态机**（同一个 pointerdown 起手、同一个 pointerup 收尾），不能拆
 * 成两套监听：Chromium 一次性手势会成对派发 pointer/touch 事件，双监听 = 一次操作算
 * 两遍；而且「按下时记 target」这件事只有一处能做对（capture 之后 up 的 target 会被
 * 改写，见下）。
 *
 * 事件源二选一（不同时装两套：Chromium 下 pointer 与 touch 成对派发，双监听同一次
 * 手势会被算两遍、翻两页）：
 *   - Pointer Events（优先）：覆盖触屏 / 手写笔；鼠标默认不收（`mouse: true` 才收，
 *     给"笔记本触屏 + 鼠标拖着翻"这种需求留口子）。
 *   - Touch Events（回退）：老 WebView / 只实现了 touch 的环境。
 *
 * **touch-action 归宿主 CSS 管**：手势层依赖宿主在容器上声明 `touch-action`（推荐
 * `pinch-zoom`：单指平移交给我们、双指缩放留给浏览器），否则浏览器会先吃掉平移去做
 * 页面滚动。touch 路线里仍会在 move 上 preventDefault 兜底（默认，`preventDefault: false`
 * 可关），防止宿主忘了声明。
 *
 * 误触判定（宁可不翻，也不错翻——放错一页的代价远大于没翻）：
 *   - 第二根手指落下 → 取消（那是 pinch 缩放，不是翻页）；
 *   - 主位移 < `distance`、且没到 `distance * 1.6` 的长距离豁免 → 不报（轻点、抖手）；
 *   - 拖动耗时 > `timeout` 且位移没到豁免线 → 不报（慢拖 = 想看/想选，不是想翻）；
 *   - 斜着划（主轴位移不到副轴的 `axisRatio` 倍）→ 不报（方向不明）；
 *   - 手势起点落在输入框 / 可编辑区 / `ignore` 选择器里 → 压根不开始。
 *
 * 轻点（tap）判定同样是「宁可不报」：位移 ≤ `tapSlop`（默认 12px，且不超过 distance
 * 的 30%）、耗时 ≤ `tapTimeout`（默认 500ms）、没被 pinch 取消、起点不在 `tapIgnore`
 * 里（按钮 / 链接 / 图片 / 可激活元素等"点了要有自己反应"的东西），四条同时成立才报。
 * 长按（> tapTimeout）不报——那是选词 / 长按菜单。`ignore` 是"不接手势"，`tapIgnore`
 * 是"手势照收、只是这一次不算点"，两者别混。
 *
 * 时机：**到达门槛当场就报，不等抬手**（放映划 1 次立刻翻，手感是刚需），一次手势只报
 * 一次（`fired` 标记，抬手复位）；慢慢拖过去、抬手时才够距离的，抬手那刻补报一次。
 * tap 只能在抬手那刻判（够不够稳要看全程），所以它天然晚于 onEnd。
 */

const DEFAULT_DISTANCE = 40    // CSS px
const DEFAULT_TIMEOUT = 800    // ms
const DEFAULT_RATIO = 1.2      // 主轴 / 副轴
const LONG_FACTOR = 1.6        // 超过 distance 这么多倍 = 长距离豁免（不看时限）
const DEFAULT_TAP_SLOP = 12    // CSS px，超过就是"在划"不是"在点"
const DEFAULT_TAP_TIMEOUT = 500 // ms，超过就是长按（选词 / 菜单）

/** @returns {number} 单调毫秒（performance.now 优先） */
const now = () =>
  (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now())

/**
 * @param {EventTarget} target 挂事件的元素（宿主容器；手势整块区域）
 * @param {object} [opts]
 * @param {Window} [opts.view]        事件来源的上级 window（默认 target 所属文档的 view）
 * @param {number} [opts.distance]    触发位移门槛，默认 40px
 * @param {number} [opts.timeout]    超过这个耗时就不算快划，默认 800ms
 * @param {number} [opts.axisRatio]  主轴/副轴最小倍数，默认 1.2
 * @param {boolean}[opts.mouse]      是否也接鼠标拖拽 / 点击，默认 false（只收 touch / pen）
 * @param {boolean}[opts.preventDefault] touch 路线是否 preventDefault，默认 true
 * @param {string|Function}[opts.ignore] 起点命中就不开始手势：选择器（走 closest）或谓词
 * @param {boolean}[opts.tap]        是否识别轻点，默认开（有 onTap 才有意义）
 * @param {number} [opts.tapSlop]    轻点允许的最大位移（px），默认 min(12, distance*0.3)
 * @param {number} [opts.tapTimeout] 轻点允许的最长按压（ms），默认 500
 * @param {string|Function}[opts.tapIgnore] 起点命中就不报轻点（手势照收）：选择器或谓词
 * @param {Function}[opts.onStart]   ({x0,y0,dx:0,dy:0,dt:0,axis,dir}) 手势起手
 * @param {Function}[opts.onMove]    每次 move（含未达门槛）：{dx,dy,dt,axis,dir}
 * @param {Function}[opts.onSwipe]   (dir, info) 到达门槛，dir ∈ left/right/up/down
 * @param {Function}[opts.onTap]     ({x,y,target,dx,dy,dt}) 轻点（抬手判定，onEnd 之后）
 * @param {Function}[opts.onEnd]     ({dir, canceled}) 抬手 / 取消；跟手动画在这里归位
 * @returns {{ destroy: Function, active: boolean }}
 */
function createSwipe(target, opts = {}) {
  if (!target || typeof target.addEventListener !== "function") {
    throw new Error("createSwipe(target, opts)：target 必须能挂监听")
  }
  const distance = Number(opts.distance) > 0 ? Number(opts.distance) : DEFAULT_DISTANCE
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT
  const ratio = Number(opts.axisRatio) > 1 ? Number(opts.axisRatio) : DEFAULT_RATIO
  const allowMouse = opts.mouse === true
  const preventTouch = opts.preventDefault !== false
  const tapEnabled = opts.tap !== false
  // tapSlop 允许显式给 0（严格点击）；不给则跟随 distance，避免 distance 调小后
  // 「点」比「划」还宽松的鬼故事。
  const tapSlop = Number(opts.tapSlop) >= 0
    ? Number(opts.tapSlop)
    : Math.min(DEFAULT_TAP_SLOP, distance * 0.3)
  const tapTimeout = Number(opts.tapTimeout) > 0 ? Number(opts.tapTimeout) : DEFAULT_TAP_TIMEOUT

  /** @type {null | {id: number|null, pointerId: number|null, target: Element|null,
   *                 t0:number, x0:number, y0:number, x:number, y:number,
   *                 fired:boolean, captured:boolean}} */
  let g = null

  const snapshot = () => ({
    dx: g.x - g.x0,
    dy: g.y - g.y0,
    dt: Math.max(0, now() - g.t0),
    x0: g.x0, y0: g.y0, x: g.x, y: g.y,
    axis: axisOf(g),
    dir: dirOf(g),
  })

  const axisOf = () => {
    const ax = Math.abs(g.x - g.x0)
    const ay = Math.abs(g.y - g.y0)
    if (Math.max(ax, ay) < distance) return null          // 还没到门槛，方向无意义
    if (ax > ay ? ax < ay * ratio : ay < ax * ratio) return null   // 斜着划：主轴不明
    return ax > ay ? "x" : "y"
  }

  const dirOf = () => {
    const ax = Math.abs(g.x - g.x0)
    const ay = Math.abs(g.y - g.y0)
    if (ax > ay) return g.x < g.x0 ? "left" : "right"
    return g.y < g.y0 ? "up" : "down"
  }

  /** 起点落在编辑控件 / 宿主指定区里就不起手（拖着选词、拖 UI 不该翻页）。 */
  const ignored = e => {
    const el = e.target
    if (!el || typeof el.closest !== "function") return false
    if (el.isContentEditable) return true
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? "")) return true
    if (typeof opts.ignore === "string" && opts.ignore) return !!el.closest(opts.ignore)
    if (typeof opts.ignore === "function") return !!opts.ignore(el)
    return false
  }

  /**
   * 起点落在「点了本来就该有反应」的地方就不报轻点——按钮、链接、图片查看器、
   * 可激活元素（▶ 运行代码、竞答发放）。**只看按下时的 target**：pointer capture
   * 会把抬手的 target 改写成捕获元素，用它判断就永远判不出按钮。
   *
   * 拿不到元素时返回 true（宁可不翻）。
   */
  const tapIgnored = el => {
    if (!el || typeof el.closest !== "function") return true
    if (el.isContentEditable) return true
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? "")) return true
    if (typeof opts.tapIgnore === "string" && opts.tapIgnore) return !!el.closest(opts.tapIgnore)
    if (typeof opts.tapIgnore === "function") return !!opts.tapIgnore(el)
    return false
  }

  /**
   * 到达门槛就报一次。
   * @param {boolean} atEnd 抬手时的补判：不看时限（慢慢拖过去抬手也算），其余照旧。
   */
  const maybeFire = atEnd => {
    if (g.fired) return
    const info = snapshot()
    const ax = Math.abs(info.dx)
    const ay = Math.abs(info.dy)
    const long = Math.max(ax, ay) >= distance * LONG_FACTOR
    const slow = !atEnd && info.dt > timeout
    if (Math.max(ax, ay) < distance) return
    if (!long && (slow || info.axis === null)) return
    g.fired = true
    opts.onSwipe?.(info.dir, { ...info })
  }

  /**
   * 抬手时的轻点判定（四条同时成立）：没划过、位移在 slop 内、不算长按、起点不在禁区。
   * @param {object} info snapshot + canceled
   */
  const isTap = (info, fired) => {
    if (!tapEnabled || fired || info.canceled) return false
    if (info.dt > tapTimeout) return false
    if (Math.max(Math.abs(info.dx), Math.abs(info.dy)) > tapSlop) return false
    return !tapIgnored(g.target)
  }

  const finish = canceled => {
    if (!g) return
    if (!canceled && !g.fired) maybeFire(true)
    const info = { ...snapshot(), canceled }
    const fired = g.fired
    const tapped = isTap(info, fired)
    const tapTarget = g.target
    g = null
    // 取消时不带方向：宿主据此决定要不要走归位动画、也不该把方向当导航。
    opts.onEnd?.({ ...info, dir: canceled ? null : info.dir })
    // 点的动作排在归位之后：宿主 onEnd 里松掉拖动位移，再翻页不会看到内容横着飘。
    if (tapped) opts.onTap?.({ ...info, target: tapTarget })
  }

  // —— Pointer Events 路线 ——
  const onPointerDown = e => {
    if (allowMouse ? false : e.pointerType === "mouse") return
    if (g) {                       // 第二根手指：pinch，本次作废
      g = null
      opts.onEnd?.({ dir: null, canceled: true, dx: 0, dy: 0, dt: 0, axis: null })
      return
    }
    if (ignored(e)) return
    g = {
      id: e.pointerId ?? 0, pointerId: e.pointerId ?? null,
      // 按下时的起点元素：轻点禁区判定、以及宿主想按「点到了什么」分流都靠它。
      // 不能用 pointerup 的 target（capture 会改写成容器），见 tapIgnored 注释。
      target: e.target ?? null,
      t0: now(), x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      fired: false, captured: false,
    }
    opts.onStart?.(snapshot())
    // 不在这里 setPointerCapture：捕获会把随后补发的 click 目标改写成容器，
    // 手指底下那个按钮就永远点不动（真机踩过：「拖完松手就退出」「按钮点不动」）。
    // 等确认是在拖了再捕获（见 onPointerMove），轻点全程不惊动浏览器。
  }
  const onPointerMove = e => {
    if (!g || (g.id !== null && e.pointerId !== g.id)) return
    g.x = e.clientX
    g.y = e.clientY
    if (!g.captured && g.pointerId !== null
      && Math.max(Math.abs(g.x - g.x0), Math.abs(g.y - g.y0)) > tapSlop) {
      // 越过「点」的界线了，这是拖：捕获指针，指尖划出容器也照样收得到 move / up。
      g.captured = true
      try { target.setPointerCapture?.(g.pointerId) } catch { /* 捕获失败不影响位移路径 */ }
    }
    const info = snapshot()
    opts.onMove?.(info)
    maybeFire(false)
  }
  const onPointerUp = e => {
    if (!g || (g.id !== null && e.pointerId !== g.id)) return
    finish(false)
  }
  const onPointerCancel = () => finish(true)

  // —— Touch Events 路线 ——
  const touchOf = e => e.changedTouches?.[0] ?? e.touches?.[0] ?? null
  const onTouchStart = e => {
    if (e.touches?.length !== 1) { finish(true); return }
    if (ignored(e)) return
    const t = touchOf(e)
    if (!t) return
    g = {
      id: t.identifier ?? 0, pointerId: null, target: e.target ?? null,
      t0: now(), x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY,
      fired: false, captured: false,
    }
    opts.onStart?.(snapshot())
  }
  const onTouchMove = e => {
    if (!g) return
    if (e.touches?.length !== 1) { finish(true); return }
    if (preventTouch && e.cancelable) e.preventDefault()
    const t = touchOf(e)
    if (!t) return
    g.x = t.clientX
    g.y = t.clientY
    const info = snapshot()
    opts.onMove?.(info)
    maybeFire(false)
  }
  const onTouchEnd = e => {
    if (!g) return
    if (e.touches?.length > 0) { finish(true); return }
    finish(false)
  }
  const onTouchCancel = () => finish(true)

  /** 装一套监听并返回解绑函数。 */
  const bind = (name, handler, extra) => {
    target.addEventListener(name, handler, extra === undefined ? undefined : extra)
    return () => target.removeEventListener(name, handler, extra === undefined ? undefined : extra)
  }

  // view 优先从 target 所属的文档取（kit 层不假设自己跑在全局 window 上：Typora iframe、
  // jsdom 测试、-host bundle 都可能是各自的 view）。
  const view = opts.view ?? target.ownerDocument?.defaultView ?? target.defaultView ?? null
  const unbinds = view && typeof view.PointerEvent === "function"
    ? [
      bind("pointerdown", onPointerDown),
      bind("pointermove", onPointerMove),
      bind("pointerup", onPointerUp),
      bind("pointercancel", onPointerCancel),
    ]
    : [
      bind("touchstart", onTouchStart),
      bind("touchmove", onTouchMove, { passive: false }),
      bind("touchend", onTouchEnd),
      bind("touchcancel", onTouchCancel),
    ]

  return {
    /** 解绑全部监听（宿主 destroy 里调一次）。 */
    destroy: () => {
      for (const off of unbinds) off()
      if (g) { g = null; opts.onEnd?.({ dir: null, canceled: true, dx: 0, dy: 0, dt: 0, axis: null }) }
    },
    /** 手势进行中（调试 / 测试用）。 */
    get active() { return !!g },
  }
}

module.exports = { createSwipe }
