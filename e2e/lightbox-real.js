"use strict"

/**
 * lightbox-real.js — 查看器的「真输入」回归。
 *
 * 为什么单独再写一份：`e2e/entry.js` 里的 lightboxProbe 是在页面内 dispatch **合成**
 * PointerEvent / MouseEvent，而这回放出的两个 bug 恰好都卡在合成事件覆盖不到的地方——
 *   ① `setPointerCapture` 会把后续 pointerup / 兼容性 mouse 事件 / click 的 **target 改写**
 *      成捕获元素（浮层 el）；
 *   ② 拖完松手后 Chromium 会**补发**一个 click（target 可能是图片与浮层的共同祖先）。
 * 合成事件的 target 是我们自己塞的，①②都不会重现，所以 bug 顺利溜过了 CI。
 *
 * 这里改用 puppeteer 的真鼠标 / 真滚轮（CDP Input 域，走浏览器完整的命中测试与派发链路）
 * 验同一批断言：拖动松手不退出、工具条按钮必须生效、✕ 与 Esc 关得掉、点背景关得掉。
 *
 * 用法：`node e2e/lightbox-real.js`（需要本机 Chrome / Edge，`e2e/browser.js` 会自动找）
 */

const path = require("path")
const fs = require("fs")
const { execFileSync } = require("child_process")

const ROOT = path.resolve(__dirname, "..")
const { launch } = require("./browser")
const { serve } = require("./serve")

const OUT = path.join(ROOT, "e2e", ".tmp-lightbox-real.html")
const posix = p => p.split(path.sep).join("/")

const show = (ok, msg) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`)
  if (!ok) process.exitCode = 1
}

const main = async () => {
  console.log("图片查看器 · 真输入回归（puppeteer 真鼠标 / 真滚轮）")
  execFileSync(
    process.execPath,
    [path.join(ROOT, "tools", "export-html.js"), path.join(ROOT, "examples", "demo.md"), "-o", OUT],
    { stdio: "ignore" },
  )

  const server = await serve(ROOT)
  const browser = await launch({})
  const errors = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 720 })
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    await page.goto(`${server.url}/${posix(path.relative(ROOT, OUT))}`, { waitUntil: "load" })

    // 注入一张确定性测试图（canvas → data URL，2000×1500，缩到 420px 显示在页面上），
    // 并把它所在的 section 标成当前页——查看器只收「当前页」里的图。
    const box = await page.evaluate(async () => {
      const canvas = document.createElement("canvas")
      canvas.width = 2000
      canvas.height = 1500
      const ctx = canvas.getContext("2d")
      ctx.fillStyle = "#40628f"
      ctx.fillRect(0, 0, 2000, 1500)
      ctx.fillStyle = "#ffffff"
      ctx.font = "90px sans-serif"
      ctx.fillText("md2slides lightbox", 140, 780)
      const img = document.createElement("img")
      img.alt = "测试图"
      img.style.width = "420px"
      img.src = canvas.toDataURL("image/png")
      const sec = document.querySelector("section[data-slide]") ?? document.body
      sec.classList.add("md2s-current")
      sec.appendChild(img)
      if (!img.complete) await new Promise(r => img.addEventListener("load", r, { once: true }))
      const b = img.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    })
    if (!box.width) throw new Error("测试图没落到位")

    const cx = Math.round(box.x + box.width / 2)
    const cy = Math.round(box.y + box.height / 2)
    const state = () =>
      page.evaluate(() => {
        // 页面上可能不止一份浮层（宿主挂载时机不同）：真输入命中的永远是 **DOM 序最后**
        // 那一层（z-index 相同、后来居上），所以读数也必须与之一致，否则只读到一个
        // 从没被操作的实例（惨痛教训：读数曾整套滞后一位，看着像按钮失灵）。
        const list = [...document.querySelectorAll(".md2s-lb")]
        const el = list[list.length - 1]
        const image = el?.querySelector(".md2s-lb-img")
        const tf = image?.style.transform ?? ""
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(tf)
        return {
          open: !!el && !el.hidden,
          k: m ? Number(m[3]) : NaN,
          tx: m ? Number(m[1]) : NaN,
          layers: list.length,
        }
      })

    await page.mouse.click(cx, cy)
    let st = await state()
    show(st.open, "真鼠标点图片 → 打开查看器")
    console.log(`       （浮层实例数 ${st.layers}）`)
    if (st.layers > 1) {
      show(false, `页面上有 ${st.layers} 份查看器浮层：宿主重复挂载了，多个实例会叠着响应`)
    }
    const fit = st.k
    show(fit > 0 && fit <= 1, `打开时按「适应屏幕」定位：k=${fit}`)

    // —— bug ②：拖完松手不许退出（Chromium 补发的 click 曾被当成「点背景」）——
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 40, cy)
    await page.mouse.move(cx + 80, cy)
    await page.mouse.move(cx + 120, cy)
    await page.mouse.up()
    st = await state()
    show(st.open, "拖动后松手，查看器不该被关掉")

    // —— 真滚轮放大后再拖，验证位移真的产生 ——
    await page.mouse.move(cx, cy)
    for (let i = 0; i < 14; i++) await page.mouse.wheel({ deltaY: -240 })
    const zoomed = await state()
    show(zoomed.k > fit * 1.2, `滚轮以指针为锚放大：${fit.toFixed(3)} → ${zoomed.k.toFixed(3)}`)
    const beforeDrag = zoomed.tx
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - 60, cy)
    await page.mouse.move(cx - 120, cy)
    await page.mouse.up()
    st = await state()
    show(st.open, "放大后再拖动平移，查看器不该被关掉")
    show(Math.abs(st.tx - beforeDrag) > 100, `拖动产生了平移位移：tx ${beforeDrag.toFixed(1)} → ${st.tx.toFixed(1)}`)

    if (process.env.LB_DIAG) {
      const diag = await page.evaluate(() => {
        const btn = document.querySelector('.md2s-lb-bar button[data-act="fit"]')
        const b = btn.getBoundingClientRect()
        return {
          btnRect: { x: b.x, y: b.y, w: b.width, h: b.height },
          hitBtn: document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.outerHTML?.slice(0, 90),
          hitBg: document.elementFromPoint(30, 400)?.outerHTML?.slice(0, 90),
        }
      })
      console.log("       [diag]", JSON.stringify(diag).replace(/\s+/g, " "))
    }

    // —— bug ①：工具条按钮必须生效，且点了不能把浮层关掉 ——
    // 护栏：此刻图已放大到溢出视口。图片有 transform → 自成层叠上下文且 DOM 序在工具条
    // 之后，曾把工具条整个盖住，按钮看得见却点不到（命中测试永远落在 img 上）。
    const btnHit = await page.evaluate(() => {
      const btn = document.querySelector('.md2s-lb-bar button[data-act="fit"]')
      const b = btn.getBoundingClientRect()
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === btn
    })
    show(btnHit, "图放大铺满时，工具条按钮仍可被命中（没被图片盖住）")

    await page.click('.md2s-lb-bar button[data-act="fit"]')
    st = await state()
    show(st.open, "点工具条「适应」不该关闭查看器")
    show(Math.abs(st.k - fit) < Math.max(fit, 0.01) * 0.03, `点「适应」回到 fit：${st.k.toFixed(4)} vs ${fit.toFixed(4)}`)

    await page.click('.md2s-lb-bar button[data-act="zoom-in"]')
    const kIn = await state()
    show(kIn.k > st.k * 1.05, `点「＋」放大：${st.k.toFixed(4)} → ${kIn.k.toFixed(4)}`)
    show(kIn.open, "点工具条「＋」不该关闭查看器")

    await page.click('.md2s-lb-bar button[data-act="zoom-out"]')
    const kOut = await state()
    show(kOut.k < kIn.k, `点「−」缩小：${kIn.k.toFixed(4)} → ${kOut.k.toFixed(4)}`)

    await page.click('.md2s-lb-bar button[data-act="one"]')
    st = await state()
    show(st.open, "点工具条「1:1」不该关闭查看器")
    show(Math.abs(st.k - 1) < 0.02, `点「1:1」回到原始像素：k=${st.k.toFixed(4)}`)

    // —— 点背景关闭（fit 态下图只占中间，左上角必然是背景）——
    await page.click('.md2s-lb-bar button[data-act="fit"]')
    await page.mouse.click(30, 400)
    st = await state()
    show(!st.open, "点图片以外的背景应关闭查看器")

    // —— ✕ 与 Esc ——
    await page.mouse.click(cx, cy)
    st = await state()
    show(st.open, "关掉后再次点图片能重新打开")
    await page.click('.md2s-lb-bar button[data-act="close"]')
    st = await state()
    show(!st.open, "点工具条 ✕ 应关闭查看器")

    await page.mouse.click(cx, cy)
    await page.keyboard.press("Escape")
    st = await state()
    show(!st.open, "Esc 应关闭查看器（且不能连带退出放映）")
    const stillPlaying = await page.evaluate(() => !!document.querySelector("#viewer, .md2s-player, section[data-slide]"))
    show(stillPlaying, "查看器关掉后放映页还在（Esc 没穿透到放映器）")

    show(errors.length === 0, `页面无未捕获异常${errors.length ? `：${errors.join(" | ")}` : ""}`)
  } finally {
    await browser.close()
    await server.close()
    try { fs.unlinkSync(OUT) } catch { /* 没生成就无所谓 */ }
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
