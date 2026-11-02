"use strict"

/**
 * serve.js — 给 e2e 用的极简静态服务（只服务本仓库目录）。
 *
 * 为什么放着 `file://` 不用：html-to-image 栅格公式时要 XHR 去取 KaTeX 的 woff2，
 * 而 Chrome 一律拒绝 XHR 到 `file://`（`--allow-file-access-from-files` 也管不到 XHR）。
 * 字体取不回来有两重后果——栅格出的图字体退化，更要命的是**公式高度量不准**，
 * 而物理分页的每一个决定都建立在实测高度上。
 *
 * 端口交给系统分配（`listen(0)`），省得撞端口，也不用费心回收。
 */

const http = require("http")
const fs = require("fs")
const path = require("path")

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
}

/**
 * 这些请求本就不该有内容，一律回 204，免得在控制台刷屏。
 *
 * · `favicon.ico`：浏览器自己要的，跟文档无关；
 * · KaTeX 字体的 `woff` / `ttf`：@font-face 里备了一串格式，发行版却只带 `woff2`。
 *   浏览器只取 woff2（能命中），但 html-to-image 内嵌 CSS 时会无差别请求每个 `url()`，
 *   于是把并不存在的备选格式全问一遍。
 *
 * 注意**不包含 woff2**：它要是也 404，那才是真的字体没取到，必须让它报错。
 */
const NO_CONTENT = /(^|\/)favicon\.ico$|\/fonts\/[^/]+\.(woff|ttf)$/

/**
 * @param {string} root 只服务这个目录（及其子目录）
 * @returns {Promise<{ port: number, url: string, close: Function }>}
 */
const serve = root => {
  const base = path.resolve(root)

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "")
      const file = path.resolve(base, rel)
      // 路径穿越：`..` 会被 path.resolve 展开，再检查它是否仍在 base 里。
      if (file !== base && !file.startsWith(base + path.sep)) {
        res.writeHead(403).end()
        return
      }
      if (NO_CONTENT.test(rel)) {
        res.writeHead(204).end()
        return
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          if (process.env.MD2SLIDES_SERVE_LOG) console.error(`[serve] 404  ${rel}`)
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, {
          "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        })
        res.end(data)
      })
    })

    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

module.exports = { serve }
