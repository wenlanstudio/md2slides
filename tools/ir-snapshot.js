"use strict"

/**
 * ir-snapshot.js — IR 快照比对（P-1 库化：diff 即回归）。
 *
 * 用法（先跑过 `npm run e2e`，.cache 里才有当轮 IR）：
 *   node tools/ir-snapshot.js            比对 e2e/.cache/*.ir.json 与 e2e/snapshots/
 *   node tools/ir-snapshot.js --update   用当轮 .cache 刷新 e2e/snapshots/（改引擎后故意更新基线）
 *
 * 为什么快照值得入库：IR v1 已经是确定性的（同输入同环境两遍 deep-equal，A6 的 v1 事实），
 * 任何分页决策、测量口径、样式抽取的变化都会写进 IR——逐字段 diff 就是最低成本的回归网，
 * 不用等 IR_v3 P2 的 freeze 哈希链。
 *
 * 边界（诚实声明）：IR 含实测几何与 computed style，**字体度量变了数字就变**。
 * 快照是「生成它的那台机器」的基线：本机 / 同配置 CI 上 diff 即回归；
 * 换字体环境（CI 首跑）请先 --update 建立该环境基线，不要对着数字硬调。
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const CACHE = path.join(ROOT, "e2e", ".cache")
const SNAPSHOTS = path.join(ROOT, "e2e", "snapshots")

/** 有快照义务的输入（与 e2e/check.js 的默认集一致，全部是进版本库的 md） */
const NAMES = ["demo", "overflow", "nested", "nested-list", "diagram", "oversize", "semicolons"]

const read = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** 找出两份 JSON 第一处不一致的字段路径（deepStrictEqual 只说“不等”，这里要说“哪不等”） */
function firstDiff(a, b, trail = "") {
  if (a === b) return null
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return `${trail}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  for (const key of keys) {
    const hit = firstDiff(a[key], b[key], trail ? `${trail}.${key}` : key)
    if (hit) return hit
  }
  return null
}

const update = process.argv.includes("--update")
fs.mkdirSync(SNAPSHOTS, { recursive: true })

let failed = 0
for (const name of NAMES) {
  const cacheFile = path.join(CACHE, `${name}.ir.json`)
  const snapFile = path.join(SNAPSHOTS, `${name}.ir.json`)

  if (update) {
    if (!fs.existsSync(cacheFile)) {
      console.log(`  skip  ${name}（.cache 没有，先跑 npm run e2e）`)
      continue
    }
    fs.copyFileSync(cacheFile, snapFile)
    console.log(`  更新  e2e/snapshots/${name}.ir.json`)
    continue
  }

  const current = read(cacheFile)
  if (!current) {
    console.log(`  FAIL  ${name}：.cache 没有当轮 IR（先跑 npm run e2e）`)
    failed += 1
    continue
  }
  const baseline = read(snapFile)
  if (!baseline) {
    console.log(`  FAIL  ${name}：没有快照基线（node tools/ir-snapshot.js --update 建立）`)
    failed += 1
    continue
  }
  const diff = firstDiff(baseline, current)
  if (diff) {
    console.log(`  FAIL  ${name}：IR 与基线不一致\n        ${diff}`)
    failed += 1
  } else {
    const pages = current.slides?.length ?? 0
    console.log(`  ok    ${name}（${pages} 页，与基线 deep-equal）`)
  }
}

if (failed) process.exitCode = 1
console.log(`\n${update ? "基线已刷新" : failed ? `${failed} 个快照不一致` : "全部一致"}`)
