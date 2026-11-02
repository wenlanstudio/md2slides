"use strict"
/**
 * media.js — 把 deck 里的位图落到磁盘，IR 里只留相对路径。
 *
 * deck 里的图片有四种来源，落盘前必须先认出来：
 *   1. data URL —— 图表栅格化、canvas 图表、matplotlib PNG（最常见）；
 *   2. `file:///C:/…` —— 主题/`![bg]` 指令里的本地图，marp 的 normalizeLink 会转成绝对 URI；
 *   3. 本地绝对路径 `C:\…` / `/…`；
 *   4. 相对路径 —— md 里的 `![](img/x.png)`，需要相对 md 所在目录解析。
 *
 * 统一成"media/ 下的相对文件名"之后，sidecar 只管读文件，不必再分辨来源，也不需要
 * 处理 base64（那会让 IR 胖到几十 MB）。
 */

const fs = require("fs")
const path = require("path")

const RE_DATA_URL = /^data:(image\/[a-z+]+);base64,([\s\S]*)$/i
const RE_FILE_URL = /^file:\/\/\/?(.*)$/i

const EXT_OF = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
}

/** `file:///C:/a/b.png` / `C:\a\b.png` → `C:\a\b.png`；其它原样返回 */
function toLocalPath(src) {
  const file = RE_FILE_URL.exec(src)
  if (file) {
    const rest = file[1]
    // `file:///C:/a` 剥掉协议后是 `C:/a`；`file://C:/a` 同理
    return /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest
  }
  return src
}

/**
 * @param {string} dir 媒体落盘目录（会被创建）
 * @param {string} [baseDir] 相对路径的解析基准（md 所在目录）
 * @returns {{ add: (src: string, hint?: string) => string|null, warnings: string[], count: number }}
 */
function createMediaSink(dir, baseDir) {
  fs.mkdirSync(dir, { recursive: true })
  const used = new Map()
  const warnings = []
  let seq = 0

  const add = (src, hint = "img") => {
    if (!src) return null
    if (used.has(src)) return used.get(src)
    // `data:,` 是 0×0 画布的 toDataURL 结果（隐藏页上的活图表就是这样）：不是图，别当路径处理
    if (src.startsWith("data:") && !RE_DATA_URL.test(src)) {
      warnings.push(`图片无效（空 data URL）：${src.slice(0, 40)}`)
      return null
    }

    const name = () => `${hint}-${seq++}`
    try {
      const data = RE_DATA_URL.exec(src)
      if (data) {
        const ext = EXT_OF[(data[1] ?? "").toLowerCase()] ?? ".png"
        const file = `${name()}${ext}`
        fs.writeFileSync(path.join(dir, file), Buffer.from(data[2], "base64"))
        used.set(src, file)
        return file
      }

      const raw = decodeURIComponent(toLocalPath(src))
      const abs = path.isAbsolute(raw) ? raw : path.resolve(baseDir ?? process.cwd(), raw)
      if (!fs.existsSync(abs)) {
        warnings.push(`图片不存在：${src}`)
        return null
      }
      const file = `${name()}${path.extname(abs) || ".png"}`
      fs.copyFileSync(abs, path.join(dir, file))
      used.set(src, file)
      return file
    } catch (error) {
      warnings.push(`图片落盘失败：${src}（${error?.message ?? error}）`)
      return null
    }
  }

  return {
    add,
    warnings,
    get count() {
      return used.size
    },
  }
}

module.exports = { createMediaSink }
