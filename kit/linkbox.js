"use strict"

/**
 * kit/linkbox.js — 放映态超链接网页浮层（翻页笔可开关，2026-11-17）。
 *
 * 定位与 kit/lightbox.js / kit/player.js 同构：零依赖、不碰 Node/编辑器 API，
 * 宿主只负责接线。交互、层级、互斥全部照抄 lightbox 的成熟契约——用户的话是
 * 「操作类似代码运行、图片查看，全程可用翻页笔开关」。
 *
 * **为什么一个字节都不碰原 `<a>` DOM**（与 lightbox 不碰 img 同源）：
 *   - IR 的 `skipSelector` 是 `[data-md2s-activatable]`，给链接打这个标记等于让
 *     它在 PPTX/IR 导出里消失；
 *   - 所以触发靠事件委托认 `a[href]`，Enter 由 player 的 activate→findLink 命中后
 *     派发 click，本模块在 document capture 上接手；
 *   - 显示用浮层内新建的 `<iframe>`，不复用、不改写原链接。
 *
 * **能不能显示网页**：宿主（wenlan 主进程）会在响应头到达渲染器前对 iframe
 * 子框架剥掉 X-Frame-Options / CSP frame-ancestors，故绝大多数站点（含课堂里
 * http://node0:8088 这类本地服务页）都能在浮层内直接显示。极少数另有登录墙 /
 * 严格 CSP 的站点仍可能异常，故工具条保留「在浏览器打开」按钮（翻页笔可达）——
 * 走宿主的 onOpenExternal 回调（宿主用 shell.openExternal），任何链接兜底能看。
 *
 * 交互全表（与 lightbox 一致）：
 * | 输入 | 行为 |
 * |---|---|
 * | Enter（当前步在链接上）| player activate→click → 打开浮层 |
 * | ← → / PgUp/PgDn 上一页/下一页 | 工具条按钮间移动焦点，到边界停住；同页多链接时 ⟲ 前后切链接 |
 * | Enter / 空格（确定键）| 按下当前聚焦按钮（落在 ✕ 即关闭）|
 * | Esc / ✕ | 关闭，焦点归还播放器，回原页继续放映 |
 *
 * 输入隔离：浮层挂 `<body>` 不进 `#deck`，键盘在 window capture 抢在播放器前；
 * 打开时派发 `md2s-overlay-dismiss` 请其它浮层让位（与 exec/lightbox/quiz 互斥）。
 */

const CSS_ID = "md2s-linkbox-css"

const LINKBOX_CSS = `
.md2s-linkbox { position: fixed; inset: 0; z-index: 100002; background: #111418;
  display: flex; flex-direction: column; color: #eee;
  opacity: 0; transition: opacity .15s ease-out; }
.md2s-linkbox[hidden] { display: none !important; }
.md2s-linkbox.md2s-linkbox-on { opacity: 1; }
.md2s-linkbox-bar { flex: none; display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; background: #1b1f26; border-bottom: 1px solid #30363d;
  font-size: 13px; line-height: 1; }
.md2s-linkbox-title { font-weight: 600; color: #eee; }
.md2s-linkbox-url { color: #9cdcfe; opacity: .9; min-width: 0; flex: 1 1 auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.md2s-linkbox-bar button { flex: none; padding: 6px 10px; border: 1px solid #555;
  border-radius: 4px; background: #2a2a2a; color: #eee; font-size: 13px; cursor: pointer; }
.md2s-linkbox-bar button:hover { background: #3a3a3a; }
.md2s-linkbox-bar button[disabled] { opacity: .4; cursor: default; }
.md2s-linkbox-bar button[tabindex='-1']:focus { outline: 1px solid #7ab3d9; outline-offset: 2px; }
.md2s-linkbox-frame { flex: 1 1 auto; width: 100%; border: 0; background: #fff; }
.md2s-linkbox-note { flex: none; padding: 5px 14px; background: #161a20;
  border-top: 1px solid #30363d; font-size: 12px; color: #8b949e; }
.md2s-linkbox-note:empty { display: none; }
`

/**
 * @param {Document} doc 放映 iframe 的 document
 * @param {object} [opts]
 * @param {Function}[opts.currentSlide] 当前页查询（默认 `.md2s-current`）
 * @param {Function}[opts.onOpenExternal] (url: string) => void  宿主用系统浏览器打开
 * @param {Function}[opts.onClose] 关闭回调，宿主在此把焦点还给播放器容器
 * @returns {{ openAt: Function, close: Function, destroy: Function,
 *             isOpen: boolean, count: number, index: number }}
 */
function mountLinkbox(doc, opts = {}) {
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("mountLinkbox(doc, opts)：doc 必须是 Document")
  }
  const view = doc.defaultView ?? null
  const body = doc.body ?? doc.documentElement

  if (!doc.getElementById(CSS_ID)) {
    const style = doc.createElement("style")
    style.id = CSS_ID
    style.textContent = LINKBOX_CSS
    doc.head.appendChild(style)
  }

  const el = doc.createElement("div")
  el.className = "md2s-linkbox"
  el.hidden = true
  el.innerHTML =
    '<div class="md2s-linkbox-bar">' +
    '<span class="md2s-linkbox-title">链接</span>' +
    '<span class="md2s-linkbox-url"></span>' +
    '<button data-act="prev" title="上一链接（←）">‹</button>' +
    '<button data-act="next" title="下一链接（→）">›</button>' +
    '<button data-act="external" title="在浏览器打开（翻页笔确定键可达）">↗ 浏览器打开</button>' +
    '<button data-act="close" title="关闭（Esc）">✕</button>' +
    "</div>" +
    '<iframe class="md2s-linkbox-frame" title="网页预览"></iframe>' +
    '<div class="md2s-linkbox-note">网页在浮层内直接显示；个别站点若无法加载，点「↗ 浏览器打开」查看。</div>'
  body.appendChild(el)

  const frame = el.querySelector(".md2s-linkbox-frame")
  const urlEl = el.querySelector(".md2s-linkbox-url")
  const noteEl = el.querySelector(".md2s-linkbox-note")
  const btn = act => el.querySelector(`.md2s-linkbox-bar button[data-act="${act}"]`)

  let items = []            // 打开那一刻当前页里的链接（DOM 序）
  let idx = -1
  let opened = false
  let opener = null         // 打开时的那个 <a>，关闭交给宿主做焦点锚点

  /**
   * 翻页笔只有「上一页/下一页/确定」三个键。浮层开着时 onKey 在 window capture
   * 吞掉全部按键，焦点只落在工具条按钮上（到边界停住、不环绕——同 lightbox）。
   */
  const focusables = [...el.querySelectorAll(".md2s-linkbox-bar button")]
  const moveFocus = delta => {
    if (!focusables.length) return
    let i = focusables.indexOf(doc.activeElement)
    if (i < 0) i = delta > 0 ? -1 : 0
    for (let n = 0; n < focusables.length; n++) {
      const next = i + delta
      if (next < 0 || next >= focusables.length) return
      i = next
      if (!focusables[i].disabled) { focusables[i].focus(); return }
    }
  }
  const focusClose = () => {
    const x = focusables.find(b => b.getAttribute("data-act") === "close")
    if (x && !x.disabled) x.focus()
    else moveFocus(1)
  }

  const currentSlide = () => {
    if (typeof opts.currentSlide === "function") return opts.currentSlide(doc) ?? null
    return doc.querySelector(".md2s-current") ?? doc.querySelector("section[data-slide].active") ?? null
  }

  /** 当前页里的全部链接；家具、其它浮层里的不算。 */
  const collect = () => {
    const slide = currentSlide()
    if (!slide) return []
    return [...slide.querySelectorAll("a[href]")].filter(a => {
      try { if (a.closest(".md2s-linkbox, .md2s-lb, .md2s-exec-overlay, .md2s-quiz-panel")) return false } catch { /* 忽略 */ }
      return !!a.getAttribute("href")
    })
  }

  const show = i => {
    if (!items.length) return
    idx = (i + items.length) % items.length
    const a = items[idx]
    const href = a.getAttribute("href") ?? ""
    urlEl.textContent = href
    urlEl.title = href
    frame.src = href
    for (const act of ["prev", "next"]) btn(act).disabled = items.length < 2
  }

  const openAt = node => {
    if (!node || node.tagName !== "A") return false
    items = collect()
    const at = items.indexOf(node)
    if (at < 0) return false
    try {
      const Ctor = view?.CustomEvent ?? null
      if (Ctor) view.dispatchEvent(new Ctor("md2s-overlay-dismiss", { detail: { by: "linkbox" } }))
    } catch { /* 没有 CustomEvent 就算了 */ }
    opener = node
    opened = true
    el.hidden = false
    if (view?.requestAnimationFrame) view.requestAnimationFrame(() => el.classList.add("md2s-linkbox-on"))
    else el.classList.add("md2s-linkbox-on")
    view?.addEventListener?.("keydown", onKey, true)
    show(at)
    focusClose()
    return true
  }

  const close = () => {
    if (!opened) return
    const from = opener
    opener = null
    opened = false
    view?.removeEventListener?.("keydown", onKey, true)
    el.hidden = true
    el.classList.remove("md2s-linkbox-on")
    // 卸载 iframe：停掉页面（含音频/脚本），关掉后不留后台网页。
    frame.removeAttribute("src")
    if (typeof opts.onClose !== "function") {
      try { doc.activeElement?.blur?.() } catch { /* 没有 blur 就算了 */ }
    }
    opts.onClose?.(from)
  }

  /** 打开期间的键盘（window capture），与 lightbox 同一套翻页笔语义。 */
  const onKey = e => {
    if (!opened) return
    switch (e.key) {
      case "Escape": close(); break
      case "ArrowRight": if (items.length > 1) show(idx + 1); break
      case "ArrowLeft": if (items.length > 1) show(idx - 1); break
      case "PageDown": case "ArrowDown": case "Tab":
        moveFocus(e.shiftKey ? -1 : 1); break
      case "PageUp": case "ArrowUp":
        moveFocus(-1); break
      case "Enter": case " ": {
        const active = doc.activeElement
        if (active && focusables.includes(active)) active.click()
        else close()   // 焦点意外流到浮窗外：确定键当关闭
        break
      }
      default: break
    }
    if (e.cancelable) e.preventDefault()
    e.stopPropagation()
  }

  // 打开入口：事件委托认 a[href]，一个属性都不加到原链接上。
  const onClick = e => {
    if (opened) return
    const node = e.target
    if (!node || node.tagName !== "A") return
    if (e.button !== undefined && e.button !== 0) return
    try { if (node.closest(".md2s-linkbox, .md2s-lb, .md2s-exec-overlay, .md2s-quiz-panel")) return } catch { /* 忽略 */ }
    if (!openAt(node)) return
    if (e.cancelable) e.preventDefault()
    e.stopPropagation()
  }

  // 打开时派发 dismiss 请别的浮层让位；同时自己也响应别的浮层的 dismiss
  // （exec/quiz 打开时关掉本浮层）。用 by 判来源，避免自己开自己。
  const onDismiss = ev => {
    if (ev.detail && ev.detail.by !== "linkbox") close()
  }
  view?.addEventListener?.("md2s-overlay-dismiss", onDismiss)

  el.addEventListener("click", e => {
    if (!opened) return
    const act = e.target?.getAttribute?.("data-act")
    if (!act) return
    if (act === "close") close()
    else if (act === "prev") show(idx - 1)
    else if (act === "next") show(idx + 1)
    else if (act === "external") {
      const a = items[idx]
      if (a) opts.onOpenExternal?.(a.getAttribute("href") ?? "")
    }
  })
  doc.addEventListener("click", onClick, true)

  return {
    openAt,
    close,
    destroy: () => {
      close()
      doc.removeEventListener("click", onClick, true)
      view?.removeEventListener?.("md2s-overlay-dismiss", onDismiss)
      el.remove()
    },
    get isOpen() { return opened },
    get count() { return items.length },
    get index() { return idx },
  }
}

module.exports = { mountLinkbox, LINKBOX_CSS }
