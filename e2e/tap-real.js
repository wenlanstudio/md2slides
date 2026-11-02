"use strict"

/**
 * tap-real.js — 触屏轻点翻页的「真输入」回归。
 *
 * 为什么必须真机：`tools/smoke.js` 里的轻点用例跑在 jsdom，而 jsdom 没有 PointerEvent，
 * 手势层只能走 touch 路线——轻点链路真正依赖的三件东西在那边全是空的：
 *   ① 真实命中测试（点到底落在哪个元素上，决定"禁区"生效与否）；
 *   ② `setPointerCapture` 的时序（什么时候捕获会把随后补发的 click 目标改写掉，
 *      这条正是「按钮点不动」的病灶，合成事件永远重现不出来）；
 *   ③ 浏览器自己的双击缩放 / 滚动优化会不会把轻点吃掉。
 *
 * 这里用 puppeteer 的 Touchscreen（CDP Input.dispatchTouchEvent）点屏，断言：
 *   右半 = 前进（步进优先、步尽翻页）、左半 = 后退、按钮点了不翻页且 click 照常、
 *   真滑动仍翻一页、连点两下不触发页面缩放。
 *
 * 用法：`node e2e/tap-real.js`（需要本机 Chrome / Edge，`e2e/browser.js` 自动找）
 */

const path = require("path")

const { launch } = require("./browser")
const { bundleScript } = require("./bundle")

const show = (ok, msg) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`)
  if (!ok) process.exitCode = 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  #deck { position: fixed; inset: 0; }
  section[data-slide] { background: #fff; }
</style></head>
<body>
<div id="deck">
  <section data-slide>
    <h2>第一页</h2><p>甲段</p><p>乙段</p>
    <p><button id="btn" type="button">发放</button></p>
    <p><img id="pic" width="120" height="80" alt="图"
         src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></p>
  </section>
  <section data-slide><h2>第二页</h2><p>丙段</p></section>
  <section data-slide><h2>第三页</h2></section>
</div>
</body></html>`

const main = async () => {
  console.log("触屏轻点 · 真输入回归（puppeteer 真触摸）")
  const browser = await launch({})
  const errors = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 720, hasTouch: true })
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })

    await page.setContent(PAGE, { waitUntil: "load" })
    await page.addScriptTag({ content: bundleScript(require.resolve("./tap-entry")) })
    await page.evaluate(() => {
      // bundle 的 loader 只定义 installMd2slides，真正的入口 require 由它返回
      window.md2sTap = window.installMd2slides(window.__md2slides_externals ?? {})
      window.clicks = 0
      window.picClicks = 0
      document.getElementById("btn").addEventListener("click", () => { window.clicks += 1 })
      // 图片的 click 就是 lightbox 的入口（事件委托认 IMG）：它必须照样派发到 img，
      // 否则「点图看大图」会被我的手势层吃掉。
      document.getElementById("pic").addEventListener("click", () => { window.picClicks += 1 })
      window.p = window.md2sTap.createDeckPlayer(document.getElementById("deck"), {
        slideWidth: 1920, slideHeight: 1080,
      })
    })

    const st = () => page.evaluate(() => ({
      index: window.p.index, step: window.p.step, steps: window.p.steps,
      clicks: window.clicks, picClicks: window.picClicks,
      zoom: window.visualViewport?.scale ?? 1,
    }))
    const touch = page.touchscreen
    const R = { x: 1100, y: 380 }
    const L = { x: 120, y: 380 }
    const tapAt = async p => { await touch.tap(p.x, p.y); await sleep(320) }   // 隔开双击窗口
    const centerOf = id => page.evaluate(sel => {
      const b = document.querySelector(sel).getBoundingClientRect()
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    }, `#${id}`)

    let s = await st()
    show(s.index === 1 && s.step === 0, `初始：第 ${s.index} 页 / 第 ${s.step} 步`)
    show(s.steps > 0, `第一页步进表 ${s.steps} 步`)

    // 一路点右半走到步尽：每点一次必须前进正好一步
    const steps = s.steps
    for (let k = 1; k <= steps; k++) {
      await tapAt(R)
      s = await st()
      show(s.step === k && s.index === 1, `点右半第 ${k} 次 → 第 ${s.step} 步（同 ↓ 键）`)
    }
    await tapAt(R)
    s = await st()
    show(s.index === 2 && s.step === 0, `步尽再点右半 → 翻到第 ${s.index} 页`)

    await tapAt(L)
    s = await st()
    show(s.index === 1, `点左半 → 回到第 ${s.index} 页`)
    show(s.step === steps, `回来应恢复到步尽（step=${s.step}）`)

    // 禁区 + capture 时序：按钮 / 图片自己的 click 必须照常到，且不许顺带翻页
    for (const [id, key, label] of [["btn", "clicks", "按钮"], ["pic", "picClicks", "图片"]]) {
      const before = await st()
      await tapAt(await centerOf(id))
      s = await st()
      show(s[key] === before[key] + 1, `点${label} → 它自己的 click 到了（${before[key]} → ${s[key]}）`)
      show(s.index === before.index && s.step === before.step, `点${label}不该顺手翻页`)
    }

    // 真滑动仍要翻页（capture 改成"越过 slop 才捕获"，别把滑动弄丢了）
    const t = await touch.touchStart(1000, 380)
    for (const x of [940, 880, 820, 760]) {
      await touch.touchMove(x, 380)
      await sleep(16)
    }
    await t.end()
    await sleep(200)
    s = await st()
    show(s.index === 2, `左滑 240px → 翻到第 ${s.index} 页`)

    // 连点两下：两下都要翻，浏览器不许把它当成双击缩放
    const start = await st()
    await touch.tap(R.x, R.y)
    await sleep(60)
    await touch.tap(R.x, R.y)
    await sleep(320)
    s = await st()
    show(s.index > start.index || s.step > start.step, "连点两下要真的走两步（不被吞）")
    show(Math.abs(s.zoom - 1) < 0.01, `连点后页面没被缩放（zoom=${s.zoom}）`)
    show(errors.length === 0, errors.length ? `页面异常：${errors[0]}` : "页面无未捕获异常")
  } finally {
    await browser.close()
  }
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
