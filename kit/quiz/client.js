"use strict"

/**
 * kit/quiz/client.js — 课堂竞答（classbuzz）的浏览器侧客户端。
 *
 * 这个文件是 md2slides 里**唯一**知道 classbuzz 存在的地方，也是整套接入的咽喉：
 * 讲义里的题 → `host_open` 发放 → 学生抢答 → `question_result` 回到讲义。
 *
 * 为什么放在 kit 层：kit 是「浏览器侧、框架无关」的一层（kit/player.js 同款定位）。
 * 这个客户端只依赖浏览器原生 WebSocket，不碰任何编辑器 API、不碰 DOM——
 * 于是 Typora 放映、导出的独立 HTML、未来的 marktext 都能用同一份。
 *
 * 为什么用 WebSocket 而不是 HTTP 轮询：
 *  - 倒计时与「已提交 N/M」是高频的，轮询要么延迟要么打爆；
 *  - 发放是**上行**动作，HTTP 也行；但结果回传是**下行**推送，HTTP 得自己造轮询。
 *  一条 WS 同时承载两个方向，是最短的路径。
 *
 * 身份：凭「房间号 + 房口令」换一个 host 角色（classbuzz 的 `host_attach`）。
 * 不拿 hostToken——它躺在教师浏览器的 localStorage 里，别的进程读不到。
 *
 * 降级铁律：**竞答挂了不能挡住讲课**。所有失败路径都只影响竞答面板本身，
 * 放映、翻页、导出全部照常。
 */

const DEFAULT_URL = "ws://127.0.0.1:3000"

/** 心跳：15s 一轮；45s 收不到任何下行就当死链，主动断开重连。 */
const HEARTBEAT_MS = 15000
const DEAD_AFTER_MS = 45000
const RETRY_MAX_MS = 5000

/**
 * @param {object} opts
 * @param {string} [opts.url]      classbuzz 的 WS 地址，默认 ws://127.0.0.1:3000
 * @param {string} opts.room       房间号
 * @param {string} opts.passcode   房口令
 * @param {Function} [opts.onEvent]  业务事件回调 (type, payload)
 * @param {Function} [opts.onStatus] 连接状态回调 ("connecting"|"online"|"offline"|"error", info)
 * @param {Function} [opts.WebSocketImpl] 注入 WS 实现（测试用；默认取全局 WebSocket）
 */
function createQuizClient(opts = {}) {
  const url = opts.url || DEFAULT_URL
  const room = String(opts.room || "").trim().toUpperCase()
  const passcode = String(opts.passcode || "").trim().toUpperCase()
  const onEvent = opts.onEvent || (() => {})
  const onStatus = opts.onStatus || (() => {})
  const WSImpl = opts.WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null)

  let ws = null
  let hb = null
  let retry = 0
  let lastIn = 0
  let closed = false
  let state = "offline"

  // 订阅式：面板是客户端造好之后才挂上来的，两者不能互相构造。
  const handlers = new Map()          // type -> Set<fn>
  const statusHandlers = new Set()    // Set<fn>
  const emit = (type, payload) => {
    for (const fn of handlers.get(type) || []) {
      try { fn(payload, type) } catch (error) { console.warn("[md2slides] 竞答事件处理异常", error) }
    }
    for (const fn of handlers.get("*") || []) {
      try { fn(payload, type) } catch (error) { console.warn("[md2slides] 竞答事件处理异常", error) }
    }
  }

  const setState = (next, info) => {
    if (state === next && !info) return
    state = next
    onStatus(next, info)
    for (const fn of statusHandlers) {
      try { fn(next, info) } catch (error) { console.warn("[md2slides] 竞答状态处理异常", error) }
    }
  }

  const clearHeartbeat = () => {
    if (hb) clearInterval(hb)
    hb = null
  }

  const send = obj => {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  const connect = () => {
    if (closed) return
    if (!WSImpl) {
      setState("error", { reason: "当前环境没有 WebSocket（浏览器外运行？）" })
      return
    }
    if (!room || !passcode) {
      setState("error", { reason: "未配置房间号或房口令" })
      return
    }
    setState("connecting")
    try {
      ws = new WSImpl(url)
    } catch (error) {
      setState("error", { reason: `无法连接 ${url}：${error?.message ?? error}` })
      return
    }

    ws.onopen = () => {
      retry = 0
      lastIn = Date.now()
      // 房口令换 host 角色；服务端回 host_attach_ok 才算真正连上
      send({ type: "host_attach", room, passcode })
      clearHeartbeat()
      hb = setInterval(() => {
        send({ type: "ping" })
        if (Date.now() - lastIn > DEAD_AFTER_MS) {
          try { ws.close() } catch { /* 下面统一处理 */ }
        }
      }, HEARTBEAT_MS)
    }

    ws.onmessage = ev => {
      lastIn = Date.now()
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      switch (msg.type) {
        case "host_attach_ok":
          setState("online", { room: msg.room, snapshot: msg.snapshot })
          emit("host_attach_ok", msg)
          return
        case "host_attach_fail":
          setState("error", { reason: msg.reason || "接入失败" })
          emit("host_attach_fail", msg)
          return
        case "question_open":
          emit("question_open", msg)
          return
        case "progress":
          emit("progress", msg)
          return
        case "question_result":
          emit("question_result", msg)
          return
        case "round_closed":
          emit("round_closed", msg)
          return
        case "room_state":
          emit("room_state", msg)
          return
        case "error":
          emit("error", msg)
          return
        default:
          return
      }
    }

    ws.onclose = () => {
      clearHeartbeat()
      ws = null
      if (closed) return
      setState("offline")
      // 指数退避重连：手机热点抖动、笔记本睡眠唤醒后能自己回来
      const delay = Math.min(RETRY_MAX_MS, 500 * Math.pow(2, retry++))
      setTimeout(connect, delay)
    }

    ws.onerror = () => {
      // onclose 紧随其后，重连逻辑在那边统一处理
    }
  }

  return {
    url,
    room,
    get state() { return state },
    connect,
    /** 订阅业务事件；type 为 "*" 时收全部。返回退订函数。 */
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type).add(fn)
      return () => handlers.get(type)?.delete(fn)
    },
    /** 订阅连接状态变化：("connecting"|"online"|"offline"|"error", info) */
    onStatus(fn) {
      statusHandlers.add(fn)
      return () => statusHandlers.delete(fn)
    },
    /** 发一条协议消息（不开题类动作走这里） */
    send,
    /** 发放一道题：classbuzz 的 host_open */
    openQuestion(question) {
      return send({
        type: "host_open",
        qid: question.qid,
        stem: question.stem,
        options: question.options,
        answer: question.answer,
        limitSec: question.limitSec,
      })
    },
    closeQuestion() { return send({ type: "host_close" }) },
    abortQuestion() { return send({ type: "host_abort" }) },
    nextQuestion() { return send({ type: "host_next" }) },
    dispose() {
      closed = true
      clearHeartbeat()
      try { ws && ws.close() } catch { /* 已关 */ }
      ws = null
    },
  }
}

module.exports = { createQuizClient, DEFAULT_URL }
