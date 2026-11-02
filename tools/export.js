"use strict"

/**
 * export.js — 一键导出 PPTX。给不想敲命令的普通用户：本命令也是编辑器
 * 「导出菜单」的挂载点（marktext 等宿主的菜单项，
 * 背后都是这一条）。
 *
 *   node tools/export.js deck.md                       # 图片型（默认，零依赖）
 *   node tools/export.js deck.md -o deck.pptx
 *   node tools/export.js deck.md --editable            # 可编辑型（需 Python + python-pptx）
 *
 * 两条通道（语义见 docs/API.md「导出」节）：
 *   图片型    整页真屏栅格 + pptxgenjs 铺满——与放映逐像素一致，零配置，普通用户默认；
 *   可编辑型  IR + Python sidecar——文字可改可换母版；环境里没 Python 就明说，不糊弄。
 *
 * 管线复用 e2e/runner 的共享段（buildPage / injectRuntime / settleDeck）：
 * 预览什么样，导出就什么样；管线副本是这条承诺的天敌。
 *
 * 失败体验（导出对话框的核心是失败时不沉默）：目标被占用 / 缺 Python / 内容闸门
 * 未过，全部人话（ExportError）；出片先写临时文件、成功后改名，绝不留半成品。
 */

const fs = require("fs")
const path = require("path")
const PptxGen = require("pptxgenjs")

const { buildPage, injectRuntime, settleDeck, CACHE_DIR } = require("../e2e/runner")
const { launch } = require("../e2e/browser")
const { serve } = require("../e2e/serve")
const { buildPptx } = require("../e2e/sidecar")

const ROOT = path.resolve(__dirname, "..")
const posix = p => p.split(path.sep).join("/")

const EMU_W = 13.333 // PPT 标准 16:9 画布（英寸），与 ir.js 的归一化画布一致
const EMU_H = 7.5

/** 导出失败的人话。code 供宿主（将来的对话框）分支：置灰 / 指引 / 反馈话术。 */
class ExportError extends Error {
  constructor(message, code = "EXPORT_FAILED") {
    super(message)
    this.name = "ExportError"
    this.code = code
  }
}

/** 原子写：临时文件写完改名。目标被占用（PowerPoint / WPS 开着）→ 人话。 */
function atomicWrite(out, data) {
  const tmp = `${out}.building.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, out)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    if (error.code === "EPERM" || error.code === "EBUSY") {
      throw new ExportError(`目标文件正被占用（PowerPoint / WPS 开着？）：${out}\n关闭后重试即可。`, "TARGET_BUSY")
    }
    throw error
  }
}

/** 同盘 rename、跨盘降级复制（.cache 工作区与用户目标目录可能不同盘）。 */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if (error.code !== "EXDEV") throw error
    fs.copyFileSync(from, to)
    fs.rmSync(from, { force: true })
  }
}

const parseArgs = argv => {
  const flags = new Map()
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-o") flags.set("o", argv[++i])
    else if (a === "--editable") flags.set("editable", true)
    else if (a === "--name") flags.set("name", argv[++i])
    else positional.push(a)
  }
  return {
    input: positional[0],
    out: flags.get("o"),
    editable: !!flags.get("editable"),
    name: flags.get("name"),
  }
}

/** 图片型：逐页真屏栅格 + pptxgenjs 铺满（零 Python，与放映逐像素一致）。 */
async function exportImagePptx(page, { out, slideWidth, slideHeight, onProgress }) {
  void slideWidth
  void slideHeight
  const handles = await page.$$("section[data-slide]")
  const pptx = new PptxGen()
  pptx.defineLayout({ name: "MD2S_16x9", width: EMU_W, height: EMU_H })
  pptx.layout = "MD2S_16x9"
  for (let i = 0; i < handles.length; i++) {
    const buf = await handles[i].screenshot()
    pptx.addSlide().addImage({
      data: "image/png;base64," + buf.toString("base64"),
      x: 0,
      y: 0,
      w: EMU_W,
      h: EMU_H,
    })
    onProgress?.("栅格", i + 1, handles.length)
  }
  onProgress?.("生成", 0, 1)
  const buffer = await pptx.write({ outputType: "nodebuffer" })
  atomicWrite(out, buffer)
  onProgress?.("生成", 1, 1)
  return handles.length
}

/** 可编辑型：IR + Python sidecar。内容闸门先行；临时目录出片，成功后搬到目标。 */
async function exportEditablePptx(page, { out, workDir, deck, onProgress }) {
  onProgress?.("抽取", 0, 1)
  const ir = await page.evaluate(o => window.md2slides.irAudit(o), {
    slideWidth: deck.slideWidth,
    slideHeight: deck.slideHeight,
    theme: deck.theme,
    meta: deck.meta ?? null,
  })
  // 内容闸门：issues 非空是引擎 bug 而不是用户错，话术照导出对话框的设计。
  if (ir.issues.length) {
    throw new ExportError(
      "导出前内容校验未通过，已中止（请附带原文档反馈）：\n  " +
        ir.issues.slice(0, 5).join("\n  "),
      "IR_GATE",
    )
  }

  fs.mkdirSync(workDir, { recursive: true })
  const mediaDir = path.join(workDir, "media")
  fs.mkdirSync(mediaDir, { recursive: true })
  for (const item of ir.media) {
    const base64 = String(item.dataUrl).split(",")[1] ?? ""
    fs.writeFileSync(path.join(mediaDir, item.name), Buffer.from(base64, "base64"))
  }
  const irFile = path.join(workDir, "ir.json")
  fs.writeFileSync(irFile, JSON.stringify(ir.ir, null, 2), "utf8")

  onProgress?.("生成", 0, 1)
  const tmp = path.join(workDir, "deck.building.pptx")
  const built = buildPptx({
    ir: irFile,
    out: tmp,
    media: mediaDir,
    report: path.join(workDir, "build-report.json"),
  })
  if (built.skipped) throw new ExportError(built.reason, "PYTHON_MISSING")
  if (!built.ok) {
    throw new ExportError(
      "Python sidecar 出片失败：\n" + [built.stderr, ...built.issues].filter(Boolean).join("\n"),
      "SIDECAR_FAILED",
    )
  }

  try {
    moveFile(tmp, out)
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EBUSY") {
      throw new ExportError(`目标文件正被占用（PowerPoint / WPS 开着？）：${out}\n关闭后重试即可。`, "TARGET_BUSY")
    }
    throw error
  }
  onProgress?.("生成", 1, 1)
  return { warnings: [...built.notes, ...built.pending] }
}

async function main() {
  const { input, out, editable, name: nameFlag } = parseArgs(process.argv.slice(2))
  if (!input) {
    console.error("用法: node tools/export.js <input.md> [-o out.pptx] [--editable] [--name NAME]")
    process.exit(1)
  }
  const md = fs.readFileSync(input, "utf8")
  const name = nameFlag ?? path.basename(input, path.extname(input))
  const outPath = path.resolve(out || path.join(path.dirname(path.resolve(input)), `${name}.pptx`))
  const onProgress = (stage, done, total) => {
    console.log(total != null ? `  ${stage}（${done}/${total}）` : `  ${stage}`)
  }

  console.log(editable ? "导出可编辑型 PPTX" : "导出图片型 PPTX")
  const server = await serve(ROOT)
  let browser
  try {
    // 管线（与 e2e / 放映同一份）：compose → 浏览器 → 图表 → 收敛 → 补染
    const { deck, file } = await buildPage(md, { name, baseUrl: server.url })
    browser = await launch({})
    const page = await browser.newPage()
    await page.setViewport({ width: deck.slideWidth, height: deck.slideHeight })
    page.on("pageerror", err => console.error(`⚠ 页面异常：${err.message}`))
    await page.goto(`${server.url}/${posix(path.relative(ROOT, file))}`, { waitUntil: "load" })

    onProgress?.("图表")
    await injectRuntime(page, deck.diagram?.deferred ?? [])
    onProgress?.("分页")
    await settleDeck(page, {
      slideWidth: deck.slideWidth,
      slideHeight: deck.slideHeight,
      contMarker: "（续）",
      margin: 1,
      meta: deck.meta ?? null,
    })

    const workDir = path.join(CACHE_DIR, "export", name)
    let warnings = []
    let pages = null
    if (editable) {
      const result = await exportEditablePptx(page, { out: outPath, workDir, deck, onProgress })
      warnings = result.warnings
    } else {
      pages = await exportImagePptx(page, { out: outPath, slideWidth: deck.slideWidth, slideHeight: deck.slideHeight, onProgress })
    }
    console.log(`✓ ${pages ? `${pages} 页 · ` : ""}${outPath}`)
    for (const w of warnings) console.log(`  提示：${w}`)
  } finally {
    if (browser) await browser.close()
    await server.close()
  }
}

main().catch(error => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
