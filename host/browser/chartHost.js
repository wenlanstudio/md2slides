"use strict";

/**
 * chartHost.js — **浏览器侧**渲染 chart.js（canvas 出图，getDataURL 免栅格）。
 *
 * 与编辑器同规格（wenlan muya render.ts:97-116）：块配置走 parseJsonBlock
 * （BlockCodeConfig 头 + 宽松 JSON），尺寸从 `@width`/`@height` 读像素，缺省
 * 640×400（编辑器的 CHART_WIDTH/CHART_HEIGHT）；`animation:false` 抓不到入场首帧
 * 空图，`responsive:false` 让图表画在自己声明的尺寸上（离屏容器量不到宽）。
 *
 * 位图倍率 devicePixelRatio:2（echartsHost 的 pixelRatio:2 同理——出高清图不改变
 * 显示尺寸）。chart.js 的画布是透明的，PPTX 里会发灰：读回前垫一层底色
 * （分派点注入的实测 section 背景），再 compose 成最终 PNG。
 */

const { parseJsonBlock, pixelSize } = require("../../core/render/blockSource")

const DEFAULT_WIDTH = 640
const DEFAULT_HEIGHT = 400
const PIXEL_RATIO = 2

const settleFrames = async frames => {
  for (let i = 0; i < frames; i++) {
    await new Promise(resolve => requestAnimationFrame(() => resolve()))
  }
}

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {string} [opts.background] 底色（缺省由分派点给实测 section 背景）
 * @returns {Promise<{dataUrl: string, width: number, height: number}>}
 * @throws {Error} 没有运行时 / 配置解析失败 / 没吐出图像 —— 一律硬失败
 */
const renderChart = async (block, opts = {}) => {
  const Chart = globalThis.Chart
  if (!Chart) {
    throw new Error("页面里没有 Chart.js 运行时（globalThis.Chart 未定义）——先注入 host/lib/chart.umd.min.js")
  }

  let parsed
  try {
    parsed = parseJsonBlock(block.source)
  } catch (error) {
    throw new Error(`chart 配置解析失败（JSON，容忍块配置头/注释/尾逗号）：${error.message}`)
  }
  const { options, value } = parsed

  // 显示尺寸 = CSS 尺寸；位图是 PIXEL_RATIO 倍的高清图，`<img>` 按原尺寸显示。
  const width = pixelSize(options.width) ?? DEFAULT_WIDTH
  const height = pixelSize(options.height) ?? DEFAULT_HEIGHT

  // 画布必须真挂到文档上（离屏即可）：不进 DOM 的 canvas Chart.js 不落笔
  // （真机验过：构造完画布仍全透明，读回是纯底色）。
  const stage = document.createElement("div")
  stage.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;height:${height}px;`
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  stage.appendChild(canvas)
  document.body.appendChild(stage)

  const chart = new Chart(canvas, {
    ...value,
    options: { animation: false, responsive: false, ...value.options, devicePixelRatio: PIXEL_RATIO },
  })
  // animation:false 时 draw 是同步的；补一帧 update + 两帧 rAF 兜住版本差异，
  // 保证读回前像素已经落在画布上。
  chart.update()
  await settleFrames(2)

  // 透明底垫色：echarts 的 getDataURL(backgroundColor) 在这里是手动的两步。
  // 注意次序：必须在 chart.destroy() **之前** compose——destroy 会清空画布，
  // 事后 drawImage 拿到的是一张透明底（真机踩过：整页出图全是纯底色）。
  const flat = document.createElement("canvas")
  flat.width = canvas.width
  flat.height = canvas.height
  const ctx = flat.getContext("2d")
  ctx.fillStyle = opts.background ?? opts.fill ?? "#ffffff"
  ctx.fillRect(0, 0, flat.width, flat.height)
  ctx.drawImage(canvas, 0, 0)

  chart.destroy()
  stage.remove()

  // 空图守卫：整个位图若是纯底色，说明 chart.js 根本没落笔（曾因画布没挂 DOM
  // 踩过——读回是干净的白图，不查就静默出一张空 slide）。全图采样：图表的
  // padding 区（顶部若干行）本来就是底色，抽行会误判。
  const bg = ctx.getImageData(0, 0, 1, 1).data
  const probe = ctx.getImageData(0, 0, flat.width, flat.height).data
  let nonBg = false
  for (let i = 0; i < probe.length; i += 4) {
    if (probe[i] !== bg[0] || probe[i + 1] !== bg[1] || probe[i + 2] !== bg[2] || probe[i + 3] !== bg[3]) {
      nonBg = true
      break
    }
  }
  if (!nonBg) {
    throw new Error("chart 位图是纯底色——chart.js 没画东西（配置对吗？画布挂上 DOM 了吗？）")
  }

  const dataUrl = flat.toDataURL("image/png")
  if (!dataUrl || dataUrl === "data:,") throw new Error("chart 位图 compose 失败")

  return { dataUrl, width, height }
}

/** 仅供单测/调用方核对：显示尺寸的缺省与倍率契约。 */
module.exports = { renderChart, DEFAULT_WIDTH, DEFAULT_HEIGHT, PIXEL_RATIO }
