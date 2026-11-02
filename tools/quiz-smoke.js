"use strict"

/**
 * quiz-smoke.js — 课堂竞答的端到端验证：讲义里的题 → 发放 → 学生抢答 → **结果回到讲义**。
 *
 * 这条链路跨两个进程（classbuzz 服务端 + md2slides 侧），所以这里真的把服务端拉起来、
 * 真的走 WebSocket、真的让一个"学生"作答，最后断言**讲义这一侧的面板里出现了
 * 正确答案、分布与榜单**——正是"结果回到 md2slides"这件事本身。
 *
 * 面板跑在 jsdom 里（kit/quiz/panel.js 只碰 DOM，不碰布局），Node 22 自带全局
 * WebSocket，测试不需要额外依赖。
 *
 * Usage:  node tools/quiz-smoke.js
 */

const assert = require("assert/strict")
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const { JSDOM } = require("jsdom")

const { compose } = require("../core/compose")
const { createQuizClient } = require("../kit/quiz/client")
const { mountQuizPanel } = require("../kit/quiz/panel")

const CLASSBUZZ = path.resolve(__dirname, "..", "..", "classbuzz")
const PORT = Number(process.env.QUIZ_SMOKE_PORT) || 3198
const WS_URL = `ws://127.0.0.1:${PORT}`

// md2slides 可以脱离生态单独用（npm i @wenlanstudio/md2slides）。classbuzz 不在旁边时，
// 这条跨进程测试没法跑——跳过并说明，不让整个 test 链挂掉。
if (!fs.existsSync(path.join(CLASSBUZZ, "server", "index.js"))) {
  console.log("SKIP  课堂竞答端到端测试：旁边没有 classbuzz/（生态兄弟目录布局）")
  process.exit(0)
}

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok    ${name}`)
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error.message}`)
    process.exitCode = 1
  }
}

/* ---------- 一条极简的 WS 客户端（够本测试用） ---------- */

function wsClient() {
  const ws = new WebSocket(WS_URL)
  const buf = []
  const waiters = []
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data)
    const i = waiters.findIndex(w => w.types.includes(m.type))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
    else buf.push(m)
  })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", reject)
  })
  return {
    ws,
    opened,
    send: o => ws.send(JSON.stringify(o)),
    next: (types, timeout = 8000) =>
      new Promise((resolve, reject) => {
        const list = Array.isArray(types) ? types : [types]
        const i = buf.findIndex(m => list.includes(m.type))
        if (i >= 0) return resolve(buf.splice(i, 1)[0])
        waiters.push({ types: list, resolve })
        setTimeout(() => reject(new Error(`超时等待 [${list.join(",")}]`)), timeout)
      }),
    close: () => ws.close(),
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- 讲义：一道题 + 一道没写答案的题 ---------- */

const LECTURE = [
  "# 课堂竞答",
  "",
  "## 随堂测",
  "",
  '<!--quiz {"answer":"B","limit":30}-->',
  "1 + 1 = ?",
  "",
  "- 1",
  "- 2",
  "- 3",
  "- 4",
  "",
  "## 没写答案的题",
  "",
  '<!--quiz {"limit":20}-->',
  "这道题故意没写答案",
  "",
  "- 甲",
  "- 乙",
  "",
].join("\n")

async function main() {
  const srv = spawn(process.execPath, ["server/index.js"], {
    cwd: CLASSBUZZ,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  srv.stderr.on("data", d => process.stderr.write("[classbuzz!] " + d))

  try {
    // 等服务端起来
    for (let i = 0; i < 60; i++) {
      try {
        await new Promise((res, rej) => {
          const s = new WebSocket(WS_URL)
          s.addEventListener("open", () => { s.close(); res() })
          s.addEventListener("error", rej)
        })
        break
      } catch { await sleep(100) }
    }

    /* ---- 1. 教师建房间，拿房口令 ---- */
    const teacher = wsClient()
    await teacher.opened
    teacher.send({ type: "host_create" })
    const hostOk = await teacher.next("host_ok")
    const ROOM = hostOk.room
    const PASS = hostOk.snapshot.passcode
    check("教师建房拿到房间号与房口令", () => {
      assert.match(ROOM, /^[23456789A-Z]{4}$/)
      assert.match(PASS, /^[23456789A-Z]{6}$/)
    })

    /* ---- 2. 学生进房 ---- */
    const student = wsClient()
    await student.opened
    student.send({ type: "join", room: ROOM, name: "小明" })
    const joinOk = await student.next("join_ok")
    check("学生进房成功", () => assert.equal(joinOk.role, "player"))

    /* ---- 3. md2slides 侧：讲义渲染出题，挂面板，连上 classbuzz ---- */
    const dom = new JSDOM("<!doctype html><html><body></body></html>")
    const doc = dom.window.document
    const deck = compose(LECTURE, { document: doc })
    doc.body.innerHTML = deck.html

    const client = createQuizClient({ url: WS_URL, room: ROOM, passcode: PASS })
    const panel = mountQuizPanel(doc, { client })

    const buttons = [...doc.querySelectorAll(".md2s-quiz-send")]
    check("讲义里两道题各挂一个发放按钮", () => {
      assert.equal(buttons.length, 2)
      assert.ok(buttons[0].hasAttribute("data-md2s-activatable"), "按钮应是可激活元素（翻页笔/Enter 可达）")
    })
    check("未连接时按钮是禁用的", () => {
      assert.equal(buttons[0].disabled, true)
    })

    client.connect()
    await sleep(400)
    check("凭房间号+房口令接入成功", () => {
      assert.equal(client.state, "online")
    })

    /* ---- 4. 没写答案的题不许发放 ---- */
    const noAnswer = buttons[1]
    check("没写答案的题：按钮禁用并说明原因", () => {
      assert.equal(noAnswer.disabled, true)
      assert.match(noAnswer.title, /没写答案/)
    })

    /* ---- 5. 点发放：学生端收到题 ---- */
    buttons[0].click()
    const open = await student.next("question_open", 5000)
    check("点「发放」后学生端收到题目（且不含答案）", () => {
      assert.equal(open.stem, "1 + 1 = ?")
      assert.deepEqual(open.options, ["1", "2", "3", "4"])
      assert.equal("answer" in open, false, "作答期间不得下发答案")
    })

    /* ---- 6. 学生抢答 ---- */
    // 先订阅再作答：这道题全班只有一个人，作答后服务端**立刻**判定全员交卷并广播结果，
    // 晚一步注册监听就收不到了（生产路径没这问题——面板是先订阅、后连接）。
    const resultPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("面板没等到 question_result")), 8000)
      client.on("question_result", m => { clearTimeout(t); resolve(m) })
    })
    student.send({ type: "answer", choice: 1 })
    const ack = await student.next("answer_ack")
    check("学生作答被接受", () => assert.equal(ack.accepted, true))

    /* ---- 7. 结果回到 md2slides 面板（本题的核心断言） ---- */
    const result = await resultPromise
    const bodyText = doc.querySelector(".md2s-quiz-body").textContent
    check("结果回到讲义面板：分布 / 最快 / 榜单都在", () => {
      assert.equal(result.answer, 1)
      assert.match(bodyText, /1 人/)
      assert.match(bodyText, /小明/)
      assert.match(bodyText, /最快/)
    })
    // 投影是全班可见的：答案与"正确项标色"都不该出现在面板上
    // （答案 classbuzz 已单独推给学生手机，见 self_result）
    check("面板不泄露答案：无答案文字、无正确项标色", () => {
      assert.equal(doc.querySelector(".md2s-quiz-answer"), null)
      assert.equal(doc.querySelector(".md2s-quiz-row.correct"), null)
      assert.doesNotMatch(bodyText, /正确答案/)
      assert.doesNotMatch(bodyText, /· 2/)
      // 但分布本身要在（这是"班级整体"，不属于泄题）
      assert.equal(doc.querySelectorAll(".md2s-quiz-row").length, 4)
    })
    check("面板浮层已展开（不再是收起态）", () => {
      assert.equal(panel.panel.hidden, false)
    })

    /* ---- 8. 下一题后面板回到待机、按钮可再次发放 ---- */
    client.nextQuestion()
    await sleep(300)
    check("「下一题」后面板回到待机", () => {
      const t = doc.querySelector(".md2s-quiz-body").textContent
      assert.match(t, /待机中/)
    })
    check("待机后发放按钮恢复可用", () => {
      assert.equal(buttons[0].disabled, false)
      assert.match(buttons[0].querySelector(".md2s-q-label").textContent, /发放/)
    })

    /* ---- 9. 口令错了接不上 ---- */
    const wrong = createQuizClient({ url: WS_URL, room: ROOM, passcode: "ZZZZZZ" })
    const fail = new Promise(resolve => wrong.on("host_attach_fail", resolve))
    wrong.connect()
    const failed = await fail
    check("口令不对 → 接入失败并给出原因", () => {
      assert.match(failed.reason, /房口令不正确/)
      assert.equal(wrong.state, "error")
    })

    wrong.dispose()
    client.dispose()
    panel.destroy()
    teacher.close()
    student.close()

    /* ---- 10. 讲义里没有题 → 一点痕迹都不留（不建面板、不注入样式、不连） ---- */
    const bare = new JSDOM("<!doctype html><html><body></body></html>")
    const bareDoc = bare.window.document
    const bareDeck = compose("# 没有题的讲义\n\n就一段普通文字。\n", { document: bareDoc })
    bareDoc.body.innerHTML = bareDeck.html
    const bareClient = createQuizClient({ url: WS_URL, room: ROOM, passcode: PASS })
    const barePanel = mountQuizPanel(bareDoc, { client: bareClient })
    check("没有题的讲义：面板压根不建，也不连", () => {
      assert.equal(barePanel.active, false)
      assert.equal(barePanel.panel, null)
      assert.equal(bareDoc.querySelector(".md2s-quiz-panel"), null)
      assert.equal(bareDoc.getElementById("md2s-quiz-css"), null, "样式也不该注入")
      assert.equal(bareDoc.querySelector(".md2s-quiz-send"), null, "不该冒发放按钮")
      assert.equal(bareClient.state, "offline", "不该发起连接")
    })

    console.log(`\nQUIZ SMOKE PASS — ${passed} 组断言全部通过`)
  } catch (error) {
    console.error("\nQUIZ SMOKE FAIL:", error.stack || error.message)
    process.exitCode = 1
  } finally {
    srv.kill()
  }
}

main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 150))
