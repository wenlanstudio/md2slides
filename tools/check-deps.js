"use strict"

/**
 * Static require-graph check for the md2slides source tree.
 *
 * Walking the tree and resolving every relative `require("…")` catches the failure mode that
 * directory reshuffles keep producing: a module that parses fine but points at a file that
 * moved. Nothing is actually loaded — most of `core/` touches `document` and would throw — so
 * this stays a path check, not an import check.
 *
 * `e2e/` is in the default scope: `bundle.js` silently skips requires it cannot resolve
 * (a broken one just becomes a missing external at runtime), so nothing else would catch
 * a moved file there. `host/browser/`（浏览器侧图表渲染器 + deck 页面内核，壳与 e2e
 * 共用）同理入默认范围；随壳/资产包作为源码分发的还有三个：`host/pptx/`（宿主无关
 * 导出后端）、`host/server/`（本地静态服务）、`host/marktext/`（deck-full 页面入口）
 * ——require 图必须守。生成物 `dist/` 与 `lib/` 是 build 产物，require 不到是正常的，
 * 显式跳过。
 *
 * Usage:  node tools/check-deps.js [--all]
 *         --all  also check host/ and lib/ (default: skip them)
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const SKIP_DIRS = new Set(["node_modules", ".idea", "__pycache__", ".git", ".cache"])

const walk = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (SKIP_DIRS.has(entry.name)) return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith(".js") ? [full] : []
  })

const inScope = (file, includeAll) => {
  const rel = path.relative(ROOT, file).split(path.sep).join("/")
  if (rel.startsWith("tools/")) return false       // this checker does not check itself
  if (includeAll) return true
  return /^(core|export|e2e|kit|host\/browser|host\/pptx|host\/server|host\/marktext)\//.test(rel)
}

/**
 * build-host 的生成物：require 不到是正常的（先 build 再 check 也能过，但不该要求）。
 *
 * 按**文件路径**判，不按 spec 判：dist/ 里是 bundle——模块源码被 JSON.stringify 塞进
 * 字符串，单引号的 require 会原样留在文本里（双引号的被转义掉，扫不出来）。
 * 于是 bundle 里一条 `require('../../core/quiz/parse')` 会被当成真依赖去解析，
 * 而它的相对基准是 dist/，自然解析不到——报的是假错。
 */
const isGenerated = spec => /(^|\/)(dist|lib)\//.test(spec) || /(^|\/)(dist|lib)$/.test(spec)

/** 生成物目录里的文件整个跳过（dist/ = bundle，lib/ = 资产副本）。 */
const isGeneratedFile = file => {
  const rel = path.relative(ROOT, file).split(path.sep).join("/")
  return /(^|\/)(dist|lib)\//.test(rel)
}

const RE_REQUIRE = /require\(\s*(["'])(\.[^"']+)\1\s*\)/g

/**
 * CommonJS resolution, reduced to what this repo uses: extensionless specifiers are the norm
 * (`require("./slide")`), so a bare path check reports false positives without the suffixes.
 */
const resolveSpec = (fromDir, spec) => {
  const base = path.resolve(fromDir, spec)
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")]
  return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null
}

const main = () => {
  const includeAll = process.argv.includes("--all")
  const files = walk(ROOT).filter(f => inScope(f, includeAll) && !isGeneratedFile(f))
  const broken = []

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8")
    for (const match of src.matchAll(RE_REQUIRE)) {
      const spec = match[2]
      if (isGenerated(spec)) continue
      if (!resolveSpec(path.dirname(file), spec)) {
        broken.push({ from: path.relative(ROOT, file), spec })
      }
    }
  }

  if (broken.length) {
    for (const b of broken) console.error(`MISSING  ${b.from}  ->  ${b.spec}`)
    console.error(`\n${broken.length} broken require(s) out of ${files.length} file(s) checked.`)
    process.exit(1)
  }
  console.log(`OK  ${files.length} file(s) checked, every relative require resolves.`)
}

main()
