"use strict"

/**
 * shot-update.js — 把当轮 e2e 的截图（e2e/.cache/shots/）刷新为基线
 * （e2e/snapshots/shots/，进版本库）。改了主题 / 分页 / 公式排版后故意更新用。
 *
 * 基线是「生成它的那台机器」的产物（字体渲染因机器/Chrome 版本而异），
 * 同机 diff 即回归；换环境先 --update 重建，不要对着数字硬调。
 *
 * 用法：node tools/shot-update.js   （先跑过 npm run e2e，.cache 里才有当轮截图）
 */

const fs = require("fs")
const path = require("path")

const CACHE = path.join(__dirname, "..", "e2e", ".cache", "shots")
const SNAPSHOTS = path.join(__dirname, "..", "e2e", "snapshots", "shots")

if (!fs.existsSync(CACHE)) {
  console.log("没有当轮截图（先跑 npm run e2e）")
  process.exit(0)
}

fs.rmSync(SNAPSHOTS, { recursive: true, force: true })
fs.mkdirSync(SNAPSHOTS, { recursive: true })

let files = 0
for (const name of fs.readdirSync(CACHE)) {
  const dir = path.join(CACHE, name)
  if (!fs.statSync(dir).isDirectory()) continue
  fs.cpSync(dir, path.join(SNAPSHOTS, name), { recursive: true })
  files += fs.readdirSync(path.join(SNAPSHOTS, name)).length
  console.log(`  更新  ${name}/`)
}

console.log(`\n基线已刷新（${files} 张，e2e/snapshots/shots/）`)
