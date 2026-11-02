"use strict"

/**
 * plantuml.js — 薄宿主的 plantuml 渲染器：`java -jar plantuml.jar -tpng -pipe`。
 *
 * 两个环境坑，都在这里兜住：
 *
 *  1. **plantuml 近年的版本要 Java 11+**。机器上 PATH 里的 `java` 常常还是 8
 *     （本机就是 1.8），直接跑会抛 `UnsupportedClassVersionError`。所以这里会
 *     挑一个真够新的 java：`PLANTUML_JAVA` > JetBrains 自带的 jbr（现成的 11+）> PATH。
 *  2. **plantuml 用了 `java.desktop` 的内部类**（`PngIOMetadata` 去访问
 *     `com.sun.imageio.plugins.png.PNGMetadata`）。Java 9 的模块系统默认不给访问，
 *     会抛 `IllegalAccessError`，得显式 `--add-exports` 才让过。
 *
 * 出 PNG 而不是别的原因同 `graphviz.js`：IR 的 image 块走 media 落盘 → sidecar 插图。
 */

const { spawnSync } = require("child_process")
const fs = require("fs")
const path = require("path")

/** jar 在哪：`PLANTUML_JAR` > `npm run fetch:plantuml` 下到 `host/lib/plantuml.jar`。 */
const jarPath = () => process.env.PLANTUML_JAR || path.join(__dirname, "../lib/plantuml.jar")

const exe = process.platform === "win32" ? "java.exe" : "java"

/** java 候选：`PLANTUML_JAVA` > JetBrains jbr > PATH。 */
const javaCandidates = () => {
  const out = []
  if (process.env.PLANTUML_JAVA) out.push(process.env.PLANTUML_JAVA)
  const roots =
    process.platform === "win32"
      ? ["D:\\Program Files\\JetBrains", "C:\\Program Files\\JetBrains"]
      : []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root)) {
      const bin = path.join(root, dir, "jbr", "bin", exe)
      if (fs.existsSync(bin)) out.push(bin)
    }
  }
  out.push(exe)
  return out
}

/** `java -version` 打在 stderr 上，两边都读。取主版本号（"1.8" → 8，"25.0.2" → 25）。 */
const javaMajor = res => {
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`
  const m = /version "(?:1\.)?(\d+)/.exec(String(text))
  return m ? Number(m[1]) : 0
}

/** 挑一个真能跑 plantuml 的 java（要 11+），顺便把主版本号带出来。 */
const javaRuntime = () => {
  const tried = []
  for (const bin of javaCandidates()) {
    const res = spawnSync(bin, ["-version"])
    const major = res.error ? 0 : javaMajor(res)
    if (!res.error && major >= 11) return { bin, major }
    tried.push(res.error ? `${bin}: ${res.error.message}` : `${bin}: Java ${major}（要 11+）`)
  }
  throw new Error(
    `找不到 Java 11+ 来跑 plantuml：${tried.join("；")}。` +
      `装一个新 JDK，或用 PLANTUML_JAVA 指到 java.exe`,
  )
}

/** 作者常常只写正文不写 `@startuml`，补上——plantuml 少了这对标记什么都不出。 */
const wrapSource = src => {
  const text = String(src ?? "").trim()
  if (!text) throw new Error("plantuml 块是空的")
  return /@start\w+/.test(text) ? text : `@startuml\n${text}\n@enduml`
}

/**
 * @param {string} source plantuml 源码（可有可无 `@startuml` / `@enduml`）
 * @param {object} [opts]
 * @param {string} [opts.format="png"] 输出格式
 * @returns {{ png: Buffer, dataUrl: string, width?: number, height?: number }}
 * @throws {Error} 没 jar / 没 Java 11+ / 退出码非 0 / 没吐出 PNG —— 一律硬失败
 */
const renderPlantuml = (source, opts = {}) => {
  const jar = jarPath()
  if (!fs.existsSync(jar)) {
    throw new Error(
      `没有 plantuml.jar（找的是 ${jar}）。跑 \`npm run fetch:plantuml\` 下载，` +
        `或放一个进去 / 用 PLANTUML_JAR 指过去`,
    )
  }

  const { bin, major } = javaRuntime()
  const args = []
  // Java 9+ 才认 --add-exports；Java 8 上写它会直接"Unrecognized option"。
  if (major >= 9) {
    args.push("--add-exports", "java.desktop/com.sun.imageio.plugins.png=ALL-UNNAMED")
  }
  args.push("-jar", jar, `-t${opts.format ?? "png"}`, "-pipe", "-charset", "UTF-8")

  const res = spawnSync(bin, args, { input: wrapSource(source), maxBuffer: 32 * 1024 * 1024 })
  if (res.error) throw new Error(`跑不动 java（${bin}）：${res.error.message}`)
  if (res.status !== 0) {
    throw new Error(`plantuml 退出码 ${res.status}：${String(res.stderr ?? "").trim().slice(0, 400)}`)
  }

  const png = res.stdout
  if (!png?.length || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("plantuml 没吐出 PNG（输出不是 PNG 文件头）")
  }
  return {
    png,
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  }
}

module.exports = { renderPlantuml, jarPath, javaRuntime, wrapSource }
