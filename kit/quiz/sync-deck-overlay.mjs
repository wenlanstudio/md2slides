/**
 * 把统一的放映发题浮层源码同步到两个运行时：
 *  - 文览本地放映静态资源（resources + dist/win-unpacked）
 *  - 文枢 Web 放映 classpath 资源（随 jar 走）
 *
 * 跑法：node D:/md-ecosystem/md2slides/kit/quiz/sync-deck-overlay.mjs
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../..")
const source = resolve(here, "deck-overlay.js")

if (!statSync(source).isFile()) throw new Error(`缺少源脚本: ${source}`)

const targets = [
  resolve(root, "wenlan/packages/desktop/resources/md2slides/quiz-deck.js"),
  resolve(root, "wenlan/dist/win-unpacked/resources/resources/md2slides/quiz-deck.js"),
  resolve(root, "wenshu-server/wenshu-module-teaching/src/main/resources/quiz-deck.js")
]

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  console.log(`✓ ${target}`)
}
