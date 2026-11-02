"use strict"

/**
 * kit/quiz/panel.js — 课堂竞答面板：讲义里的题 → 「发放」按钮 → 结果回到讲义。
 *
 * 两块 UI，各司其职：
 *  1. **页内发放按钮**：贴在每道题的题干旁边。标 `data-md2s-activatable`——
 *     于是它同时是 player 的一个步进目标（翻页笔能走到它、Enter 能触发），
 *     也自动被 IR 抽取跳过（deck-entry 的 skipSelector 认这个属性），不污染 PPTX 导出。
 *  2. **底部结果浮层**：答题中显示倒计时与「已提交 N/M」（**不显示选项分布**——
 *     防后来者抄人气答案，与 classbuzz 大屏同规矩）；揭晓后只显示选项分布、最快与榜单。
 *     **不显示正确答案、不标正确项**——这块面板在投影上，全班都看得见，而答案
 *     classbuzz 已经单独推给学生自己的手机（`self_result`）。投影只呈现"班级整体"。
 *
 * 为什么结果用浮层而不是塞进幻灯片正文：md2slides 的版面在放映前就冻结了
 * （物理分页已收敛），往正文里塞东西会挤压版面、触发度量漂移；浮层不碰页 DOM。
 *
 * 浮层是「自封闭深色岛」：内部颜色/背景全部显式钉死（含 !important）——
 * 主题的 table / pre 样式会渗进来，不钉必打架（exec 浮层踩过同样的坑）。
 */

const { readQuizzes, ATTR_QUIZ } = require("../../core/quiz/parse")

const CSS_ID = "md2s-quiz-css"

const QUIZ_CSS = `
/* —— 页内发放按钮 —— */
/* align-self: flex-start 必需：按钮是 section（flex column）的直接子元素，
   默认 align-items: stretch 会把它拉满整页宽——看着像一条灰条，不像按钮。 */
.md2s-quiz-send { display: inline-flex; align-self: flex-start; align-items: center; gap: .4em;
  margin: .2em 0 .4em 0;
  padding: .28em .9em; font-size: 1em; line-height: 1.4; font-weight: 500;
  color: #f0f2f5; background: rgba(30, 34, 40, .92); border: 1px solid #4a5462;
  border-radius: .3em; cursor: pointer; user-select: none; vertical-align: middle;
  font-family: inherit; }
.md2s-quiz-send:hover { background: rgba(245, 150, 48, .92); border-color: #f59630; color: #1a1a1a; }
.md2s-quiz-send:disabled { opacity: .45; cursor: not-allowed; }
.md2s-quiz-send:disabled:hover { background: rgba(30, 34, 40, .92); border-color: #4a5462; color: #f0f2f5; }
.md2s-quiz-send.md2s-step-current { box-shadow: 0 0 0 .45em rgba(255, 190, 40, .8); }
.md2s-quiz-send .md2s-q-tag { font-size: .78em; opacity: .7; font-weight: 400; }

/* —— 底部浮层 —— */
.md2s-quiz-panel { position: fixed; left: 4%; right: 4%; bottom: 0; z-index: 100000;
  display: flex; flex-direction: column; max-height: 46%;
  background: #1e1e1e !important; color: #d4d4d4 !important;
  border: 1px solid #3c3c3c !important; border-radius: 8px 8px 0 0 !important;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, .45); font-size: 13px; overflow: hidden;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.md2s-quiz-panel[hidden] { display: none !important; }
/* 收起态：只留标题条（还能再展开），别把面板整个藏掉——藏掉就找不回来了。 */
.md2s-quiz-panel.md2s-quiz-collapsed .md2s-quiz-body { display: none !important; }
.md2s-quiz-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: #2a2a2a !important; border-bottom: 1px solid #3c3c3c !important; }
.md2s-quiz-title { font-weight: 600; color: #eee !important; }
.md2s-quiz-status { display: inline-flex; align-items: center; gap: 5px; color: #9cdcfe !important;
  font-variant-numeric: tabular-nums; }
.md2s-quiz-dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
.md2s-quiz-dot.on { background: #4ec9b0; }
.md2s-quiz-dot.off { background: #e06c6c; }
.md2s-quiz-dot.wait { background: #d7ba7d; }
.md2s-quiz-spacer { flex: 1; }
.md2s-quiz-btn { padding: 3px 9px; font-size: 12px; line-height: 1.4; color: #ddd !important;
  background: #333 !important; border: 1px solid #4a4a4a !important; border-radius: 4px;
  cursor: pointer; font-family: inherit; }
.md2s-quiz-btn:hover { background: #3d3d3d !important; }
.md2s-quiz-btn:disabled { opacity: .45; cursor: not-allowed; }
.md2s-quiz-body { flex: 1; overflow: auto; padding: 10px 12px; }

.md2s-quiz-state { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.md2s-quiz-big { font-size: 22px; font-weight: 600; color: #f0f2f5 !important; }
.md2s-quiz-sub { color: #9aa4b2 !important; }
.md2s-quiz-bar { height: 10px; border-radius: 5px; background: #333 !important; overflow: hidden;
  margin: 10px 0 4px; }
.md2s-quiz-bar > i { display: block; height: 100%; background: linear-gradient(90deg, #f59630, #ffcf6b);
  width: 0; transition: width .18s ease-out; }
.md2s-quiz-note { color: #8a94a3 !important; font-size: 12px; margin-top: 2px; }

.md2s-quiz-dist { display: flex; flex-direction: column; gap: 4px; }
.md2s-quiz-row { display: flex; align-items: center; gap: 8px; }
.md2s-quiz-abc { flex: none; width: 1.4em; text-align: center; font-weight: 600; color: #c9d1d9 !important; }
.md2s-quiz-txt { flex: 1; color: #d4d4d4 !important; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.md2s-quiz-track { flex: none; width: 38%; height: 14px; background: #2c2c2c !important;
  border-radius: 3px; overflow: hidden; }
.md2s-quiz-track > i { display: block; height: 100%; background: #5a6472 !important; width: 0; }
.md2s-quiz-n { flex: none; width: 3.2em; text-align: right; color: #9aa4b2 !important;
  font-variant-numeric: tabular-nums; }

.md2s-quiz-foot { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  margin-top: 10px; padding-top: 8px; border-top: 1px solid #333 !important; }
.md2s-quiz-fast { color: #ffd479 !important; }
.md2s-quiz-lb { display: flex; gap: 12px; flex-wrap: wrap; }
.md2s-quiz-lbrow { display: inline-flex; gap: 6px; align-items: baseline; }
.md2s-quiz-rank { color: #7d8794 !important; }
.md2s-quiz-nm { color: #e6e6e6 !important; }
.md2s-quiz-sc { color: #4ec9b0 !important; font-variant-numeric: tabular-nums; }
`

const LETTERS = "ABCDEF"

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
))

/**
 * 挂载竞答面板。
 *
 * **讲义里没有题，就一点痕迹都不留**：不注入样式、不建面板、不订阅任何事件。
 * 面板不是「竞答服务的状态灯」——它是「这道讲义有题」的延伸。讲义里一道题都没有时，
 * 底部那条「已连接 · 房间 XXXX」纯属噪声（而且会出现在投影上）。
 *
 * @param {Document|Element} doc   放映文档（Typora 壳里是 iframe 的 document）
 * @param {object} opts
 * @param {object} opts.client      kit/quiz/client.js 造出来的客户端
 * @param {boolean} [opts.showPanel=true]  false = 只挂发放按钮，不挂浮层
 * @returns {{destroy: Function, refresh: Function, panel: Element|null}}
 */
function mountQuizPanel(doc, opts = {}) {
  const client = opts.client
  const showPanel = opts.showPanel !== false
  if (!doc?.createElement) throw new Error("mountQuizPanel(doc, opts)：doc 必须是文档")

  // 没配置竞答服务 → 一点痕迹都不留：页内不冒「发放」按钮，底部不冒面板。
  // 讲课是主，竞答是可选增强——不能因为没配就在讲义上留一堆点不动的按钮。
  const noop = {
    active: false,
    panel: null,
    decorate: () => 0,
    render: () => {},
    onStatus: () => {},
    onEvent: () => {},
    destroy: () => {},
  }
  if (!client) return noop

  // 先扫题：讲义里没有题 → 整条链路不启动（连上了也不显示面板）。
  // 扫的是整份文档，不只当前页——题在别的页上，面板照样该在。
  const quizzes = readQuizzes(doc)
  if (!quizzes.length) return noop

  if (!doc.getElementById(CSS_ID)) {
    const style = doc.createElement("style")
    style.id = CSS_ID
    style.textContent = QUIZ_CSS
    doc.head.appendChild(style)
  }

  // —— 状态 ——
  let online = false
  let phase = "idle"        // idle | open | revealed
  let current = null        // 当前题（open 态）
  let result = null         // 最近一次结果
  let answered = 0
  let total = 0
  let timer = null
  let sendButtons = []

  const panel = showPanel ? doc.createElement("div") : null
  if (panel) {
    panel.className = "md2s-quiz-panel"
    panel.hidden = true
    doc.body.appendChild(panel)
  }

  // ============ 页内发放按钮 ============

  const buildSendButton = quiz => {
    const btn = doc.createElement("button")
    btn.className = "md2s-quiz-send"
    btn.type = "button"
    // player 的可激活元素契约：翻页笔能走到它、Enter 能触发；
    // 同时被 IR 抽取的 skipSelector 跳过，不进 PPTX 导出。
    btn.setAttribute("data-md2s-activatable", "")
    btn.dataset.md2sQuiz = quiz.qid
    const tag = doc.createElement("span")
    tag.className = "md2s-q-tag"
    tag.textContent = "课堂竞答"
    btn.appendChild(tag)
    const label = doc.createElement("span")
    label.className = "md2s-q-label"
    label.textContent = "发放"
    btn.appendChild(label)

    btn.addEventListener("click", ev => {
      ev.stopPropagation()
      onSend(quiz, btn)
    })
    return btn
  }

  const onSend = (quiz, btn) => {
    if (!online) return
    if (quiz.answer == null || quiz.answer < 0 || quiz.answer >= quiz.options.length) return
    client.openQuestion({
      qid: quiz.qid,
      stem: quiz.stem,
      options: quiz.options,
      answer: quiz.answer,
      limitSec: quiz.limitSec,
    })
    // 标记成「已发放」：按钮随即禁用，防止一题连发好几遍（服务端也会拒，但少发一次是一次）。
    btn.dataset.md2sSent = "1"
    syncButtons()
  }

  /** 回到待机：清掉所有「已发放」标记，按钮重新可用。 */
  const resetSent = () => {
    for (const { btn } of sendButtons) delete btn.dataset.md2sSent
  }

  /** 给每道题挂发放按钮。幂等：已有按钮就跳过。重新扫一遍（题可能在挂载之后才进 DOM）。 */
  const decorate = () => {
    const found = readQuizzes(doc)
    for (const quiz of found) {
      if (quiz.stemEl.querySelector(".md2s-quiz-send")) continue
      if (!quiz.options.length) continue
      const btn = buildSendButton(quiz)
      quiz.stemEl.insertAdjacentElement("afterend", btn)
      sendButtons.push({ quiz, btn })
    }
    syncButtons()
    return found.length
  }

  const syncButtons = () => {
    for (const { quiz, btn } of sendButtons) {
      const noAnswer = quiz.answer == null || quiz.answer < 0 || quiz.answer >= quiz.options.length
      const sent = btn.dataset.md2sSent === "1"
      btn.disabled = !online || noAnswer || sent
      btn.title = !online
        ? "课堂竞答服务未连接（检查 classbuzz 是否已启动、房间号与房口令是否正确）"
        : noAnswer
          ? `这道题没写答案：给标记加上 answer，例如 <!--quiz {"answer":"B"}-->`
          : sent
            ? "本题已发放（回到待机后可再发）"
            : "发放这道题到学生端"
      const label = btn.querySelector(".md2s-q-label")
      if (label) label.textContent = sent ? "已发放" : "发放"
    }
  }

  // ============ 浮层渲染 ============

  const setDot = cls => {
    const dot = panel?.querySelector(".md2s-quiz-dot")
    if (dot) dot.className = `md2s-quiz-dot ${cls}`
  }

  const render = () => {
    if (!panel) return
    const status = panel.querySelector(".md2s-quiz-status-text")
    if (status) {
      status.textContent = online
        ? `已连接${client.room ? " · 房间 " + client.room : ""}`
        : "未连接"
    }
    setDot(online ? "on" : "off")

    const body = panel.querySelector(".md2s-quiz-body")
    if (!body) return

    if (phase === "open" && current) {
      const left = Math.max(0, Math.ceil(((current.deadline || 0) - Date.now()) / 1000))
      body.innerHTML = `
        <div class="md2s-quiz-state">
          <span class="md2s-quiz-big">${left}s</span>
          <span class="md2s-quiz-sub">答题中 · 已提交 <b>${answered}</b> / ${total || "—"} 人</span>
        </div>
        <div class="md2s-quiz-bar"><i style="width:${total ? Math.round(answered / total * 100) : 0}%"></i></div>
        <div class="md2s-quiz-note">选项分布等揭晓才放出（防抄）</div>`
      return
    }

    if (phase === "revealed" && result) {
      const max = Math.max(1, ...(result.distribution || []))
      // **不标正确项、不显示答案文字**——这块面板在投影上，全班都看得见。
      // 答案归学生自己的手机（classbuzz 的 self_result 已经单独推给他），
      // 投影只呈现"班级整体"：各选项选了多少人、谁最快、当前榜单。
      // 给正确项上色也是泄题——青色的那一条就是变相的"答案在这"。
      const rows = (result.options || []).map((text, i) => {
        const n = (result.distribution || [])[i] || 0
        return `<div class="md2s-quiz-row">
          <span class="md2s-quiz-abc">${LETTERS[i]}</span>
          <span class="md2s-quiz-txt">${esc(text)}</span>
          <span class="md2s-quiz-track"><i style="width:${Math.round(n / max * 100)}%"></i></span>
          <span class="md2s-quiz-n">${n} 人</span>
        </div>`
      }).join("")
      const top = (result.leaderboard || []).slice(0, 5).map(e => `
        <span class="md2s-quiz-lbrow">
          <span class="md2s-quiz-rank">${e.rank}</span>
          <span class="md2s-quiz-nm">${esc(e.name)}</span>
          <span class="md2s-quiz-sc">${e.score}</span>
        </span>`).join("")
      body.innerHTML = `
        <div class="md2s-quiz-dist">${rows}</div>
        <div class="md2s-quiz-foot">
          ${result.fastest ? `<span class="md2s-quiz-fast">最快：${esc(result.fastest.name)} ${(result.fastest.elapsedMs / 1000).toFixed(1)}s</span>` : ""}
          <span class="md2s-quiz-lb">${top}</span>
        </div>`
      return
    }

    body.innerHTML = `<div class="md2s-quiz-note">待机中 · 点题目旁的「发放」把题发给学生。</div>`
  }

  const show = () => { if (panel) panel.hidden = false }

  const buildPanel = () => {
    if (!panel) return
    panel.innerHTML = `
      <div class="md2s-quiz-head">
        <span class="md2s-quiz-dot off"></span>
        <span class="md2s-quiz-title">课堂竞答</span>
        <span class="md2s-quiz-status"><span class="md2s-quiz-status-text">未连接</span></span>
        <span class="md2s-quiz-spacer"></span>
        <button class="md2s-quiz-btn" data-act="close">收卷</button>
        <button class="md2s-quiz-btn" data-act="abort">作废</button>
        <button class="md2s-quiz-btn" data-act="fold">收起</button>
      </div>
      <div class="md2s-quiz-body"></div>`
    panel.querySelector('[data-act="close"]').onclick = () => client.closeQuestion()
    panel.querySelector('[data-act="abort"]').onclick = () => client.abortQuestion()
    // 收起 = 只折起内容（标题条留着，还能展开）；不整个藏掉，藏了就没法再回来。
    panel.querySelector('[data-act="fold"]').onclick = ev => {
      const folded = panel.classList.toggle("md2s-quiz-collapsed")
      ev.target.textContent = folded ? "展开" : "收起"
    }
  }

  // ============ 客户端事件 ============

  const onStatus = (state, info) => {
    online = state === "online"
    syncButtons()
    if (!online && info?.reason) {
      phase = "idle"
      result = null
      if (panel) {
        const body = panel.querySelector(".md2s-quiz-body")
        if (body) body.innerHTML = `<div class="md2s-quiz-note">${esc(info.reason)}</div>`
        show()
      }
    }
    render()
  }

  const onEvent = (msg, type) => {
    switch (type) {
      case "host_attach_ok":
        phase = msg.snapshot?.phase || "idle"
        result = phase === "revealed" ? msg.snapshot.lastResult : null
        current = phase === "open" ? msg.snapshot.question : null
        if (current) {
          answered = current.answered || 0
          total = current.total || 0
        }
        show()
        break
      case "question_open":
        phase = "open"
        current = msg
        answered = 0
        total = msg.total || 0
        result = null
        show()
        break
      case "progress":
        answered = msg.answered || 0
        total = msg.total || 0
        break
      case "question_result":
        phase = "revealed"
        result = msg
        current = null
        show()
        break
      case "round_closed":
        phase = "idle"
        current = null
        result = null
        break
      case "room_state":
        // 房间状态广播：phase 变了要跟着走。关键是 idle——那是「下一题/作废」之后，
        // 没有它面板会一直停在上一题的结果上（room_state 是唯一带 phase 的广播）。
        total = msg.playerCount || total
        if (msg.phase === "idle") {
          phase = "idle"
          current = null
          result = null
          resetSent()
        }
        break
      default:
        break
    }
    syncButtons()
    render()
  }

  // 倒计时：open 态每秒刷新一次剩余时间
  timer = setInterval(() => {
    if (phase === "open" && current) render()
  }, 1000)

  buildPanel()
  decorate()

  // 订阅客户端（面板是客户端之后才挂上来的，所以走订阅而不是构造期回调）
  if (client) {
    client.on("*", onEvent)
    client.onStatus(onStatus)
    onStatus(client.state, null)
  }

  return {
    active: true,
    panel,
    decorate,
    render,
    onStatus,
    onEvent,
    destroy() {
      sendButtons = []
      if (timer) clearInterval(timer)
      timer = null
      panel?.remove()
    },
  }
}

module.exports = { mountQuizPanel, QUIZ_CSS, CSS_ID }
