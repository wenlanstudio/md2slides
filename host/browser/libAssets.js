"use strict";

/**
 * libAssets.js — 浏览器侧图表类型 → 运行时文件清单（单一事实源）。
 *
 * 三处消费：pack-marktext（产 assets.json 的 libs 段 + 拷文件）、deck-full-entry
 * （ensureDiagramLibs 按 fence 语言查表加载）、e2e/runner（injectRuntime 按 deferred
 * 类型注入）。改图表运行时只动这一张表 + host/lib 里对应的文件。
 *
 * 文件路径相对资产包根（pack 后 deck 页面的 `/`）；e2e 里由 runner 换算成
 * `/host/lib/<file>`（见 runner.injectRuntime）。数组内文件按序加载——
 * vega-lite 三件套的 UMD 有 externals 依赖，顺序错了 vegaEmbed 起不来。
 */

const DIAGRAM_LIBS = {
  mermaid: ["lib/mermaid.min.js"],
  echarts: ["lib/echarts.min.js"],
  "vega-lite": ["lib/vega.min.js", "lib/vega-lite.min.js", "lib/vega-embed.min.js"],
  flowchart: ["lib/flowchart.min.js"],
  sequence: ["lib/sequence.min.js"],
  wavedrom: ["lib/wavedrom.min.js"],
  chart: ["lib/chart.umd.min.js"],
  abc: ["lib/abcjs-basic-min.js"],
  // drawio 不需要本地运行时：出图走 diagrams.net embed 的 postMessage 协议（网络），
  // 见 drawioHost.js。表里没有它的键，ensureLib 查不到就什么都不加载。
}

/** 围栏语言别名 → 表键（与 core 的 DIAGRAM_TYPES 同源；这里只补 lib 键不同的别名）。 */
const LIB_KEY_OF_LANG = { chartjs: "chart" }

module.exports = { DIAGRAM_LIBS, LIB_KEY_OF_LANG }
