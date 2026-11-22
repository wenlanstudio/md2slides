"use strict";

/**
 * drawioHost.js — **浏览器侧**渲染 drawio（diagrams.net embed 的 postMessage 协议）。
 *
 * DrawIO 没有可离线的渲染库——编辑器（wenlan muya drawio/index.ts）就是靠真 embed
 * 应用画图并导出，deck 走**同一条协议**：iframe 里起 embed，`init` → `load(xml)` →
 * `autosave`（图已在画布上）→ `export{format:'png'}` 拿 data URI。这需要网络能到
 * embed 服务（与编辑器同一软依赖；文览偏好 drawioServer 经 runOpts 透传，见
 * deck-full-entry 的 `__md2slides_drawioServer`）。
 *
 * `source` 指向本地 .drawio 文件时经宿主服务的 /f?p= 取（deck 页是 http 文档，
 * fetch file:// 一律被 Chrome 拒；与图片改道 rewriteImages 同款）。mdDir 由
 * deck-full-entry 放在 `window.__md2slides_mdDir`。
 *
 * 位图契约：export 不带 scale（1x），显示尺寸 = PNG IHDR 里的固有尺寸——与
 * mermaid「按固有尺寸显示」的约定一致。
 */

const { parseJsonBlock } = require("../../core/render/blockSource")

const DEFAULT_SERVER = "https://embed.diagrams.net"
const LOAD_TIMEOUT_MS = 20000
const EXPORT_TIMEOUT_MS = 20000

/** 与编辑器 drawioEmbedUrl 逐字一致：embed 模式 + min UI + 不给存盘按钮。 */
const embedUrl = server =>
  `${String(server ?? DEFAULT_SERVER).replace(/\/+$/, "")}/?embed=1&proto=json&ui=min&libraries=0&saveAndExit=0&noSaveBtn=1&noExitBtn=1&keepstyle=1`

/** `file:///D:/x.drawio` / `D:\x.drawio` / `/home/x.drawio` → 纯路径；http(s) 原样。 */
const sourcePath = source => {
  const text = String(source ?? "").trim()
  const file = /^file:\/\/\/(.*)$/i.exec(text)
  if (file) return decodeURIComponent(file[1])
  if (/^[a-z]:[\\/]/i.test(text)) return text.replace(/\\/g, "/")
  if (text.startsWith("/")) return text
  return null // 相对路径，交给调用方按 mdDir 拼绝对
}

/** 本地文件 → 宿主服务的 /f?p=（allowRoots 钉死白名单，越界 403 → 硬失败）。 */
const localUrl = path => {
  const mdDir = String(globalThis.__md2slides_mdDir ?? "").replace(/\\/g, "/").replace(/[\\/]+$/, "")
  const abs = path.startsWith("/") || /^[a-z]:\//i.test(path)
    ? path
    : mdDir
      ? `${mdDir}/${path}`
      : path
  if (!globalThis.location?.origin) {
    throw new Error(`drawio source "${path}" 是本地文件，但当前页面不在宿主服务上（拿不到 /f?p= 改道）`)
  }
  return `${globalThis.location.origin}/f?p=${encodeURIComponent(abs)}`
}

/**
 * 围栏里画的 XML：直接嵌 `<mxfile>/<mxGraphModel>` 用原样；否则是 graphConfig，
 * 从 `source`（本地文件走 /f?p=，http(s) 直接 fetch）取。
 */
const resolveXml = async source => {
  const text = String(source ?? "")
  if (text.trimStart().startsWith("<")) return text.trim()

  let value
  try {
    ;({ value } = parseJsonBlock(text))
  } catch (error) {
    throw new Error(`drawio 块既不是 XML 也不是可解析的 graphConfig：${error.message}`)
  }
  const src = typeof value?.source === "string" ? value.source.trim() : ""
  if (!src) {
    throw new Error("drawio 块没有图——要么直接放 <mxfile>/<mxGraphModel> XML，要么在 graphConfig 里给 source")
  }

  const isRemote = /^(https?:)?\/\//i.test(src)
  const url = isRemote
    ? src
    : localUrl(sourcePath(src) ?? src)
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`drawio source ${src} 取不到：${error instanceof Error ? error.message : error}`)
  }
  if (!response.ok) {
    throw new Error(`drawio source ${src} 取不到（HTTP ${response.status}——文件在 allowRoots 白名单里吗？）`)
  }
  return response.text()
}

/** PNG IHDR 的宽高（data URI 的位图固有尺寸，显示尺寸按它来）。 */
const pngSize = dataUrl => {
  const comma = dataUrl.indexOf(",")
  if (comma < 0) return null
  try {
    const bin = atob(dataUrl.slice(comma + 1))
    if (bin.slice(12, 16) !== "IHDR") return null
    const view = new DataView(new ArrayBuffer(8))
    for (let i = 0; i < 8; i++) view.setUint8(i, bin.charCodeAt(16 + i))
    return { width: view.getUint32(0), height: view.getUint32(4) }
  } catch {
    return null
  }
}

const embedMessage = raw => {
  if (typeof raw !== "string" || !raw.startsWith("{")) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * @param {{type: string, source: string}} block
 * @returns {Promise<{dataUrl: string, width?: number, height?: number}>}
 * @throws {Error} XML 取不到 / embed 不应答 / 导出失败 —— 一律硬失败（不接受降级）
 */
const renderDrawio = async block => {
  const xml = await resolveXml(block.source)
  const server = String(globalThis.__md2slides_drawioServer ?? DEFAULT_SERVER)

  return await new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe")
    iframe.className = "md2slides-diagram-drawio"
    iframe.src = embedUrl(server)
    // 离屏：embed 要真加载才能画，display:none 会让部分浏览器省掉渲染。
    iframe.style.cssText = "position:absolute;left:-99999px;top:0;width:1024px;height:768px;"
    // 与编辑器同款沙箱：embed 应用要脚本与自己的存储，其余锁死。
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups")
    iframe.setAttribute("title", "drawio diagram")

    let phase = "load" // load → export → done
    let loadTimer = null
    let exportTimer = null
    let settled = false

    const cleanup = () => {
      for (const t of [loadTimer, exportTimer]) if (t) clearTimeout(t)
      window.removeEventListener("message", onMessage)
      iframe.remove()
    }
    const fail = message => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }

    function onMessage(event) {
      if (event.source !== iframe.contentWindow) return
      const message = embedMessage(event.data)
      if (!message) return

      if (message.event === "init") {
        iframe.contentWindow?.postMessage(JSON.stringify({ action: "load", xml, autosave: 1 }), "*")
      } else if (message.event === "autosave" || message.event === "save") {
        // 图已上画布。编辑器把画图与导出拆成 renderDrawio/exportDrawio 两步，
        // deck 一次到位——deck 里没有「留在页面上给人看」的 embed 终态。
        if (phase !== "load") return
        phase = "export"
        if (loadTimer) {
          clearTimeout(loadTimer)
          loadTimer = null
        }
        exportTimer = setTimeout(
          () => fail(`drawio embed 导出超时（${EXPORT_TIMEOUT_MS}ms）`),
          EXPORT_TIMEOUT_MS,
        )
        iframe.contentWindow?.postMessage(JSON.stringify({ action: "export", format: "png" }), "*")
      } else if (message.event === "export" && typeof message.data === "string" && message.data.startsWith("data:image/png")) {
        settled = true
        const size = pngSize(message.data)
        cleanup()
        resolve({ dataUrl: message.data, width: size?.width, height: size?.height })
      } else if (message.event === "export") {
        fail(`drawio embed 导出没给出 PNG（${typeof message.data}）`)
      }
    }

    window.addEventListener("message", onMessage)
    loadTimer = setTimeout(
      () => fail(`drawio embed ${server} 没有应答——查网络，或把 drawioServer 偏好指到可用服务`),
      LOAD_TIMEOUT_MS,
    )

    document.body.appendChild(iframe)
  })
}

module.exports = { renderDrawio, embedUrl, pngSize, resolveXml, sourcePath, localUrl, DEFAULT_SERVER, LOAD_TIMEOUT_MS, EXPORT_TIMEOUT_MS }
