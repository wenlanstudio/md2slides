"use strict";

/**
 * host/pptx — 宿主侧 PPTX 导出后端（宿主无关，Typora / marktext 共用）。
 *
 * 吃「直播 iframe」而不是重渲染页面：宿主把 deck 装进 iframe（deck-page.js）后，
 * 这里的两条通道与 tools/export.js CLI 同源（同一套 ir.js / check.js / sidecar）：
 *   · 图片型    逐页 html-to-image 栅格（iframe 已内联 html-to-image）→ pptxgenjs 铺满；
 *   · 可编辑型  iframe 的 deck.ir() 抽 IR + 闸门 → Python sidecar 出真·可编辑 pptx。
 * 更快，也不依赖第二个 Chromium——「预览什么样导出就什么样」天然成立。
 *
 * 宿主专属的只有**资产布局**：pptxgenjs（JS 包）与 sidecar（.py 文件集）必须真实
 * 落在宿主自己的 lib 目录（tools/build-host.js 的 ASSETS 产物）。所以入口是工厂：
 *
 *   const { exportPptx } = createExporter({ libDir: <宿主的 lib 目录> })
 *
 * libDir 里缺 pptxgenjs / sidecar **当场报错**——导出按钮点了没反应这类静默退化是
 * 这里要消灭的失败模式。绑定示例：Typora 在 host/typora/export.js（__dirname/lib）；
 * marktext（M1）绑它自己构建产物目录。
 */

const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const EMU_W = 13.333 // PPT 标准 16:9 画布（英寸），与 ir.js 归一化画布一致
const EMU_H = 7.5

/** 导出失败的人话。code 分支见 shell 侧：置灰指引 / 反馈话术 / 重试。 */
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

/** 同盘 rename、跨盘降级复制（临时目录与用户目标目录可能不同盘）。 */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if (error.code !== "EXDEV") throw error
    fs.copyFileSync(from, to)
    fs.rmSync(from, { force: true })
  }
}

/**
 * 挑一个真能跑 sidecar 的 Python：光有 python 不够，sidecar 要 import pptx（连 lxml），
 * PATH 里那个干净环境会当场 ModuleNotFoundError。所以判据是「能 import pptx」。
 */
const PY_CANDIDATES = [
  process.env.MD2SLIDES_PYTHON,
  process.env.PYTHON,
  "python",
  "python3",
  "D:/ProgramData/anaconda3/python.exe",
  "C:/ProgramData/anaconda3/python.exe",
]
let pythonCache = null
const findPython = () => {
  if (pythonCache !== null) return pythonCache
  pythonCache = PY_CANDIDATES.filter(Boolean).find(cmd => {
    try {
      const r = spawnSync(cmd, ["-c", "import pptx"], { encoding: "utf8", windowsHide: true })
      return r.status === 0
    } catch {
      return false
    }
  }) ?? null
  return pythonCache
}

/**
 * 绑定宿主资产布局，产导出函数。构造时就把 libDir 验明——pptxgenjs 与 sidecar
 * 缺谁都当场抛，不留到用户点导出才发现。
 *
 * @param {object} opts
 * @param {string} opts.libDir 宿主 lib 目录（内含 pptxgenjs/ 与 sidecar/）
 * @returns {{ exportPptx: Function, buildPptx: Function, exportFromData: Function }}
 *   exportPptx 吃直播 iframe（Typora）；exportFromData 吃已取好的数据
 *   （marktext：取数在 renderer 经 postMessage，出片在 main）——两条宿主
 *   路径共用同一套出片实现。
 */
const createExporter = ({ libDir } = {}) => {
  if (!libDir || typeof libDir !== "string") {
    throw new Error("createExporter 需要 libDir（宿主的 lib 资产目录，build-host 产物）")
  }
  const lib = path.resolve(libDir)
  if (!fs.existsSync(path.join(lib, "sidecar", "build_pptx.py"))) {
    throw new Error(`libDir 里没有 sidecar/build_pptx.py：${lib}（build-host 产物没拷全？）`)
  }
  if (!fs.existsSync(path.join(lib, "pptxgenjs"))) {
    throw new Error(`libDir 里没有 pptxgenjs：${lib}（build-host 产物没拷全？）`)
  }
  const PptxGen = require(path.join(lib, "pptxgenjs"))
  const SIDECAR_DIR = path.join(lib, "sidecar")

  /**
   * 调 Python sidecar 把 IR 变成真·可编辑 pptx。
   * @returns {{ skipped: boolean, reason?: string, ok: boolean, issues: string[],
   *             pending: string[], notes: string[], stderr: string }}
   */
  const buildPptx = io => {
    const python = findPython()
    if (!python) {
      return {
        skipped: true,
        reason:
          "找不到能 import pptx 的 Python（sidecar 要 python-pptx + lxml）。" +
          "装好后用 MD2SLIDES_PYTHON 指到那个解释器，可编辑导出即可用。",
        ok: false,
        issues: [],
        pending: [],
        notes: [],
        stderr: "",
      }
    }
    const args = [
      "build_pptx.py",
      "--ir", io.ir,
      "--out", io.out,
      "--media", io.media,
      "--report", io.report,
    ]
    // cwd 必须是 sidecar 目录：那几个脚本之间是 `from build_template import ...` 的平级 import。
    const run = spawnSync(python, args, {
      cwd: SIDECAR_DIR,
      encoding: "utf8",
      windowsHide: true,
    })
    let report = null
    try {
      report = JSON.parse(fs.readFileSync(io.report, "utf8"))
    } catch {
      report = null
    }
    return {
      skipped: false,
      ok: run.status === 0 && !!report,
      issues: report?.issues ?? [],
      pending: report?.pending ?? [],
      notes: report?.notes ?? [],
      stderr: (run.stderr ?? "").trim(),
    }
  }

  /** 位图列表 → pptxgenjs 铺满出片（图片通道的组装段，frame 无关——marktext 形态
   *  的取数在 renderer 经 postMessage 完成，出片共用这一段）。 */
  const imagesToPptx = async (urls, out, onProgress) => {
    const pptx = new PptxGen()
    pptx.defineLayout({ name: "MD2S_16x9", width: EMU_W, height: EMU_H })
    pptx.layout = "MD2S_16x9"
    for (let i = 0; i < urls.length; i++) {
      const b64 = String(urls[i]).split(",")[1] || ""
      pptx.addSlide().addImage({
        data: "image/png;base64," + b64,
        x: 0,
        y: 0,
        w: EMU_W,
        h: EMU_H,
      })
      onProgress?.("栅格", i + 1, urls.length)
    }
    onProgress?.("生成", 0, 1)
    const buffer = await pptx.write({ outputType: "nodebuffer" })
    atomicWrite(out, buffer)
    onProgress?.("生成", 1, 1)
    return urls.length
  }

  /** 图片型：逐页栅格 + pptxgenjs 铺满（零 Python，与放映逐像素一致）。 */
  const exportImage = async (frame, deckInfo, { out, onProgress }) => {
    const urls = await frame.contentWindow.deck.exportImages({
      slideWidth: deckInfo.slideWidth,
      slideHeight: deckInfo.slideHeight,
    })
    if (!urls.length) throw new ExportError("deck 里没有可导出的页（deck 渲染失败？）")
    return imagesToPptx(urls, out, onProgress)
  }

  /**
   * 数据驱动出片（marktext 形态）：取数已由宿主 renderer 完成（deck 页面经
   * postMessage 跑 ir()/exportImages()），这里只做出片。Typora 的 exportEditable
   * 内部同源复用——两条宿主路径一套出片逻辑，不会漂移。
   *
   * 大位图两条进法（M2 真机教训：数百 MB 过 postMessage→IPC 会把 Electron 挂死，
   * 故 marktext 形态的大件走服务旁路落盘，这里收目录）：
   *   images:  string[]（data URL 数组，Typora/小件直传）
   *   imagesDir: string（旁路目录，内含 page-NNNN.png，配 pages 计数）
   *   media:   数组（Typora）；mediaDir: 旁路目录（marktext，文件名即 IR 引用名）
   * @param {object} opts
   * @param {"image"|"editable"} opts.kind
   * @param {string} opts.out        目标 .pptx 路径
   * @param {string[]} [opts.images] kind=image：每页一张 PNG data URL
   * @param {string} [opts.imagesDir] kind=image：旁路目录（优先于 images）
   * @param {object}   [opts.ir]     kind=editable：Slide IR
   * @param {Array<{name:string,dataUrl:string}>} [opts.media]
   * @param {string}   [opts.mediaDir] kind=editable：media 旁路目录（优先于 media）
   * @param {string[]} [opts.issues] IR 闸门结果（非空 → IR_GATE 拒绝）
   * @param {Function} [opts.onProgress]
   */
  const exportFromData = async ({ kind, out, images, imagesDir, ir, media, mediaDir, issues, onProgress }) => {
    if (kind === "image") {
      let urls = images
      if (imagesDir) {
        // 旁路目录：文件名按 deck-full 的 page-NNNN.png 排序即页序。
        if (!fs.existsSync(imagesDir)) throw new ExportError(`旁路目录不存在：${imagesDir}`)
        urls = fs.readdirSync(imagesDir)
          .filter(f => f.endsWith(".png"))
          .sort()
          .map(f => `data:image/png;base64,${fs.readFileSync(path.join(imagesDir, f)).toString("base64")}`)
      }
      if (!Array.isArray(urls) || !urls.length) {
        throw new ExportError("没有可导出的页（deck 渲染失败？）")
      }
      return imagesToPptx(urls, out, onProgress)
    }
    if (!ir) throw new ExportError("缺少 IR（取数阶段失败？）", "NO_DECK")
    // 内容闸门：issues 非空是引擎 bug 而不是用户错（checkIr 的转传，这里防御性再守一道）。
    if (issues?.length) {
      throw new ExportError(
        "导出前内容校验未通过，已中止（请附带原文档反馈）：\n  " + issues.slice(0, 5).join("\n  "),
        "IR_GATE",
      )
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "md2slides-export-"))
    let mediaOut = path.join(workDir, "media")
    fs.mkdirSync(mediaOut, { recursive: true })
    if (mediaDir) {
      // 旁路目录：文件已按 IR 引用名落盘，直接指给 sidecar。
      if (!fs.existsSync(mediaDir)) throw new ExportError(`media 旁路目录不存在：${mediaDir}`)
      mediaOut = mediaDir
    } else {
      for (const item of media ?? []) {
        const b64 = String(item.dataUrl).split(",")[1] ?? ""
        fs.writeFileSync(path.join(mediaOut, item.name), Buffer.from(b64, "base64"))
      }
    }
    const irFile = path.join(workDir, "ir.json")
    fs.writeFileSync(irFile, JSON.stringify(ir, null, 2), "utf8")

    onProgress?.("生成", 0, 1)
    const tmp = `${out}.building.${process.pid}.tmp`
    const built = buildPptx({
      ir: irFile,
      out: tmp,
      media: mediaOut,
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

  /** 可编辑型：IR + Python sidecar（母版原生，可改字 / 换配色）。 */
  const exportEditable = async (frame, deckInfo, { out, onProgress }) => {
    onProgress?.("抽取", 0, 1)
    const { ir, issues, media } = await frame.contentWindow.deck.ir({
      slideWidth: deckInfo.slideWidth,
      slideHeight: deckInfo.slideHeight,
      theme: deckInfo.theme,
      meta: deckInfo.meta ?? null,
    })
    return exportFromData({ kind: "editable", out, ir, issues, media, onProgress })
  }

  /**
   * 统一入口：图片型 / 可编辑型二选一。
   * @param {Window} frame       放映 iframe（contentWindow）
   * @param {object} deckInfo    { slideWidth, slideHeight, theme, meta }
   * @param {object} opts
   * @param {boolean} opts.editable  true=可编辑型 / false=图片型
   * @param {string} opts.outPath    目标 .pptx 绝对路径
   * @param {Function} [opts.onProgress] (stage, done, total?) => void
   * @returns {Promise<{pages?: number, warnings?: string[]}>}
   */
  const exportPptx = async (frame, deckInfo, { editable, outPath, onProgress } = {}) => {
    if (!frame?.contentWindow?.deck) {
      throw new ExportError("放映未就绪，无法导出（先进入放映再点导出）", "NO_DECK")
    }
    return editable
      ? exportEditable(frame, deckInfo, { out: outPath, onProgress })
      : exportImage(frame, deckInfo, { out: outPath, onProgress })
  }

  return { exportPptx, buildPptx, exportFromData }
}

module.exports = { createExporter, findPython, ExportError }
