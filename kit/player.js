"use strict"

/**
 * kit/player.js — 框架无关的幻灯片播放器（kit 层：core 保持纯净，宿主各取所需）。
 *
 * 职责只有「怎么看」：一页一屏、缩放适配容器、翻页、步进、页码/步号状态。
 * 翻页按钮、页码 UI、全屏、步进高亮的样式都是宿主的事——player 给状态
 * （onChange / index / step / total / mode）。参考宿主：marktext slides 视图（规划）、
 * tools/export-html.js 的导出件放映器（同款结构的原型，暂未迁移）。
 *
 * 结构：root（宿主容器）> stage（player 新建，钉在容器中心，按 --md2s-scale 缩放）
 *       > 全部页。页面 DOM 从原位置搬进 stage——同一文档内移动，属性、监听、
 *       子树都不丢；destroy 时原序搬回。可见性归 player 管：非当前页 display:none
 *       （主题只管页内排版，从不管「哪一页显示」）。
 *
 * 两种放映形态 + 一个开关（2026-10-26 用户设计评审：显示形态与翻页粒度正交）：
 *   show: "page"（默认）  整页全显。browse=true（默认）：↓/空格/PgDn 仍逐元素
 *                          游走——只动高亮（md2s-step-current：默认黄红色描边 + 黄里透黄暖光辉（柔光晕），
 *                          见 PLAYER_CSS，按缩放反向放大所以投影下也明显，主题可覆盖），
 *                          **不隐藏任何内容**；翻页笔走到
 *                          ▶ 上按 Enter 运行。browse=false：纯整页翻。
 *   show: "element"       渐进揭示：未揭示元素 visibility:hidden，逐元素上/下一步
 *                          （步尽溢出成翻页）。←→ 在两种形态里恒为翻页（键盘党快速跳页）。
 * 翻页笔：主流笔的"下一页"键发 PageDown——两种形态里它都并进步进（2026-10-26 修订）。
 * 遗留：opts.mode 传 "slide" 是旧键，等价 page + browse=false。
 *
 * 可激活元素（宿主契约）：页内元素标 `data-md2s-activatable`（宿主自挂 click 与样式），
 * Enter / activate() 触发 click——放映中跑代码块这类交互的通用接入点。element 与
 * page+browse 命中**当前步**上的第一个（步进到位才命中），page 纯翻页命中当前页
 * 第一个；没有可命中目标时 Enter 原样放行（不 preventDefault）。player 只管派发，
 * 按钮长什么样、点了干什么归宿主。
 *
 * 揭示机制（版面冻结铁律）：未揭示元素 visibility:hidden——**占位不显示**，页面
 * 从进来那一刻就是最终版面；用 display:none 会让垂直居中随每次步进重排、测量漂移。
 * 累积显示（拍板）：讲过的留在屏上；当前步标 md2s-step-current（默认无样式，
 * 宿主/主题可给 -current 加高亮、给 -past 加变灰）。
 *
 * 零依赖、不碰 Node API，浏览器里跑；缩放监听用 ResizeObserver（没有就等宿主调 fit()）。
 *
 * 输入三条腿（2026-10-30 加触屏，同日晚加轻点）：键盘 + 触屏手势（kit/swipe.js）+ 触屏
 * 轻点，**两套触屏输入共用同一张方向语义表**——`navKey(key)` 是唯一的导航立法地，
 * `SWIPE_KEY` 只是把手势方向翻译成同一个键，轻点则按左右半区翻成同一个键。
 * 两条输入各漂移一套的日子到此为止：加键 / 改语义只动 navKey 一处。
 *   左滑 → ▶ 下一页   右滑 → ◀ 上一页
 *   上滑 → ↓ 步进（browse / element），步尽溢出翻页；纯翻页形态里就是下一页
 *   下滑 → ↑ 回退一步，已在首步则退回上一页（退到它的步尽）；纯翻页形态里就是上一页
 *   轻点右半屏 → 同「上滑」（前进）；轻点左半屏 → 同「下滑」（后退）
 * kit/swipe.js 只管「指头往哪去了 / 点在哪儿」，知道翻页这回事的只有 player。
 *
 * 轻点翻页（触屏没键盘、没翻页笔时的常规手势）：点右侧往下走、点左侧往回走，与
 * ↓/↑ 完全同义——browse / element 形态下先步进、步尽才翻页（讲课点一下继续讲，比
 * 一按跳整页自然），纯翻页形态（slide）本来就只有翻页。想恒定整页翻给
 * `tapNav: "page"`，不想要就 `tapNav: false`。
 * 点到按钮 / 图片 / 可激活元素（▶ 运行代码、竞答发放）时**不翻页**——那些地方点了
 * 有自己的事要办，顺手翻页就是灾难（见 TAP_IGNORE）。
 */

const { sectionsOf } = require("../core/section")
const { buildStepPlan } = require("./steps")
const { createSwipe } = require("./swipe")

const PLAYER_CSS_ID = "md2s-player-css"

/**
 * 轻点导航的默认禁区：点在这些东西上「有自己的事要办」，不该顺手翻页。
 *   - a[href] / button / 表单控件 / label → 本来就等一次点击；
 *   - img / svg / video / audio → 图开了查看器（kit/lightbox，点图全屏），图里点不翻；
 *   - [data-md2s-activatable] → 宿主契约里的可激活元素（▶ 运行代码、竞答「发放」）；
 *   - .md2s-lb / .md2s-exec-run / .md2s-quiz-* → 实现类名兜底（漏标 activatable 也别误翻）。
 * 宿主可传 opts.tapIgnore 整个覆盖（选择器或谓词）。判的是**按下时的** target。
 */
const TAP_IGNORE = [
  "a[href]", "button", "input", "textarea", "select", "label",
  "img", "svg", "video", "audio",
  "[data-md2s-activatable]",
  ".md2s-lb", ".md2s-exec-run", ".md2s-quiz-send", ".md2s-quiz-panel",
].join(",")

/** 宿主也可以自取这段 CSS 自行注入；createDeckPlayer 默认幂等注入一次。 */
const PLAYER_CSS = `
.md2s-player { position: relative; overflow: hidden;
  /* 触屏手势要靠这条把手势从浏览器手里抢过来：pinch-zoom = 单指平移归我们（平移
     浏览器自己去做页面滚动，横向、纵向手势都会丢），双指缩放仍是浏览器的（投影时
     想放大看清某块细节不能用不了）。宿主用 opts.touchAction 改写成 none / auto。 */
  touch-action: var(--md2s-touch-action, pinch-zoom);
  /* 触屏轻点是导航手段（左右半区翻页），落点亮块/蓝框纯属噪点。 */
  -webkit-tap-highlight-color: transparent; }
.md2s-player .md2s-stage {
  position: absolute; left: 50%; top: 50%;
  /* --md2s-swipe-x/y 是横向拖动的跟手位移（CSS px，写在 scale 之前，故视觉位移要乘
     缩放比；player 按 1/scale 反向写入，见 dragFeedback 那段）。缺失时 fallback 0px。 */
  transform: translate(calc(-50% + var(--md2s-swipe-x, 0px)), calc(-50% + var(--md2s-swipe-y, 0px)))
             scale(var(--md2s-scale, 1));
  transform-origin: center center;
}
.md2s-player .md2s-stage > section[data-slide] {
  display: none; position: absolute; left: 0; top: 0; margin: 0;
}
.md2s-player .md2s-stage > section[data-slide].md2s-current { display: flex; }
/* 步进：隐藏态必须 visibility（占位不显示），display:none 会重排版面（见文件头）。 */
.md2s-player .md2s-step-hidden { visibility: hidden; }
/* 浏览态（page+browse）默认的"当前步"高亮：全显游走时唯一的视觉反馈。
   只作用在 md2s-browse 上——element 揭示态保持"默认无样式"契约（主题/宿主自给）。

   为什么描边宽/偏移/光晕都写成 var(--md2s-step-*) 并由 fit() 按 1/scale 反向放大：
   整个 stage 被 transform: scale() 压小投到屏上，outline / box-shadow 会跟着一起变细
   （缩放 0.5 → 视觉厚度减半），投影或窄窗里几乎看不见——这正是"选中态不明显"的根因。
   反向放大后，无论怎么缩放，视觉粗细恒定（约 3px 红描边 + 红里透黄暖光辉），翻页笔/键盘逐元素
   游走时当前块一眼可辨。主题/宿主用同名变量即可改配色（--md2s-step-c 描边 / --md2s-step-halo-c
   外层黄红 / --md2s-step-halo-inner-c 内层黄），也可整条覆盖 .md2s-step-current。

   选 .md2s-browse .md2s-step-current（而不是多挂 .md2s-player）是给宿主让特异性：
   exec-bridge 的 .md2s-exec-run.md2s-step-current（青色光晕）与这里同特异性，靠"后注入
   胜出"保留 ▶ 按钮自己的高亮；默认红描边 + 红里透黄暖光辉只作用在普通内容步上（按钮的
   box-shadow 不被覆盖）。 */
.md2s-browse .md2s-step-current {
  border-radius: var(--md2s-step-radius, 10px);
  outline: var(--md2s-step-w, 3px) solid var(--md2s-step-c, rgba(240, 130, 38, 0.9));
  outline-offset: var(--md2s-step-off, 3px);
  /* 柔光晕做成"黄里透黄"的暖光辉：外层黄红、内层透黄，blur≠0；圆角矩形描边/光晕跟随
     border-radius（Chromium 下 outline 自动随圆角绘制），投影下也明显。颜色走
     --md2s-step-halo-c（外层黄红）/ --md2s-step-halo-inner-c（内层黄），均可被主题覆盖。 */
  box-shadow:
    0 0 calc(var(--md2s-step-halo, 8px) * 0.9) calc(var(--md2s-step-halo, 8px) * 0.35) var(--md2s-step-halo-inner-c, rgba(255, 200, 40, 0.6)),
    0 0 calc(var(--md2s-step-halo, 8px) * 1.6) var(--md2s-step-halo, 8px) var(--md2s-step-halo-c, rgba(245, 150, 48, 0.55));
}
`

/**
 * @param {Element} root 装幻灯片的容器（player 接管它：加类、建 stage、把页搬进来）
 * @param {object} [opts]
 * @param {Document} [opts.doc]        页所在的文档（默认 root.ownerDocument）
 * @param {number}  [opts.slideWidth]  画布设计宽（compose 的 slideWidth），默认 1920
 * @param {number}  [opts.slideHeight] 画布设计高，默认 1080
 * @param {"page"|"element"|"slide"} [opts.mode] "page"=整页全显（默认）；"element"=渐进
 *   揭示；"slide"=旧键别名（等价 page + browse:false）
 * @param {boolean} [opts.browse]  仅 page 形态有意义：true（默认）逐元素游走（全显 + 高亮
 *   步进，翻页笔可达 ▶）/ false 纯整页翻
 * @param {Array}   [opts.steppers]    图表切分钩子 [{match(el), create(el)→{count,show,hide}}]
 * @param {Function}[opts.onChange]    翻页/步进回调 ({index,total,step,steps,mode})；1 基
 * @param {boolean} [opts.keys]        键盘导航，默认开
 * @param {EventTarget}[opts.keyTarget] 键盘监听挂哪（默认 root；编辑器宿主可传自己的容器）
 * @param {boolean} [opts.touch]       触屏手势导航，默认开（false = 完全不接手势层）
 * @param {EventTarget}[opts.touchTarget] 手势监听挂哪（默认 root）
 * @param {number}  [opts.touchDistance] 触发滑动的位移门槛（px），默认 40
 * @param {number}  [opts.touchTimeout]  超过这个耗时（ms）不算「划」，默认 800
 * @param {boolean} [opts.touchMouse]  也接鼠标拖拽 / 点击（默认 false，只收 touch / pen）
 * @param {boolean} [opts.touchFeedback] 拖动时内容跟手移动（默认开；跟手发飘的机器可关）
 * @param {string}  [opts.touchAction] 覆盖容器 touch-action（默认 pinch-zoom：单指平移归
 *   手势层、双指缩放归浏览器；none = 全归手势层、缩放也不能用）
 * @param {string|Function}[opts.touchIgnore] 起点命中就不起手的选择器或谓词（默认已跳过
 *   输入框 / contenteditable；宿主可再加自己的面板）
 * @param {boolean|"step"|"page"} [opts.tapNav] 触屏轻点导航：默认 "step"（点右半 = ↓
 *   前进：先步进、步尽翻页；纯翻页形态里就是翻页），"page" = 恒定整页翻，false = 关
 * @param {number}  [opts.tapZone] 左右分界（0~1，默认 0.5 = 各半；越小右侧越大）
 * @param {string|Function}[opts.tapIgnore] 点中就不导航的选择器或谓词（默认 TAP_IGNORE：
 *   按钮 / 链接 / 图片 / 可激活元素…）
 * @param {number}  [opts.tapSlop]   轻点允许位移（px，默认 min(12, touchDistance*0.3)）
 * @param {number}  [opts.tapTimeout] 轻点允许按压时长（ms，默认 500；更长算长按）
 * @param {number}  [opts.startIndex]  起始页，1 基，默认 1
 * @returns {{ index: number, total: number, step: number, steps: number, mode: string,
 *              stage: Element, stepIssues: string[],
 *              next: Function, prev: Function, go: Function,
 *              stepFwd: Function, stepBack: Function, activate: Function,
 *              setMode: Function, refreshSteps: Function, fit: Function, destroy: Function }}
 */
function createDeckPlayer(root, opts = {}) {
  if (!root || !root.ownerDocument) {
    throw new Error("createDeckPlayer(root, opts)：root 必须是容器元素")
  }
  const doc = root.ownerDocument
  const view = doc.defaultView
  const W = Number(opts.slideWidth) > 0 ? Number(opts.slideWidth) : 1920
  const H = Number(opts.slideHeight) > 0 ? Number(opts.slideHeight) : 1080
  const steppers = Array.isArray(opts.steppers) ? opts.steppers : null
  // 轻点导航：false 关掉；"page" 恒定整页翻；其余（默认 / true / "step"）走 navKey 的
  // ↓↑ 语义——browse / element 下先步进、步尽才翻页（点一下继续讲）。
  const tapNav = opts.tapNav === false ? false
    : opts.tapNav === "page" ? "page" : "step"
  const tapZone = Number(opts.tapZone) > 0 && Number(opts.tapZone) < 1
    ? Number(opts.tapZone)
    : 0.5

  // 样式幂等注入；destroy 不摘——同一文档重建 player 还要用，摘了反而闪。
  if (!doc.getElementById(PLAYER_CSS_ID)) {
    const style = doc.createElement("style")
    style.id = PLAYER_CSS_ID
    style.textContent = PLAYER_CSS
    doc.head.appendChild(style)
  }

  const stage = doc.createElement("div")
  stage.className = "md2s-stage"
  stage.style.width = `${W}px`
  stage.style.height = `${H}px`

  const sections = sectionsOf(opts.doc ?? doc)
  for (const section of sections) stage.appendChild(section)
  root.classList.add("md2s-player")
  root.appendChild(stage)

  let index = 1
  const total = sections.length
  let mode = opts.mode === "element" ? "element" : "page"
  let browse = opts.mode === "slide" ? false : opts.browse !== false
  /** 当前形态是否有步进表：element 天然有；page 要看 browse 开关。 */
  const stepping = () => mode === "element" || (mode === "page" && browse)
  const syncBrowseClass = () => root.classList.toggle("md2s-browse", mode === "page" && browse)
  syncBrowseClass()

  // 步进状态按页记（讲过就是讲过了，翻回来保持）；setMode 全清（新的一轮放映）。
  const plans = new Map()      // slideIndex -> Step[]
  const shown = new Map()      // slideIndex -> 已揭示步数（0 = 只剩锚点）
  const stepIssues = []        // steppers 钩子异常（宿主可读，不往控制台倒）

  const planFor = i => {
    if (plans.has(i)) return plans.get(i)
    const plan = stepping()
      ? buildStepPlan(sections[i], { steppers, issues: stepIssues })
      : []
    for (const step of plan) {
      step.el.classList.add("md2s-step")
      for (const extra of step.extra ?? []) extra.classList.add("md2s-step")
    }
    plans.set(i, plan)
    return plan
  }

  const stepCountOf = i => (stepping() ? planFor(i).length : 0)

  /** 把第 i 页的揭示状态刷到 DOM（shown = 已揭示步数）。图表步按增量调 show/hide。 */
  const applySteps = (i, prevShown, nextShown) => {
    const plan = planFor(i)
    plan.forEach((step, k) => {
      const revealed = k < nextShown
      const current = k === nextShown - 1
      for (const t of [step.el, ...(step.extra ?? [])]) {
        // 只有 element 揭示态才藏内容；browse 全显游走，hidden 永远不加
        t.classList.toggle("md2s-step-hidden", mode === "element" && !revealed)
        t.classList.toggle("md2s-step-past", revealed && !current)
        t.classList.toggle("md2s-step-current", current)
      }
      if (step.kind !== "chart") return
      try {
        if (nextShown > prevShown && k >= prevShown && k < nextShown) step.handle.show(step.k)
        if (nextShown < prevShown && k >= nextShown && k < prevShown) step.handle.hide(step.k)
      } catch (error) {
        stepIssues.push(`图表步 show/hide 异常：${error?.message ?? error}`)
      }
    })
  }

  const clearSteps = () => {
    for (const plan of plans.values()) {
      for (const step of plan) {
        for (const t of [step.el, ...(step.extra ?? [])]) {
          t.classList.remove("md2s-step-hidden", "md2s-step-past", "md2s-step-current")
        }
      }
    }
  }

  const shownOf = i => shown.get(i) ?? 0

  const show = k => {
    index = Math.max(1, Math.min(total, k))
    sections.forEach((s, i) => s.classList.toggle("md2s-current", i === index - 1))
    if (mode === "element") {
      // 进入本页：恢复它上次的揭示状态；没来过 = 第 0 步（只剩标题锚点）。
      applySteps(index - 1, shownOf(index - 1), shownOf(index - 1))
    }
    emit()
  }

  const emit = () => {
    opts.onChange?.({
      index, total, mode,
      step: stepping() ? shownOf(index - 1) : 0,
      steps: stepping() ? stepCountOf(index - 1) : 0,
    })
  }

  /** 容器没有尺寸（刚挂载 / 测试环境）时保持 1，不把内容缩没了。 */
  const fit = () => {
    const w = root.clientWidth || root.getBoundingClientRect?.().width || 0
    const h = root.clientHeight || root.getBoundingClientRect?.().height || 0
    const k = w > 0 && h > 0 ? Math.min(w / W, h / H) : 1
    scale = k
    stage.style.setProperty("--md2s-scale", String(k))
    // 描边/光晕按 1/scale 反向放大：stage 被整体压小后，视觉粗细保持基准值
    // （约 3px 描边 / 8px 光晕 / 10px 圆角），投影、窄窗里选中态依旧明显（见 PLAYER_CSS 注释）。
    stage.style.setProperty("--md2s-step-w", (3 / k) + "px")
    stage.style.setProperty("--md2s-step-off", (3 / k) + "px")
    stage.style.setProperty("--md2s-step-halo", (8 / k) + "px")
    stage.style.setProperty("--md2s-step-radius", (10 / k) + "px")
    return k
  }

  const isEditable = t =>
    t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)

  // —— 翻页（两种模式同义；恢复目标页的步进状态）——
  const goto = k => show(k)

  // —— 步进（element 揭示 / page 浏览；无步进的形态恒 false）；步尽返回 false ——
  const stepFwd = () => {
    if (!stepping()) return false
    const i = index - 1
    const n = stepCountOf(i)
    const cur = shownOf(i)
    if (cur >= n) return false
    shown.set(i, cur + 1)
    applySteps(i, cur, cur + 1)
    emit()
    return true
  }
  const stepBack = () => {
    if (!stepping()) return false
    const i = index - 1
    const cur = shownOf(i)
    if (cur <= 0) return false
    shown.set(i, cur - 1)
    applySteps(i, cur, cur - 1)
    emit()
    return true
  }

  // —— 可激活元素（宿主契约）：element / page+browse 命中当前步（步进到位才命中），
  //    page 纯翻页命中当前页第一个。命中就 click 并返回 true；无命中返回 false，
  //    键盘层据此决定拦不拦 Enter。 ——
  const findActivatable = el => {
    if (!el) return null
    if (el.matches?.("[data-md2s-activatable]")) return el
    return el.querySelector?.("[data-md2s-activatable]") ?? null
  }
  const activate = () => {
    const section = sections[index - 1]
    if (!section) return false
    let target = null
    if (stepping()) {
      const step = planFor(index - 1)[shownOf(index - 1) - 1]
      for (const t of step ? [step.el, ...(step.extra ?? [])] : []) {
        target = findActivatable(t)
        if (target) break
      }
    } else {
      target = section.querySelector("[data-md2s-activatable]")
    }
    if (!target) return false
    target.click()
    return true
  }

  /**
   * 导航立法地（唯一的）：一个键 = 一个动作，返回「有没有处理」（键盘层据此决定是否
   * preventDefault——比如 Enter 只在真有可激活元素时才吞键）。
   * 键盘与触屏都走这里：加键 / 改语义只此一处。
   */
  const navKey = key => {
    if (stepping()) {
      // element 揭示 / page 浏览共用：↓/空格/PgDn 步进（步尽溢出翻页），↑/PgUp 回退
      // （第一步再按回上一页、恢复到步尽），←→ 恒为翻页（键盘党快速跳页）。
      switch (key) {
        case "ArrowDown": case " ": case "PageDown":
          if (!stepFwd()) goto(index + 1)
          return true
        case "ArrowUp": case "PageUp":
          if (!stepBack()) {
            const t = index - 1
            if (t >= 1) {
              shown.set(t - 1, stepCountOf(t - 1))
              goto(t)
            }
          }
          return true
        case "Enter":
          return activate()                          // 没命中就返回 false，别吞键
        case "ArrowRight":
          goto(index + 1); return true
        case "ArrowLeft":
          goto(index - 1); return true
        case "Home": goto(1); return true
        case "End": goto(total); return true
        default: return false
      }
    }
    // page 纯翻页：一屏一页，方向键全翻页；Enter 运行页内第一个可激活元素
    switch (key) {
      case "ArrowRight": case "ArrowDown": case "PageDown": case " ":
        goto(index + 1); return true
      case "ArrowLeft": case "ArrowUp": case "PageUp":
        goto(index - 1); return true
      case "Enter":
        return activate()
      case "Home": goto(1); return true
      case "End": goto(total); return true
      default: return false
    }
  }

  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isEditable(e.target)) return   // 宿主面板里可能有编辑框，别抢键
    if (navKey(e.key)) e.preventDefault()
  }
  const keyTarget = opts.keyTarget ?? root
  if (opts.keys !== false) {
    keyTarget.addEventListener("keydown", onKey)
    if (keyTarget === root) root.setAttribute("tabindex", "-1")   // 能聚焦，键盘才生效
  }

  /**
   * 触屏轻点 → 左右半区 → 同一个 navKey（唯一立法地）。点右半 = ↓（前进），点左半 =
   * ↑（后退）：与上下滑、翻页笔完全同义，不另立一套。
   * 容器量不出宽度（还没上屏 / display:none）就不动——此时也没有「左右」可言。
   */
  const tapNavigate = info => {
    if (!tapNav) return
    const rect = root.getBoundingClientRect?.()
    if (!rect || !rect.width) return
    // x 落在左区才算「往回」，恰好压线（fx === tapZone）算前进：别让点正中没反应。
    const back = (info.x - rect.left) / rect.width < tapZone
    if (tapNav === "page") { back ? goto(index - 1) : goto(index + 1); return }
    navKey(back ? "ArrowUp" : "ArrowDown")
  }

  // —— 触屏：手势 → 同一个 navKey（语义表见 SWIPE_KEY 注释） ——
  // 左滑=下一页、右滑=上一页（内容跟着指头走）；上滑=步进/下页、下滑=回退/上页。
  // 轻点走另一条判定（swipe 的 tap），但最后落到同一张键表（tapNavigate）。
  const SWIPE_KEY = { left: "ArrowRight", right: "ArrowLeft", up: "ArrowDown", down: "ArrowUp" }

  /** stage 的当前缩放比（fit 写入）；跟手位移要按它反向换算，见 CSS 注释。 */
  let scale = 1
  let rebound = null
  const clearRebound = () => {
    if (rebound) {
      view?.clearTimeout?.(rebound)
      rebound = null
    }
  }
  /** 跟手位移写入（CSS px，已换算成 stage 坐标系）；归零用 removeProperty 而非写 0。 */
  const setSwipeOffset = (dx, dy) => {
    if (!dx && !dy) {
      stage.style.removeProperty("--md2s-swipe-x")
      stage.style.removeProperty("--md2s-swipe-y")
      return
    }
    stage.style.setProperty("--md2s-swipe-x", `${dx}px`)
    stage.style.setProperty("--md2s-swipe-y", `${dy}px`)
  }
  const finishRebound = () => {
    stage.style.removeProperty("transition")
    rebound = null
  }
  /** 松手 / 取消：带一点过渡弹回原位（拖动中是无过渡的，否则跟手发飘）。 */
  const releaseDrag = () => {
    clearRebound()
    const moved =
      stage.style.getPropertyValue("--md2s-swipe-x") || stage.style.getPropertyValue("--md2s-swipe-y")
    if (!moved) { finishRebound(); return }
    stage.style.transition = "transform .18s ease-out"
    setSwipeOffset(0, 0)
    rebound = view?.setTimeout?.(finishRebound, 200)
    if (!rebound) finishRebound()      // 没 window（罕见）：别把 transition:none 留在 stage 上
  }
  const swipe = opts.touch === false ? null : createSwipe(opts.touchTarget ?? root, {
    distance: opts.touchDistance,
    timeout: opts.touchTimeout,
    mouse: opts.touchMouse,
    ignore: opts.touchIgnore,
    // 轻点翻页：判定与禁区都在 swipe 层（按下的 target），动作在 tapNavigate。
    tap: !!tapNav,
    tapSlop: opts.tapSlop,
    tapTimeout: opts.tapTimeout,
    tapIgnore: opts.tapIgnore ?? TAP_IGNORE,
    onStart: () => {
      clearRebound()
      stage.style.transition = "none"     // 拖动中不要过渡位移，指到哪走到哪
    },
    onMove: info => {
      if (opts.touchFeedback === false || info.axis !== "x") return
      const wantPrev = info.dx > 0
      // 到头了还往那边拖 → 阻尼 0.25，给出「拖不动」的手感，而不是无反应
      const edge = (wantPrev && index <= 1) || (!wantPrev && index >= total)
      setSwipeOffset((info.dx * (edge ? 0.25 : 1)) / scale, 0)
    },
    onSwipe: dir => navKey(SWIPE_KEY[dir]),
    onTap: tapNavigate,
    onEnd: () => releaseDrag(),
  })
  if (swipe && opts.touchAction) root.style.setProperty("--md2s-touch-action", opts.touchAction)

  let ro = null
  if (typeof view?.ResizeObserver === "function") {
    ro = new view.ResizeObserver(() => fit())
    ro.observe(root)
  }

  show(Math.max(1, Math.min(total, opts.startIndex ?? 1)))
  fit()

  return {
    get index() { return index },
    get total() { return total },
    get step() { return stepping() ? shownOf(index - 1) : 0 },
    get steps() { return stepCountOf(index - 1) },
    get mode() { return mode },
    get stage() { return stage },
    get stepIssues() { return stepIssues },
    next: () => goto(index + 1),
    prev: () => goto(index - 1),
    go: k => goto(k),
    stepFwd,
    stepBack,
    /** 触发当前步（element）/当前页（slide）上第一个可激活元素的 click；返回是否命中 */
    activate,
    /** 运行时切形态（宿主偏好面板）：全部步进状态清零，当前页按新形态重放。
     *  page 形态的 browse 开关来自创建时的 opts，不随 setMode 变。 */
    setMode: m => {
      const next = m === "element" ? "element" : "page"
      if (next === mode) return
      mode = next
      syncBrowseClass()
      clearSteps()
      plans.clear()
      shown.clear()
      show(index)
    },
    /**
     * 步进表失效重建：宿主装饰页 DOM 后调用（如 exec 桥给代码块注入 ▶ 之后，页内
     * 新增了 [data-md2s-activatable] 步元素）——懒构建的表（尤其当前页，首次 show
     * 就建了）不含它们。全清重建，步进状态归零、当前页按新表重放（放映刚开场时
     * decorate 紧跟 deck.run，代价≈0）。纯翻页形态是空操作。
     */
    refreshSteps: () => {
      if (!stepping()) return
      clearSteps()
      plans.clear()
      shown.clear()
      show(index)
    },
    fit,
    destroy: () => {
      if (opts.keys !== false) keyTarget.removeEventListener("keydown", onKey)
      swipe?.destroy()
      clearRebound()
      setSwipeOffset(0, 0)
      stage.style.removeProperty("transition")
      ro?.disconnect()
      clearSteps()
      for (const s of sections) root.appendChild(s)   // 原序搬回
      stage.remove()
      root.classList.remove("md2s-player")
    },
  }
}

module.exports = { createDeckPlayer, PLAYER_CSS, TAP_IGNORE }
