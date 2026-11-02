"use strict";

/**
 * server.js — 宿主壳的本地静态 http（只听 127.0.0.1，端口系统分配）。
 *
 * 为什么不能没有它：deck iframe 要从本地取资源，而浏览器对 `file://` 一律不伺候——
 *
 *  ① **KaTeX 字体**：@font-face 的字体加载是 CORS 模式的请求，`file://` 页面取不到，
 *     取回来的是 fallback 字体——公式高度直接量错，物理分页的每个决定都建在错数上
 *     （README「已知坑」同款）。取 `http://127.0.0.1` 的字体属跨源，响应必须带 `ACAO: *`。
 *  ② **文档里的本地图片**：经 http 进 iframe。html-to-image 栅格时跨域图会污染
 *     canvas（toDataURL 被禁），图片型导出的前提就是图片同源（P3-d 铺垫）。
 *  ③ **（marktext 形态）deck 页面本体与静态资产**：marktext 渲染进程全沙箱 + CSP
 *     `script-src 'self'`（无 unsafe-inline）——srcdoc 里内联脚本直接被拦。deck 页面
 *     改从本服务加载（`/deck.html` + `/dist/*` + `/lib/*` + `/themes/*`），服务出来的
 *     文档不受编辑器 CSP 约束，脚本/字体/图片全部自然放行。
 *
 * 服务范围**钉死**，不开放任意本地文件读取：
 *  - `/fonts/<name>`  只读 KaTeX 字体目录；
 *  - `/f?p=<绝对路径>` 只读 allowRoots 里的文件（当前 md 所在目录 + 字体目录）；
 *  - `assets` 登记的 `<prefix>/<相对路径>` 只读对应 dir（vendored md2slides 资产包）。
 * 端口 ephemeral、随宿主关停而停。any-page-in-renderer 都能来读是本地进程级暴露；
 * deck iframe 的内容来自用户自己的 md，信任模型不变。
 */

const http = require("http")
const fs = require("fs")
const path = require("path")

const MIME = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
}

/** 这些请求本就不该有内容，回 204，免得控制台刷屏（KaTeX 只发行 woff2）。 */
const NO_CONTENT = /(^|\/)favicon\.ico$|\/fonts\/[^/]+\.(woff|ttf)$/

/**
 * 导出旁路（M2 真机教训）：大体量位图（79 页讲义 ≈ 数百 MB）过 postMessage→IPC
 * 三跳会把 Electron 序列化/管道背压卡死（全进程 CPU 归零的挂死）。改为 deck 页面
 * 逐页 POST 给本服务落盘，宿主间只传目录路径。会话在内存登记、目录钉死在
 * os.tmpdir 下——不开放任意路径写入。
 */
const os = require("os")
const crypto = require("crypto")
const exportSessions = new Map()

const handleExport = (req, res, url) => {
  const op = url.searchParams.get("op")
  const sid = url.searchParams.get("sid") ?? ""
  if (op === "begin") {
    const id = crypto.randomBytes(8).toString("hex")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `md2slides-export-${id}-`))
    exportSessions.set(id, { dir, files: 0 })
    send(res, 200, JSON.stringify({ sid: id, dir }), "application/json")
    return
  }
  const session = exportSessions.get(sid)
  if (!session) return send(res, 404, "{}", "application/json")
  if (op === "page" || op === "media") {
    const name = url.searchParams.get("name") ?? ""
    if (!/^[\w.-]{1,120}$/.test(name) || name.includes("..")) return send(res, 400, "")
    const chunks = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      // 协议约定：body 是 PNG 的纯 base64 文本（deck 页面已 split(",")[1] 取走前缀），
      // 必须解码成二进制再落盘——否则 main 侧 pptx.js 读回 .toString("base64") 会二次编码，
      // 产出的 pptx 每张图都变成「无法显示该图片」（可编辑型的 media 走同一条，一并修好）。
      fs.writeFileSync(path.join(session.dir, name), Buffer.from(Buffer.concat(chunks).toString("utf8"), "base64"))
      session.files += 1
      send(res, 200, "{}", "application/json")
    })
    return
  }
  if (op === "done" || op === "abort") {
    exportSessions.delete(sid)
    if (op === "abort") fs.rmSync(session.dir, { recursive: true, force: true })
    send(res, 200, JSON.stringify({ dir: session.dir, files: session.files }), "application/json")
    return
  }
  send(res, 400, "")
}

const send = (res, code, body, type) => {
  const headers = {
    // deck iframe 取 http 字体/图片可能跨源；图片栅格也要求 ACAO。
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  }
  if (type) headers["content-type"] = type
  res.writeHead(code, headers)
  res.end(body)
}

const sendFile = (res, file) => {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "")
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream")
  })
}

/** 解析后的绝对路径必须落在某个 root 里（含 root 自身）。 */
const under = (file, roots) =>
  roots.some(root => {
    const base = path.resolve(root)
    return file === base || file.startsWith(base + path.sep)
  })

/**
 * @param {object} opts
 * @param {string} opts.fontsDir          KaTeX 字体目录（挂在 /fonts/ 下）
 * @param {string[]} [opts.allowRoots]    /f 允许读取的目录（当前 md 所在目录等）
 * @param {Array<{prefix: string, dir: string}>} [opts.assets]
 *        静态资产根：`<prefix>/<相对路径>` 只读对应 dir 下的文件（prefix 以 / 开头、
 *        以 / 结尾，或恰好等于pathname 如 "/"）。marktext 形态用它挂 vendored 资产包。
 * @returns {Promise<{port: number, url: string, fontsUrl: string, close: () => Promise<void>}>}
 */
const startServer = ({ fontsDir, allowRoots = [], assets = [] }) =>
  new Promise((resolve, reject) => {
    const roots = [fontsDir, ...allowRoots].filter(Boolean).map(root => path.resolve(root))
    const assetRoots = (assets ?? [])
      .filter(a => a && a.prefix && a.dir)
      .map(a => ({ prefix: a.prefix.endsWith("/") ? a.prefix : `${a.prefix}/`, dir: path.resolve(a.dir) }))

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1")
      const pathname = decodeURIComponent(url.pathname)

      if (pathname === "/x") return handleExport(req, res, url)

      if (pathname.startsWith("/fonts/")) {
        const file = path.resolve(fontsDir, pathname.slice("/fonts/".length))
        if (!under(file, [fontsDir])) return send(res, 403, "")
        if (NO_CONTENT.test(pathname)) return send(res, 204, "")
        return sendFile(res, file)
      }

      if (pathname === "/f") {
        const target = url.searchParams.get("p")
        if (!target) return send(res, 400, "")
        const file = path.resolve(target)
        if (!under(file, roots)) return send(res, 403, "")
        return sendFile(res, file)
      }

      for (const { prefix, dir } of assetRoots) {
        if (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) {
          const rel = pathname === prefix.slice(0, -1) ? "" : pathname.slice(prefix.length)
          const file = path.resolve(dir, rel)
          if (!under(file, [dir])) return send(res, 403, "")
          return sendFile(res, file)
        }
      }

      send(res, 404, "")
    })

    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        fontsUrl: `http://127.0.0.1:${port}/fonts/`,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })

module.exports = { startServer }
