"use strict"

/**
 * export-html.js — 把一份 Markdown 跑完整分页（逻辑 + headless 物理分页），
 * 导出一份**自带放映器**的独立 HTML 幻灯片（不依赖任何外部服务，双击即放）。
 *
 *   node tools/export-html.js examples/demo.md -o slides.html
 *
 * 复用 e2e 那条真链路（compose → 浏览器里 overflow.js 物理分页 → 收敛后补色），
 * 只取到分页后的 DOM，再裹一层放映器：← → / 空格 翻页、F 全屏、窗口缩放自适应。
 * 不生成 PPTX（那是 export/pptx/sidecar 的活）。
 */

const fs = require("fs")
const path = require("path")
const { renderDiagram: thinRenderDiagram } = require("../host/thin")
const { buildPage, CACHE_DIR } = require("../e2e/runner")
const { bundleScript } = require("../e2e/bundle")
const { launch } = require("../e2e/browser")
const { serve } = require("../e2e/serve")

const ROOT = path.resolve(__dirname, "..")
const posix = p => p.split(path.sep).join("/")

/**
 * 课堂竞答（kit/quiz）在独立 HTML 放映器里的那一半：把三件套打成一段自包含脚本内联进去。
 *
 * 不复用主 bundle——那个里塞的是整条渲染管线，独立 HTML 只需要竞答这三件套；
 * 而且独立 HTML 里根本没有主 bundle 的运行时（放映器是一段手写的内联脚本）。
 *
 * 配置走 URL 参数：`slides.html?room=ABCD&pass=123456`（房间号 + 房口令，
 * 在 classbuzz 教师页上拿）。没配就不挂面板——讲义上一点痕迹都不留。
 */
const QUIZ_BUNDLE = bundleScript(require.resolve("../kit/quiz/entry"))
/**
 * 图片查看器的独立包（点图片 → 全屏缩放/拖动/同页切图）。
 * 注意 loader 只有一个槽 `window.__md2slides_bundle`：多个 bundle 是**顺序加载、
 * 加载后立刻取用**的契约，所以这段脚本必须紧跟在自己的 bundle 后面、且排在 quiz
 * bundle 之前，中间别再插别的 bundle。
 */
const LIGHTBOX_BUNDLE = bundleScript(require.resolve("../kit/lightbox"))

function parseArgs(argv) {
  const flags = new Map()
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[i + 1] ?? "")
    else if (argv[i] === "-o") flags.set("o", argv[++i])
    else positional.push(argv[i])
  }
  return { input: positional[0], out: flags.get("o"), name: flags.get("name") }
}

/** 与 runDeck 同款：反复分页直到不再新增页。 */
async function settle(page, opts, maxRounds = 6) {
  const rounds = []
  for (let i = 0; i < maxRounds; i++) {
    const added = await page.evaluate(o => window.md2slides.paginate(o), opts)
    rounds.push(added)
    if (added === 0) break
  }
  return rounds
}

/**
 * 把 deck CSS 里的 KaTeX 字体引用就地内联成 data URI，导出件彻底不依赖外部字体文件
 * （双击即放，无需旁边摆一份 lib/katex/fonts）。只内联真实存在且能读的文件。
 */
function inlineKatexFonts(css) {
  // 语法无关：file:// 或 http://127.0.0.1:port 都行，只要路径里带 /lib/katex/fonts/。
  // 按文件名从本地 lib 读，读到就内联成 data URI，读不到就留原值（不写坏 CSS）。
  const re = /url\(\s*(['"]?)([^)'"]*?\/lib\/katex\/fonts\/([^)'"]+))\1\s*\)/g
  let out = css
  const seen = new Map()
  let m
  while ((m = re.exec(css))) {
    const [full, , url, file] = m
    if (seen.has(full)) continue
    let b64 = ""
    try {
      b64 = fs.readFileSync(path.join(ROOT, "lib/katex/fonts", file), "base64")
    } catch {
      continue
    }
    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase()
    const mime = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : "font/ttf"
    seen.set(full, `url(data:${mime};base64,${b64})`)
  }
  for (const [full, data] of seen) out = out.split(full).join(data)
  return out
}

async function runPipeline(md, name) {
  // 1) 逻辑分页（Node 侧 jsdom）：解析 + 逻辑分页 + 拼 CSS + 图表预通行（Node 侧会的部分）
  const server = await serve(ROOT)
  const { deck, file } = await buildPage(md, { name, baseUrl: server.url, renderDiagram: thinRenderDiagram })
  const deferred = deck.diagram?.deferred ?? []

  let browser
  try {
    browser = await launch({})
    const page = await browser.newPage()
    await page.setViewport({ width: deck.slideWidth, height: deck.slideHeight })
    const logs = []
    page.on("pageerror", err => logs.push(`pageerror: ${err.message}`))
    page.on("console", m => { if (m.type() === "error") logs.push(`console: ${m.text()}`) })

    await page.goto(`${server.url}/${posix(path.relative(ROOT, file))}`, { waitUntil: "load" })

    await page.addScriptTag({ path: require.resolve("../lib/highlight.min.js") })
    await page.addScriptTag({ path: require.resolve("../lib/html-to-image.js") })
    await page.addScriptTag({ path: require.resolve("../e2e/externals.js") })
    await page.addScriptTag({ content: bundleScript(require.resolve("../e2e/entry")) })
    await page.evaluate(() => { window.md2slides = window.installMd2slides(window.__md2slides_externals) })

    // 2) 图表预通行第二遍：mermaid / echarts 是浏览器运行时，只在页面里渲染。
    if (deferred.includes("mermaid")) await page.addScriptTag({ path: require.resolve("../host/lib/mermaid.min.js") })
    if (deferred.includes("echarts")) await page.addScriptTag({ path: require.resolve("../host/lib/echarts.min.js") })
    await page.evaluate(() => window.md2slides.diagramPass({}))
    await page.evaluate(() => document.fonts.ready.then(() => true))

    // 3) 物理分页（浏览器里按实测高度切）→ 收敛后补一次色 → 再稳一轮看回潮。
    const opts = { slideWidth: deck.slideWidth, slideHeight: deck.slideHeight, contMarker: "（续）", margin: 1, meta: deck.meta ?? null }
    const rounds = await settle(page, opts)
    const repainted = await page.evaluate(() => window.md2slides.repaint())
    if (repainted > 0) await settle(page, opts)

    const finalHtml = await page.evaluate(() => window.md2slides.deckHtml())
    if (logs.length) console.warn("⚠ 浏览器里有告警：\n" + logs.join("\n"))
    console.log(`分页收敛：逻辑 ${deck.slideCount} 页 → 物理 ${rounds.reduce((a, b) => a + b, 0) + deck.slideCount} 页`)
    return { deck, finalHtml }
  } finally {
    if (browser) await browser.close()
    await server.close()
  }
}

/** 裹放映器：每页一张、自适应缩放、键盘翻页、全屏。 */
function wrapViewer(deck, finalHtml) {
  const { slideWidth: W, slideHeight: H, css: rawCss } = deck
  const css = inlineKatexFonts(rawCss)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${deck.name ?? "slides"}</title>
<style>
${css}
/* —— 放映器样式（与主题无关，只管"怎么看"）—— */
html, body { margin: 0; height: 100%; background: #20252b; overflow: hidden; }
*{box-sizing:border-box}
#viewer { position: fixed; inset: 0; overflow: hidden;
  /* 触屏:单指平移让给 JS 手势(翻页)，双指缩放仍是浏览器的 */
  touch-action: pinch-zoom; }
/* 舞台：固定画布尺寸。left/top:50% 把布局盒左上角钉在视口中心，transform-origin
   取中心，scale 绕自身中心缩放——中心恒在视口中心，任何 scale 都严格居中，
   不依赖 translate 百分比（那个在 scale!=1 时反而错位）。 */
#stage { position: absolute; left: 50%; top: 50%; transform-origin: center center;
         width: ${W}px; height: ${H}px; }
#deck { position: absolute; inset: 0; }
/* 主题不负责定幻灯片尺寸（由宿主定），这里显式钉死画布，并把非当前页藏起来。 */
#deck > section[data-slide] { position: absolute; inset: 0; width: ${W}px; height: ${H}px;
         display: none; }
#deck > section[data-slide].active { display: flex; }
/* 播放条 */
#bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
       display: flex; align-items: center; gap: 14px; padding: 8px 16px; border-radius: 999px;
       background: rgba(20,24,30,.72); color: #e6e9ee; font: 14px/1 -apple-system,Segoe UI,Roboto,sans-serif;
       backdrop-filter: blur(6px); user-select: none; opacity: .25; transition: opacity .2s; }
#bar:hover, #viewer.idle-off #bar { opacity: 1; }
#bar button { width: 30px; height: 30px; border: 0; border-radius: 50%; cursor: pointer;
       background: #3a414b; color: #e6e9ee; font-size: 15px; }
#bar button:hover { background: #4b5563; }
#pageinfo { min-width: 64px; text-align: center; font-variant-numeric: tabular-nums; }
#hint { position: fixed; top: 14px; right: 16px; color: #8b939e; font: 12px/1 sans-serif;
       background: rgba(20,24,30,.5); padding: 6px 10px; border-radius: 6px; opacity:.5; }
</style></head>
<body>
<div id="viewer">
  <div id="stage"><div id="deck">${finalHtml}</div></div>
</div>
<div id="hint">← → 翻页 · F 全屏 · Esc 退出</div>
<div id="bar">
  <button id="prev" title="上一页">‹</button>
  <span id="pageinfo"></span>
  <button id="next" title="下一页">›</button>
</div>
<script>
(function () {
  var W = ${W}, H = ${H};
  var deck = document.getElementById("deck");
  var slides = Array.prototype.slice.call(deck.querySelectorAll("section[data-slide]"));
  var n = slides.length, i = 0;
  var viewer = document.getElementById("viewer");
  var stage = document.getElementById("stage");
  var info = document.getElementById("pageinfo");
  function fit() {
    var s = Math.min(window.innerWidth / W, window.innerHeight / H) * 0.99;
    stage.style.transform = "translate(-50%,-50%) scale(" + s + ")";
  }
  function show(k) {
    i = Math.max(0, Math.min(n - 1, k));
    slides.forEach(function (s, idx) { s.classList.toggle("active", idx === i); });
    info.textContent = (i + 1) + " / " + n;
  }
  function go(d) { show(i + d); }
  document.getElementById("prev").onclick = function () { go(-1); };
  document.getElementById("next").onclick = function () { go(1); };
  window.addEventListener("keydown", function (e) {
    if (["ArrowRight","ArrowDown","PageDown"," ","Spacebar"].indexOf(e.key) >= 0) { e.preventDefault(); go(1); }
    else if (["ArrowLeft","ArrowUp","PageUp"].indexOf(e.key) >= 0) { e.preventDefault(); go(-1); }
    else if (e.key === "Home") { e.preventDefault(); show(0); }
    else if (e.key === "End") { e.preventDefault(); show(n - 1); }
    else if (e.key === "f" || e.key === "F") { toggleFs(); }
  });
  function toggleFs() {
    if (!document.fullscreenElement) (document.documentElement.requestFullscreen || function(){}).call(document.documentElement);
    else document.exitFullscreen();
  }
  // 触屏:单指滑动翻页(左/上 = 下一页,右/下 = 上一页)。第二根手指落地就撒手
  // (那是双指缩放),一次手势只翻一页;低于门槛的抖动、斜划、慢拖都不算。
  // 轻点也翻页(点右半往下、点左半往上):触屏没键盘时最顺手的手段,与 kit/player
  // 的语义一致——抬手时位移仍小于 12px、用时不到 500ms 才算「点」。
  var t0 = null, tAt = 0;
  var TAP_SLOP = 12, TAP_MS = 500;
  function touchPoint(e) {
    var t = e.changedTouches && e.changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  }
  viewer.addEventListener("touchstart", function (e) {
    t0 = e.touches.length === 1 ? touchPoint(e) : null;
    if (t0) t0.target = e.target;
    tAt = Date.now();
  }, { passive: true });
  viewer.addEventListener("touchmove", function (e) {
    if (!t0 || e.touches.length !== 1) return;
    var p = touchPoint(e);
    if (!p) return;
    var dx = p.x - t0.x, dy = p.y - t0.y, ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < 40) return;
    if (Date.now() - tAt > 800) return;
    if (ax > ay ? ax < ay * 1.2 : ay < ax * 1.2) return;
    t0 = null;
    go((ax > ay ? dx : dy) < 0 ? 1 : -1);
  }, { passive: true });
  viewer.addEventListener("touchend", function (e) {
    var start = t0, at = tAt;
    t0 = null;
    if (!start) return;                                  // 已经按滑动翻过了
    var p = touchPoint(e);
    if (!p) return;
    if (Math.abs(p.x - start.x) > TAP_SLOP || Math.abs(p.y - start.y) > TAP_SLOP) return;
    if (Date.now() - at > TAP_MS) return;                // 长按 = 选词/菜单，不是点
    var hit = start.target;
    // 点了要有自己反应的东西（按钮/链接/图片看大图）就不许顺带翻页
    if (hit && hit.closest && hit.closest("a[href],button,input,textarea,select,img,svg,video,audio,[data-md2s-activatable]")) return;
    var r = viewer.getBoundingClientRect();
    go((p.x - r.left) / r.width < 0.5 ? -1 : 1);
  }, { passive: true });
  viewer.addEventListener("touchcancel", function () { t0 = null; }, { passive: true });
  // 鼠标静止时把播放条藏起来，移动即现（放映时不挡内容）。
  var idle;
  function wake() { viewer.classList.remove("idle-off"); clearTimeout(idle);
    idle = setTimeout(function () { viewer.classList.add("idle-off"); }, 2600); }
  document.addEventListener("mousemove", wake); wake();
  window.addEventListener("resize", fit);
  fit(); show(0);
})();
</script>
<script>${LIGHTBOX_BUNDLE}</script>
<script>
/* —— 图片查看：点当前页的图 → 全屏看原图（滚轮/双指缩放、拖动移动、← → 切图、Esc 关）——
   当前页的标记是 .active（这套独立放映器自己的类），故显式指出来。 */
(function () {
  var api = window.installMd2slides({});
  if (!api || !api.mountLightbox) return;
  api.mountLightbox(document, {
    currentSlide: function () { return document.querySelector("#deck > section[data-slide].active"); }
  });
})();
</script>
<script>
${QUIZ_BUNDLE}
</script>
<script>
/* —— 课堂竞答：房间号 + 房口令从 URL 取（?room=ABCD&pass=123456）——
   取过一次记进 localStorage，下次直接开就行。没配就整段不跑：讲义上不留痕迹。 */
(function () {
  var q = new URLSearchParams(location.search);
  var KEY = "md2slides_quiz";
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { saved = {}; }
  var room = (q.get("room") || saved.room || "").trim().toUpperCase();
  var pass = (q.get("pass") || saved.pass || "").trim().toUpperCase();
  var url = (q.get("cburl") || saved.url || "ws://127.0.0.1:3000").trim();
  if (!room || !pass) return;
  try { localStorage.setItem(KEY, JSON.stringify({ room: room, pass: pass, url: url })); } catch (e) {}
  var api = window.installMd2slides({});
  var client = api.createQuizClient({ url: url, room: room, passcode: pass });
  var panel = api.mountQuizPanel(document, { client: client });
  // 讲义里一道题都没有 → 面板压根没建（active 为 false），这时也不必连：
  // 连了没人用，白占一条连接。讲义上一点痕迹都不留。
  if (panel && panel.active) client.connect();
})();
</script>
</body></html>`
}

async function main() {
  const { input, out } = parseArgs(process.argv.slice(2))
  if (!input) {
    console.error("用法: node tools/export-html.js <input.md> [-o out.html] [--name NAME]")
    process.exit(1)
  }
  const md = fs.readFileSync(input, "utf8")
  const name = path.basename(input, ".md")
  const { deck, finalHtml } = await runPipeline(md, name)
  const html = wrapViewer({ ...deck, name }, finalHtml)
  const outPath = path.resolve(out || path.join(CACHE_DIR, `${name}.slides.html`))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, html, "utf8")
  console.log(`${deck.slideWidth}x${deck.slideHeight} · ${slidesCount(finalHtml)} 页 · 已导出 ${outPath}`)
}

/** 数一下分到了几页（section[data-slide] 个数） */
function slidesCount(html) {
  return (html.match(/<section[^>]*data-slide/g) || []).length
}

if (require.main === module) main()
module.exports = { runPipeline, wrapViewer }
