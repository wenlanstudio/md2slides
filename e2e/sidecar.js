"use strict"

/**
 * sidecar.js — 调 Python 那一侧把 IR 变成真的 .pptx。
 *
 * e2e 验到"IR 抽对了"还不算完：IR 只是内容契约，成品是 PPTX。sidecar 自带
 * `verify()`（逐页拿 IR 文本比对成品文本，并把 custom/unknown 记成待办），
 * 这里负责在 Node 侧驱动它，把 `issues` / `pending` 带回来交给断言。
 *
 * 一条命令搞定（`build_pptx.py --ir --out --media --report`），不用自己拼
 * 三条：bin/ 那三个脚本的先后依赖它自己管。
 */

const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const { findPython } = require("./python")

const SIDECAR_DIR = path.resolve(__dirname, "../export/pptx/sidecar")
const DUMP = path.join(__dirname, "dump_pptx.py")

/**
 * 把成品 PPTX 的几何读回来：每个形状的尺寸与位置，以及有没有冲出画布。
 *
 * @param {string} pptxPath 成品路径（绝对）
 * @returns {{ skipped: boolean, reason?: string, ok: boolean,
 *             canvas: object, slides: Array, issues: string[] }}
 */
const inspectPptx = pptxPath => {
  const python = findPython()
  if (!python) {
    return { skipped: true, reason: "没有可用的 Python", ok: false, canvas: null, slides: [], issues: [] }
  }

  const run = spawnSync(python, [DUMP, pptxPath], { encoding: "utf8", windowsHide: true })
  let data = null
  try {
    data = JSON.parse(run.stdout)
  } catch {
    data = null
  }
  if (!data) {
    return {
      skipped: false,
      ok: false,
      canvas: null,
      slides: [],
      issues: [`读不回成品几何：${(run.stderr ?? "").trim() || run.stdout.slice(0, 200)}`],
    }
  }

  // 逐页的 issues 摊平成一维，断言好直接用。
  return {
    skipped: false,
    ok: true,
    canvas: data.canvas,
    slides: data.slides,
    issues: data.slides.flatMap(s => s.issues),
  }
}

/**
 * @param {object} io
 * @param {string} io.ir      IR JSON 路径（绝对）
 * @param {string} io.out     输出 pptx（绝对）
 * @param {string} io.media   图片目录（绝对）
 * @param {string} io.report  sidecar 报告输出路径（绝对）
 * @returns {{ skipped: boolean, reason?: string, ok: boolean, issues: string[],
 *             pending: string[], notes: string[], stderr: string, command: string }}
 */
const buildPptx = io => {
  const python = findPython()
  if (!python) {
    return {
      skipped: true,
      reason:
        "找不到能 import pptx 的 Python（sidecar 要 python-pptx + lxml）。" +
        "装好后用 MD2SLIDES_PYTHON 指到那个解释器。",
      ok: false,
      issues: [],
      pending: [],
      notes: [],
      stderr: "",
      command: "",
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
    command: `${python} ${args.join(" ")}`,
  }
}

module.exports = { buildPptx, inspectPptx, SIDECAR_DIR }
