"use strict";

/**
 * pack-marktext.js — 产 marktext fork 的 vendored 资产包（marktext M1，设计稿
 * integration-marktext.md §5.4）。
 *
 * ```
 * npm run build:host && node tools/pack-marktext.js        # 默认输出 out/marktext/
 * ```
 *
 * fork 侧经 scripts/sync-md2slides.mjs 把它拷进 packages/desktop/resources/md2slides/
 * （gitignore，不入 fork 库）；marktext main 进程 require 包里的 server.js 起本地
 * 服务，把整包挂在 `/` 前缀下——deck 页面（/deck.html）、图表运行时（按需）、主题、
 * KaTeX 字体与 css 全部从这一个包出。
 *
 * 布局（deck-full-entry 的 warmAssets / ensureDiagramLibs 按这份布局取件）：
 *   deck.html                  页面壳（host/marktext/deck.html）
 *   dist/deck-full.js          build-host 第三 target 的产物（先 npm run build:host）
 *   themes/*.css               core/themes 全部（loadTheme 扫 + highlightCss 读）
 *   katex/katex.min.css        katexCss 的 readFile 输入
 *   katex/fonts/*              /fonts/ 的服务根
 *   lib/mermaid.min.js         按需注入的图表运行时（echarts 同）
 *   lib/echarts.min.js
 *   lib/layout-core.js         分页决策内核（纯函数，M4.2 起 vendor 进 fork
 *                              renderer 源树——双端共用，view-model §5）
 *   server.js                  host/server/index.js 原样拷贝（fork main 直接 require，
 *                              自包含：只依赖 http/fs/path）
 *   assets.json                资产清单（themes 名单 + katexCss + libs 路由）
 *
 * M2 起还有导出后端（fork main 的 mt::md2slides::export 消费）：
 *   pptx.js                    host/pptx/index.js 原样拷贝（CJS 自包含）
 *   lib/pptxgenjs/             从 node_modules/pptxgenjs 拷（含依赖闭包 node_modules）
 *   lib/sidecar/               Python sidecar（export/pptx/sidecar）
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const OUT = path.join(ROOT, "out", "marktext")

const copy = (from, to) => {
  const src = path.join(ROOT, from)
  if (!fs.existsSync(src)) throw new Error(`源不存在：${from}（build:host 没跑？）`)
  fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true })
  fs.copyFileSync(src, path.join(OUT, to))
}

/** 目录整拷（build:host 产物 / sidecar 的 .py 全家）。 */
const copyTree = (from, to) => {
  const src = path.join(ROOT, from)
  if (!fs.existsSync(src)) throw new Error(`源不存在：${from}（build:host 没跑？）`)
  fs.rmSync(path.join(OUT, to), { recursive: true, force: true })
  fs.cpSync(src, path.join(OUT, to), { recursive: true })
}

/** 把 npm 包连同依赖闭包拷进目标 node_modules（flat）。 */
const copyDepTree = (name, destDir) => {
  if (name.startsWith("@types/")) return
  const src = path.join(ROOT, "node_modules", name)
  if (!fs.existsSync(src)) return // 内置模块 / 未安装
  const dest = path.join(destDir, name)
  if (fs.existsSync(dest)) return
  fs.cpSync(src, dest, { recursive: true })
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"))
  } catch {
    return
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) }
  for (const d of Object.keys(deps)) copyDepTree(d, destDir)
}

const main = () => {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  copy("host/marktext/deck.html", "deck.html")
  copy("host/marktext/dist/deck-full.js", "dist/deck-full.js")

  const themes = fs
    .readdirSync(path.join(ROOT, "core", "themes"))
    .filter(f => f.toLowerCase().endsWith(".css"))
  for (const f of themes) copy(path.join("core", "themes", f), path.join("themes", f))
  copy("lib/katex/katex.min.css", "katex/katex.min.css")

  const fontsDir = path.join(ROOT, "lib", "katex", "fonts")
  for (const f of fs.readdirSync(fontsDir)) {
    copy(path.join("lib", "katex", "fonts", f), path.join("katex", "fonts", f))
  }

  copy("host/lib/mermaid.min.js", "lib/mermaid.min.js")
  copy("host/lib/echarts.min.js", "lib/echarts.min.js")
  copy("host/server/index.js", "server.js")

  // M4.2：分页决策内核（纯函数，零 DOM）随包出货——fork 侧 sync 脚本把它
  // vendor 进 renderer 源树（packages/desktop/src/renderer/src/vendor/），
  // marktext 纸叶 v2 块内切分与 deck 共用同一份策略合同（view-model §5）。
  copy("core/paginate/layout-core.js", "lib/layout-core.js")

  // M2 导出后端：出片模块 + pptxgenjs（依赖闭包）+ Python sidecar。
  copy("host/pptx/index.js", "pptx.js")
  const pptxDir = path.join(OUT, "lib", "pptxgenjs")
  fs.mkdirSync(path.join(pptxDir, "node_modules"), { recursive: true })
  fs.cpSync(path.join(ROOT, "node_modules", "pptxgenjs"), pptxDir, { recursive: true })
  const pptxDeps = require(path.join(ROOT, "node_modules", "pptxgenjs", "package.json")).dependencies || {}
  for (const d of Object.keys(pptxDeps)) copyDepTree(d, path.join(pptxDir, "node_modules"))
  copyTree("export/pptx/sidecar", "lib/sidecar")

  const manifest = {
    themes,
    katexCss: "katex/katex.min.css",
    libs: { mermaid: "lib/mermaid.min.js", echarts: "lib/echarts.min.js" },
  }
  fs.writeFileSync(path.join(OUT, "assets.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

  const kb = fs.statSync(path.join(OUT, "dist", "deck-full.js")).size / 1024
  console.log(`  ok    out/marktext/  deck-full ${kb.toFixed(0)}KB + ${themes.length} 主题 + 字体 + 图表运行时 + server.js + 导出后端（pptx.js/pptxgenjs/sidecar）`)
}

main()
