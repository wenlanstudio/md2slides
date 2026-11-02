"use strict"

/**
 * graphviz.js — 薄宿主的 graphviz 渲染器：调 `dot` 出 PNG。
 *
 * 为什么出 PNG 而不是 SVG：`ir.js` 见到 `IMG` 直接出 image 块（data URL → media 落盘 →
 * sidecar 插图），一路没有歧义；内联 SVG 要先栅格，栅格失败还会退化成 `custom`，
 * 被 sidecar 当成"已跳过"整块丢掉。
 *
 * `-Gdpi=192` 沿用离线工具链的口径（README：`build.py` 用 `dot -Tpng -Gdpi=192`）。
 */

const { spawnSync } = require("child_process")
const fs = require("fs")

/**
 * dot 在哪：环境变量 > 常见安装路径 > 交给 PATH。
 *
 * Graphviz 的 Windows 安装包**不写 PATH**（`which dot` 找不到），所以候选路径是必需的，
 * 不能只靠 `spawnSync("dot", …)`。
 */
const dotBinary = () => {
  if (process.env.GRAPHVIZ_DOT) return process.env.GRAPHVIZ_DOT
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Graphviz\\bin\\dot.exe",
          "C:\\Program Files (x86)\\Graphviz\\bin\\dot.exe",
        ]
      : ["/usr/local/bin/dot", "/opt/homebrew/bin/dot", "/usr/bin/dot"]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return "dot"
}

/** PNG 头里的宽高（IHDR）。拿不到就返回 null —— 浏览器会按图片自身尺寸排，不影响正确性。 */
const pngSize = buf => {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * @param {string} source DOT 源码
 * @param {object} [opts]
 * @param {number}   [opts.dpi=192] 输出分辨率
 * @param {string[]} [opts.args]    追加给 dot 的参数
 * @returns {{ png: Buffer, dataUrl: string, width?: number, height?: number }}
 * @throws {Error} dot 跑不动 / 退出码非 0 / 没吐出 PNG —— 一律硬失败，不降级
 */
const renderGraphviz = (source, opts = {}) => {
  const bin = dotBinary()
  const args = ["-Tpng", `-Gdpi=${opts.dpi ?? 192}`, ...(opts.args ?? [])]
  // 不给 encoding：默认返回 Buffer（写 "buffer" 反而会被当成未知编码抛错）。
  const res = spawnSync(bin, args, {
    input: source,
    maxBuffer: 32 * 1024 * 1024,
  })

  if (res.error) {
    throw new Error(
      `跑不动 dot（${bin}）：${res.error.message}。装 Graphviz，或用 GRAPHVIZ_DOT 指到 dot.exe`,
    )
  }
  if (res.status !== 0) {
    throw new Error(`dot 退出码 ${res.status}：${String(res.stderr ?? "").trim().slice(0, 400)}`)
  }

  const png = res.stdout
  if (!png?.length || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("dot 没吐出 PNG（输出不是 PNG 文件头）")
  }

  const size = pngSize(png) ?? {}
  return {
    png,
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    width: size.width,
    height: size.height,
  }
}

module.exports = { renderGraphviz, dotBinary, pngSize }
