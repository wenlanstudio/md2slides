"use strict"

/**
 * python.js — 挑一个真能跑 sidecar 的 Python。
 *
 * 光有 `python` 不够：sidecar 要 `python-pptx`（连带 lxml），而 PATH 里那个解释器
 * 常常是个干净环境，一 import 就 ModuleNotFoundError。所以判据是**能 import pptx**，
 * 不是"能否启动"。
 */

const { spawnSync } = require("child_process")

const CANDIDATES = [
  process.env.MD2SLIDES_PYTHON,
  process.env.PYTHON,
  "python",
  "python3",
  // Windows 上 Anaconda 的常见位置，放在最后当兜底
  "D:/ProgramData/anaconda3/python.exe",
  "C:/ProgramData/anaconda3/python.exe",
]

let cached = null

/** 能 import pptx 才算数——缺 lxml 的干净环境会在 sidecar 里当场炸。 */
const canRun = cmd => {
  try {
    const r = spawnSync(cmd, ["-c", "import pptx"], { encoding: "utf8", windowsHide: true })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * @returns {string|null} 可用的解释器，一个都找不到就是 null
 */
const findPython = () => {
  if (cached !== null) return cached
  cached = CANDIDATES.filter(Boolean).find(canRun) ?? null
  return cached
}

module.exports = { findPython, CANDIDATES }
