"use strict";

/**
 * echartsHost.js — **浏览器侧**渲染 echarts（图表渲染渠道归 host，core 不碰）。
 *
 * 住 `host/browser/` 而不是 `e2e/`：与 mermaidHost 同理——渲染器是宿主资产，
 * 壳与 e2e 共用同一份实现，杜绝「预览/导出/回归」三处漂移。e2e 下的同名文件是转发 shim。
 *
 * echarts 画到 canvas 上，Node 侧没有 DOM，所以只能进页面渲染。
 * 渲染完取 `getDataURL()` 直接就是 PNG —— 省掉了 SVG→PNG 那一道栅格。
 */

const { fillChannels } = require("../../core/render/diagram")

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 450

/** 深底上的默认浅字（中性暖白，不属于任何主题）。 */
const DARK_BG_TEXT_COLOR = "#e8e4f5"
/** 相对亮度低于此值算深色底（0-255 灰阶当量）。 */
const DARK_FILL_LUMA = 128

const isDarkFill = fill => {
  const [r, g, b] = fillChannels(fill)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < DARK_FILL_LUMA
}

/** echarts 默认文字色（#6E7079 一族）是给浅底准备的：深底上轴标签整个被吞
 *  （2026-11-22 视觉验收抓出）。底色实测为深色时，给作者**没显式配色**的位置
 *  注入浅色默认：全局 textStyle、坐标轴 axisLabel、图例。作者写了的颜色一字不改。 */
const asArray = value => (Array.isArray(value) ? value : value == null ? [] : [value])

const injectDarkTextDefaults = (option, color) => {
  if (!option.textStyle?.color) {
    option.textStyle = { ...(option.textStyle ?? {}), color }
  }
  for (const key of ["xAxis", "yAxis"]) {
    for (const axis of asArray(option[key])) {
      if (!axis.axisLabel?.color) {
        axis.axisLabel = { ...(axis.axisLabel ?? {}), color }
      }
    }
  }
  for (const legend of asArray(option.legend)) {
    if (!legend.textStyle?.color) {
      legend.textStyle = { ...(legend.textStyle ?? {}), color }
    }
  }
  return option
}

/**
 * 围栏里的 echarts 配置：先当 JSON 解析，不行再当 JS 对象字面量求值。
 *
 * 求值这一步只在**本地管线、文档是自己写的**前提下才成立；要渲染来路不明的 md
 * 就别用它（那时只认 JSON 即可）。
 */
const parseOption = src => {
  const text = String(src ?? "").trim()
  if (!text) throw new Error("echarts 块是空的")
  try {
    return JSON.parse(text)
  } catch {
    /* 不是 JSON，往下试 JS 对象字面量 */
  }
  try {
    const value = new Function(`return (${text})`)()
    if (value && typeof value === "object") return value
  } catch (error) {
    throw new Error(`echarts 配置既不是合法 JSON 也不是合法 JS 对象：${error.message}`)
  }
  throw new Error("echarts 配置解析不出对象")
}

/**
 * @param {{type: string, source: string}} block
 * @param {object} [opts]
 * @param {number} [opts.width=800]        图表 CSS 宽
 * @param {number} [opts.height=450]       图表 CSS 高
 * @param {number} [opts.pixelRatio=2]     位图倍数（出高清图，不改变显示尺寸）
 * @param {string} [opts.background="#ffffff"] 背景色（不填会是透明，PPTX 里发灰）
 * @returns {Promise<{dataUrl: string, width: number, height: number}>}
 * @throws {Error} 没有运行时 / 配置解析失败 / 没吐出图像 —— 一律硬失败
 */
const renderEcharts = async (block, opts = {}) => {
  const echarts = globalThis.echarts
  if (!echarts?.init) {
    throw new Error("页面里没有 echarts 运行时（globalThis.echarts 未定义）——先注入 host/lib/echarts.min.js")
  }

  const option = parseOption(block.source)
  const width = opts.width ?? DEFAULT_WIDTH
  const height = opts.height ?? DEFAULT_HEIGHT
  const ratio = opts.pixelRatio ?? 2
  const background = opts.background ?? "#ffffff"
  // 深底注入浅字默认（作者显式配色不动）；浅底什么都不碰，与旧版逐字节一致。
  if (isDarkFill(background)) injectDarkTextDefaults(option, DARK_BG_TEXT_COLOR)

  // 离屏容器：不能 display:none（那样量不到尺寸），挪到屏幕外即可。
  const host = document.createElement("div")
  host.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;height:${height}px;`
  document.body.appendChild(host)

  try {
    const chart = echarts.init(host, null, { renderer: "canvas", width, height })
    // 动画必须关掉：echarts 默认从 0 开始入场，getDataURL 抓的是 t=0 那一帧，
    // 柱子/折线全是空的——坐标轴都在，数据全没画。
    chart.setOption({ ...option, animation: false })
    const dataUrl = chart.getDataURL({
      type: "png",
      pixelRatio: ratio,
      backgroundColor: background,
    })
    chart.dispose()
    if (!dataUrl) throw new Error("echarts 没吐出图像")

    // 显示尺寸给 CSS 尺寸：位图是 ratio 倍的高清图，但 `<img>` 要按原尺寸显示，
    // 否则一张 800×450 的图会被撑成 1600×900。
    return { dataUrl, width, height }
  } finally {
    host.remove()
  }
}

module.exports = { renderEcharts, parseOption, DEFAULT_WIDTH, DEFAULT_HEIGHT }
