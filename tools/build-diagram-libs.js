"use strict"

/**
 * build-diagram-libs.js — 产出/更新 host/lib 里「文览编辑器同款」的图表运行时。
 *
 * 背景：deck 引擎补齐编辑器已支持的两类图表时，运行时必须与编辑器**同库同版本**
 * （所见一致是 deck 的承诺）。编辑器（wenlan/packages/muya）把这些库打进自己的
 * bundle，deck 这边按 host/lib 提交预构建 min 文件的惯例（mermaid/echarts 同）。
 * 本脚本从兄弟仓 wenlan 的 muya node_modules 取源产出，产物**提交进本仓**——
 * 平时不用跑，升级某个库时跑一次、提交产物即可。
 *
 * ```sh
 * node tools/build-diagram-libs.js          # 全量产出
 * node tools/build-diagram-libs.js sequence # 只产一个（chart/abcjs/vega/wavedrom/flowchart/sequence）
 * ```
 *
 * 来源映射（版本对齐 muya package.json 的 ^ 区间，取 wenlan 装好的那份）：
 *   chart.umd.min.js      ← muya/node_modules/chart.js/dist/chart.umd.min.js        （UMD → Chart）
 *   abcjs-basic-min.js    ← muya/node_modules/abcjs/dist/abcjs-basic-min.js          （UMD → abcjs）
 *   vega.min.js           ← muya/node_modules/vega/build/vega.min.js                 （UMD → vega）
 *   vega-lite.min.js      ← muya/node_modules/vega-lite/build/vega-lite.min.js       （UMD → vegaLite）
 *   vega-embed.min.js     ← muya/node_modules/vega-embed/build/vega-embed.min.js     （UMD → vegaEmbed）
 *   wavedrom.min.js       ← muya/node_modules/wavedrom/wavedrom.unpkg.min.js         （UMD → wavedrom）
 *   flowchart.min.js      ← esbuild 打包 muya/node_modules/flowchart.js（raphael 依赖闭包）→ globalThis.flowchart
 *   sequence.min.js       ← esbuild 打包 muya 源树 vendor 的 js-sequence-diagrams
 *                            （snapsvg-cjs/underscore/webfontloader 闭包）→ globalThis.SequenceDiagram
 *   sequence-fonts/*      ← muya 源树的 danielbd 字体（hand 主题画字用，@font-face 由
 *                            sequenceHost 注入，URL 走 window.__md2slides_assetBase）
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const LIB = path.join(ROOT, "host", "lib")

// 兄弟仓布局：md2slides 与 wenlan 平级（sync-md2slides.mjs 同款约定）。
const MUYA_NM = process.env.MUYA_NODE_MODULES
  ? path.resolve(process.env.MUYA_NODE_MODULES)
  : path.resolve(ROOT, "..", "wenlan", "packages", "muya", "node_modules")

/** UMD 直接拷贝的库：[产物名, 源相对 muya node_modules 的路径]。 */
const COPY_LIBS = [
  ["chart.umd.min.js", "chart.js/dist/chart.umd.min.js"],
  ["abcjs-basic-min.js", "abcjs/dist/abcjs-basic-min.js"],
  ["vega.min.js", "vega/build/vega.min.js"],
  ["vega-lite.min.js", "vega-lite/build/vega-lite.min.js"],
  ["vega-embed.min.js", "vega-embed/build/vega-embed.min.js"],
  ["wavedrom.min.js", "wavedrom/wavedrom.unpkg.min.js"],
]

/** esbuild 打包的库：[产物名, 产出目标 global]。 */
const BUNDLE_LIBS = ["flowchart", "sequence"]

const only = process.argv[2]
const want = name => !only || only === name

/** esbuild 取自 wenlan 工作区（本仓 devDeps 没有 bundler；产物提交，脚本只是维护工具）。 */
function resolveEsbuild() {
  const pnpm = path.resolve(MUYA_NM, "..", "..", "..", "node_modules", ".pnpm")
  let newest = null
  if (fs.existsSync(pnpm)) {
    for (const name of fs.readdirSync(pnpm)) {
      if (!/^esbuild@\d+\.\d+\.\d+$/.test(name)) continue
      newest = newest && newest.localeCompare(name) >= 0 ? newest : name
    }
  }
  if (!newest) {
    throw new Error(`找不到 esbuild（${pnpm} 下没有 esbuild@x.y.z）——先在 wenlan 装好依赖，或用 MUYA_NODE_MODULES 指路`)
  }
  return path.join(pnpm, newest, "node_modules", "esbuild")
}

const copyLib = ([name, rel]) => {
  const src = path.join(MUYA_NM, rel)
  if (!fs.existsSync(src)) throw new Error(`源不存在：${src}（wenlan 的 muya 依赖没装全？）`)
  fs.copyFileSync(src, path.join(LIB, name))
  console.log(`  ok    host/lib/${name}  ← muya:${rel}`)
}

/** esbuild API 打包成 IIFE；minify 与 mermaid.min.js 同水准。
 *  入口是一段虚拟代码：落成临时文件再打包（esbuild 各版本 stdin 选项形状不同，
 *  落文件最稳）。 */
function bundle(name, entry, resolveDir) {
  const esbuild = require(resolveEsbuild())
  const out = path.join(LIB, name)
  const tmpDir = path.join(LIB, ".build-tmp")
  fs.mkdirSync(tmpDir, { recursive: true })
  const entryFile = path.join(tmpDir, `${name}.entry.js`)
  fs.writeFileSync(entryFile, entry, "utf8")
  try {
    esbuild.buildSync({
      entryPoints: [entryFile],
      bundle: true,
    format: "iife",
    platform: "browser",
    minify: true,
    legalComments: "inline",
    outfile: out,
    logLevel: "silent",
    absWorkingDir: resolveDir,
    })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  const kb = (fs.statSync(out).size / 1024).toFixed(0)
  console.log(`  ok    host/lib/${name}  (esbuild, ${kb}KB)`)
}

/** flowchart.js + raphael 依赖闭包 → globalThis.flowchart。 */
function buildFlowchart() {
  const indexJs = path.join(MUYA_NM, "flowchart.js", "index.js")
  if (!fs.existsSync(indexJs)) throw new Error(`源不存在：${indexJs}`)
  const entry = `const flowchart = require(${JSON.stringify(indexJs)});` +
    `globalThis.flowchart = flowchart.default ?? flowchart;`
  bundle("flowchart.min.js", entry, path.dirname(indexJs))
}

/** muya vendor 的 js-sequence-diagrams（snap.svg 版）→ globalThis.SequenceDiagram。 */
function buildSequence() {
  const snapJs = path.join(
    MUYA_NM, "..", "src", "utils", "diagram", "sequence", "sequence-diagram-snap.js",
  )
  if (!fs.existsSync(snapJs)) throw new Error(`源不存在：${snapJs}`)
  // css 不进 bundle：@font-face 的字体 URL 归 sequenceHost 按宿主环境注入。
  const entry = `import Diagram from ${JSON.stringify(path.resolve(snapJs))};` +
    `globalThis.SequenceDiagram = { Diagram: (Diagram && Diagram.default) ?? Diagram };`
  bundle("sequence.min.js", entry, path.dirname(snapJs))

  const fontDir = path.join(LIB, "sequence-fonts")
  fs.mkdirSync(fontDir, { recursive: true })
  for (const f of ["danielbd.woff2", "danielbd.woff"]) {
    const src = path.join(path.dirname(snapJs), f)
    if (!fs.existsSync(src)) throw new Error(`字体不存在：${src}`)
    fs.copyFileSync(src, path.join(fontDir, f))
    console.log(`  ok    host/lib/sequence-fonts/${f}`)
  }
}

const main = () => {
  if (!fs.existsSync(MUYA_NM)) {
    throw new Error(`muya node_modules 不在 ${MUYA_NM}——两仓须为兄弟目录，或用 MUYA_NODE_MODULES 指路`)
  }
  for (const lib of COPY_LIBS) if (want(lib[0])) copyLib(lib)
  if (want("flowchart")) buildFlowchart()
  if (want("sequence")) buildSequence()
}

main()
