"use strict"

/**
 * svg-fence-real.js — ```svg 围栏的**全链路**真浏览器冒烟。
 *
 * 单测只能验到「认得出围栏」；这张图最后到底有没有变成 python-pptx 吃得下的 PNG，
 * 必须真跑一遍 compose → 页面侧栅格 → 物理分页 → IR → 可编辑 PPTX 才知道。
 * 上一轮的结论正是「外链 .svg 在 add_picture 那一环炸」，所以最后一条断言是硬门禁。
 *
 * 用法：node e2e/svg-fence-real.js（需要本机 Chrome / Edge + Python python-pptx）
 */

const assert = require("node:assert/strict")
const { runDeck } = require("./runner")

const MD = `---
title: SVG 围栏冒烟
---

# 手写 SVG · viewBox

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="2" y="2" width="196" height="96" rx="12" fill="#FDFAF3" stroke="#1A1A1C" stroke-width="4"/>
  <circle cx="100" cy="46" r="28" fill="#D85A30"/>
  <text x="100" y="90" text-anchor="middle" font-size="13" fill="#1A1A1C">wenlan</text>
</svg>
\`\`\`

# 手写 SVG · 数值宽高

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80">
  <rect width="160" height="80" fill="#1D9E75"/>
  <circle cx="80" cy="40" r="26" fill="#FDFAF3"/>
</svg>
\`\`\`
`

const show = (ok, msg) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`)
  if (!ok) process.exitCode = 1
}

/** PNG 的 IHDR：第 16/20 字节起各 4 字节大端宽高。 */
const pngSize = b64 => {
  const buf = Buffer.from(b64, "base64")
  assert.equal(buf.toString("ascii", 1, 4), "PNG", "不是 PNG")
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const main = async () => {
  console.log("```svg 围栏 · 全链路真浏览器冒烟")
  const r = await runDeck({ md: MD, name: "svg-fence-smoke" })
  const html = r.finalHtml ?? ""

  show(r.diagramPass?.rendered === 2, `页面侧渲染了 2 张 SVG（实得 ${r.diagramPass?.rendered}）`)
  show(r.after?.unrenderedCharts === 0, "没有残留未渲染的图表围栏")
  show(!html.includes("language-svg"), "分页后的 deck 里没有 ```svg 代码块残留")

  const tags = html.match(/<img[^>]*data-diagram="svg"[^>]*>/g) ?? []
  show(tags.length === 2, `deck 里有 2 个 <img data-diagram="svg">（实得 ${tags.length}）`)

  const sizes = tags.map(tag => {
    const m = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(tag)
    return m ? pngSize(m[1]) : null
  })
  show(sizes.every(Boolean), "两张图的 src 都是 PNG data URL（不是裸 SVG）")
  show(
    JSON.stringify(sizes) === JSON.stringify([{ width: 400, height: 200 }, { width: 320, height: 160 }]),
    `栅格倍率 2x 生效：${JSON.stringify(sizes)}（期望 400×200 / 320×160）`,
  )

  // 方案 1：显示尺寸 = 固有尺寸 × 栅格倍率，PNG 像素与 CSS 像素 1:1。
  const display = tags.map(tag => ({
    width: Number(/width="(\d+)"/.exec(tag)?.[1] ?? 0),
    height: Number(/height="(\d+)"/.exec(tag)?.[1] ?? 0),
  }))
  show(
    JSON.stringify(display) === JSON.stringify([{ width: 400, height: 200 }, { width: 320, height: 160 }]),
    `显示尺寸按倍率放大（1 PNG px = 1 CSS px）：${JSON.stringify(display)}`,
  )

  const media = r.ir?.media ?? []
  show(media.length >= 2 && media.every(m => m.name.endsWith(".png")), "IR media 全部落盘成 .png，没有 .svg")
  show((r.ir?.stats?.byType?.image ?? 0) >= 2, "IR 里抽到了 image 块")
  const mediaIssues = (r.ir?.issues ?? []).filter(i => i.includes("图片未落盘"))
  show(mediaIssues.length === 0, `IR 校验没有「图片未落盘」：${mediaIssues.join(" / ") || "无"}`)

  show(r.pptx?.ok === true, `可编辑 PPTX 出片成功（python-pptx add_picture 认这张图）：${JSON.stringify(r.pptx)}`)

  const pageErrors = (r.console ?? []).filter(line => line.startsWith("pageerror:"))
  show(pageErrors.length === 0, `页面无未捕获异常：${pageErrors.join(" / ") || "无"}`)
}

main().catch(error => {
  console.error("  FAIL  " + (error?.stack ?? error))
  process.exitCode = 1
})
