"use strict"

/**
 * fetch-plantuml.js — 下载固定版本的 PlantUML jar 到 host/lib/。
 *
 * PlantUML 是 GPL-3.0，二进制不进版本库；第一次画 plantuml 图前跑一次：
 *   npm run fetch:plantuml
 *
 * 版本与 SHA-256 都钉死；下载内容不符即失败，不会把半截文件留在仓库里。
 * 已存在且校验通过则直接跳过（--force 可强制重下）。
 */

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const VERSION = "8059"
const SHA256 = "85eaaad99d64f0733c9ce46edcf176f2e9e14264556d8bf73fc3847059c00995"
const URL = `https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/${VERSION}/plantuml-${VERSION}.jar`
const DEST = path.join(__dirname, "..", "host", "lib", "plantuml.jar")

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex")

const main = async () => {
  const force = process.argv.includes("--force")

  if (!force && fs.existsSync(DEST)) {
    const have = sha256(fs.readFileSync(DEST))
    if (have === SHA256) {
      console.log(`PlantUML ${VERSION} 已就绪：${DEST}`)
      return
    }
    console.log(`现有 jar 校验不符（${have.slice(0, 12)}…），重新下载`)
  }

  console.log(`下载 PlantUML ${VERSION}：${URL}`)
  const res = await fetch(URL, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)

  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha256(buf)
  if (got !== SHA256) {
    throw new Error(`SHA-256 校验失败：期望 ${SHA256}，实际 ${got}`)
  }

  fs.mkdirSync(path.dirname(DEST), { recursive: true })
  fs.writeFileSync(DEST, buf)
  console.log(`已写入 ${DEST}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`)
}

main().catch(err => {
  console.error(`fetch-plantuml: ${err.message}`)
  process.exit(1)
})
