"use strict"

/**
 * matplotlib.js — 薄宿主的 matplotlib 渲染器：把 ```matplotlib 围栏交给真 Python 画成 PNG。
 *
 * 与 mermaid / echarts 的根本差别：那两个是浏览器运行时，这个是 Python 库。
 * 浏览器里画不了，Node 侧只能 spawn 解释器——所以它和 graphviz / plantuml 同属
 * `NODE_TYPES`，按同一套"预通行 → 量高度 → 物理分页"的时序走。
 *
 * 出 PNG 而不是 SVG 的原因同 graphviz.js：`ir.js` 见到 IMG 直接出 image 块
 * （data URL → media 落盘 → sidecar 插图）；SVG 得先栅格，栅格失败会退化成 custom
 * 被 sidecar 整块跳过。
 *
 * 安全口径：这段代码是**文档作者自己写的**，执行它等于跑作者自己的脚本。薄宿主与
 * editor 一样把它当作显式能力，而不是默认关闭项——CLI/服务端场景由部署方决定是否
 * 提供 Python；没有解释器时**硬失败**（图必须真渲染，不接受代码块降级）。
 */

const { spawnSync } = require("child_process")
const fs = require("fs")
const path = require("path")

/** 结果标记：文档自己的 print 也走同一根管道，靠它找出真正的载荷。 */
const RESULT_PREFIX = "__MD2S_MATPLOTLIB__"

/**
 * 与文览 `main/ipc/matplotlib.ts` 的 BOOTSTRAP 同源（同一套字体与 UTF-8 处理），
 * 差别只在输出：文览要 SVG 交给编辑器，这里要 PNG 直接进 deck / PPTX；snippet
 * 注册了 matplotlib Animation 时两边都改出 GIF（Pillow 直写，帧数/体积双帽）。
 *
 * 几个必须自己兜的坑：
 *  - stdin 必须按 **bytes** 读、按 UTF-8 解：中文 Windows 的文本层会按 GBK 解，
 *    多字节字符变 mojibake，matplotlib 序列化时直接 `UnicodeEncodeError: surrogates`。
 *  - 中文字体要排到 sans-serif 最前，否则轴标签全变方块。
 *  - `np` / `plt` 预先注入命名空间：生态里的 matplotlib 片段普遍不 import 就直接用。
 */
const HARNESS = `
import base64, io, json, os, sys, tempfile, time

def read_source():
    return sys.stdin.buffer.read().decode("utf-8", errors="replace")

def emit(payload):
    sys.stdout.buffer.write(b"${RESULT_PREFIX} ")
    sys.stdout.buffer.write(json.dumps(payload).encode("utf-8", errors="replace"))
    sys.stdout.buffer.write(b"\\n")
    sys.stdout.buffer.flush()

def fail(message):
    emit({"ok": False, "error": message})
    sys.exit(0)

code = read_source()
dpi = int(sys.argv[1]) if len(sys.argv) > 1 else 192

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
except Exception as err:
    fail("matplotlib 不可用：" + str(err))

available = {f.name for f in font_manager.fontManager.ttflist}
cjk = [f for f in [
    "Microsoft YaHei", "SimHei", "PingFang SC", "Hiragino Sans GB", "Heiti SC",
    "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei",
    "Noto Sans CJK TC", "Microsoft JhengHei",
] if f in available]
if cjk:
    plt.rcParams["font.sans-serif"] = cjk + list(plt.rcParams["font.sans-serif"])
plt.rcParams["axes.unicode_minus"] = False

try:
    import numpy as np
    namespace = {"__name__": "__diagram__", "plt": plt, "np": np}
except Exception:
    namespace = {"__name__": "__diagram__", "plt": plt}

# 动画（FuncAnimation / ArtistAnimation）自己不画任何东西：走下面的静态导出只会
# 定格首帧。登记 snippet 注册的每个 Animation，把整块改写成 GIF——顺手持一份强
# 引用，没赋值的 FuncAnimation(...) 不会再被垃圾回收掉（这是官方文档都要提的坑）。
GIF_MAX_FRAMES = 200
# 慢动画需要的帧数远少于快动画：20ms 的 snippet 200 帧合适，1s 的闪烁 24 帧就读得
# 完，而 3D figure 每帧重投影要半秒。帧帽随 interval 走，让 frames=None 的闪烁落在
# ~20 秒循环上，别烧穿渲染预算。
GIF_TARGET_LOOP_MS = 20000
# 第二道闸：单帧渲染慢时不能把 save 拖过宿主超时（本侧 60s），抓帧超预算即截断。
GIF_TIME_BUDGET_S = 45
GIF_MAX_BYTES = 8 * 1024 * 1024
ANIMATIONS = []
try:
    import matplotlib.animation as _anim

    _orig_anim_init = _anim.Animation.__init__

    def _record_anim_init(self, fig, *args, **kwargs):
        ANIMATIONS.append((self, fig))
        return _orig_anim_init(self, fig, *args, **kwargs)

    _anim.Animation.__init__ = _record_anim_init
except Exception:
    pass

try:
    exec(compile(code, "<matplotlib>", "exec"), namespace)
except Exception as err:
    fail(type(err).__name__ + ": " + str(err))

if ANIMATIONS:
    ani, anim_fig = ANIMATIONS[-1]
    interval = getattr(ani, "_interval", None) or 200
    # 1s-间隔的闪烁要按 1s 播，fps 下限放宽到 1（GIF 延迟是 10ms 整数倍，1fps=100cs）。
    fps = max(1, min(50, int(round(1000.0 / float(interval)))))
    frame_cap = max(24, min(GIF_MAX_FRAMES, int(round(GIF_TARGET_LOOP_MS / float(interval)))))
    base_dpi = float(getattr(anim_fig, "dpi", None) or 100)

    if not hasattr(_anim, "PillowWriter"):
        fail("matplotlib 版本太旧（< 3.2），缺 PillowWriter，画不了动画")

    class _GifFrameCap(Exception):
        pass

    class _CappedPillowWriter(_anim.PillowWriter):
        # 双闸防病态帧源：frames=None 是 itertools.count 无限帧（帧帽），单帧
        # 渲染慢则不能拖过宿主超时（时间帽）。
        def __init__(self, fps, cap):
            super().__init__(fps=fps)
            self._mt_cap = cap
            self._mt_count = 0
            self._mt_start = None

        def grab_frame(self, **kwargs):
            now = time.monotonic()
            if self._mt_start is None:
                self._mt_start = now
            self._mt_count += 1
            if self._mt_count > self._mt_cap or now - self._mt_start > GIF_TIME_BUDGET_S:
                raise _GifFrameCap()
            return super().grab_frame(**kwargs)

    def write_gif(scale):
        writer = _CappedPillowWriter(fps=fps, cap=frame_cap)
        try:
            ani.save(tmp_path, writer=writer, dpi=base_dpi * scale)
        except _GifFrameCap:
            # MovieWriter.saving 在 finally 里跑 finish()，所以盘上的文件已经
            # 是装着已画帧的合法 GIF。
            pass
        with open(tmp_path, "rb") as handle:
            return handle.read()

    tmp = tempfile.NamedTemporaryFile(suffix=".gif", delete=False)
    tmp.close()
    tmp_path = tmp.name
    try:
        try:
            gif = write_gif(1.0)
            if len(gif) > GIF_MAX_BYTES:
                gif = write_gif(0.6)
                if len(gif) > GIF_MAX_BYTES:
                    fail("动画 GIF 超出大小上限——减少帧数或缩小 figure 再试")
        except Exception as err:
            fail("动画序列化失败：" + str(err))

        emit({
            "ok": True,
            "mime": "image/gif",
            "data": base64.b64encode(gif).decode("ascii")
        })
        sys.exit(0)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

figures = [plt.figure(n) for n in plt.get_fignums()]
if not figures:
    fail("代码没有产生图形——用 matplotlib.pyplot 画一张（plt.plot / plt.bar / ...）再导出")

buffer = io.BytesIO()
try:
    # 与「文」视图所见一致：一个块只出一张图，取块结束时的第一张。
    # 多 figure 的块在 deck 里本就无处安放第二张，静默截断比塞半页更可预期。
    figures[0].savefig(buffer, format="png", dpi=dpi, bbox_inches="tight", facecolor="white")
except Exception as err:
    fail("图形序列化失败：" + str(err))

emit({
    "ok": True,
    "mime": "image/png",
    "data": base64.b64encode(buffer.getvalue()).decode("ascii")
})
`

/** PNG 头里的宽高（IHDR）；拿不到就返回 null，交给浏览器按图片自身尺寸排。 */
const pngSize = buf => {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** GIF 头（GIF87a/GIF89a）里的宽高（逻辑屏幕描述符，小端）；同上拿不到返 null。 */
const gifSize = buf => {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null
  const header = buf.toString("latin1", 0, 6)
  if (header !== "GIF87a" && header !== "GIF89a") return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/** 魔数认 mime：动图块回 GIF，静态块回 PNG，别的都不收。 */
const sniffMime = buf => {
  if (!Buffer.isBuffer(buf) || buf.length < 6) return null
  const header = buf.toString("latin1", 0, 6)
  if (header === "GIF87a" || header === "GIF89a") return "image/gif"
  if (buf.readUInt32BE(0) === 0x89504e47) return "image/png"
  return null
}

/**
 * 解释器候选：`PYTHON_PATH` > 常见 conda / 官方安装路径 > PATH。
 *
 * 不能只靠 `python`：Windows 的 PATH 里常有 Microsoft Store 的占位 stub，
 * 一跑就弹商店；而带 matplotlib 的通常是 Anaconda。
 */
const pythonCandidates = () => {
  const out = []
  if (process.env.PYTHON_PATH) out.push(process.env.PYTHON_PATH)
  if (process.env.CONDA_PREFIX) {
    out.push(path.join(process.env.CONDA_PREFIX, process.platform === "win32" ? "python.exe" : "bin/python3"))
  }

  if (process.platform === "win32") {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
    const localAppData = process.env.LOCALAPPDATA ?? ""
    const drives = [process.env.SystemDrive ?? "C:", "C:", "D:", "E:"]
    const roots = [
      ...drives.map(d => `${d}\\ProgramData`),
      ...drives.map(d => `${d}\\`),
      home,
      localAppData,
      localAppData && path.join(localAppData, "Programs", "Python"),
    ].filter(Boolean)
    for (const root of roots) {
      const direct = path.join(root, "python.exe")
      if (fs.existsSync(direct)) out.push(direct)
      for (const distro of ["anaconda3", "miniconda3", "miniforge3", "mambaforge"]) {
        const exe = path.join(root, distro, "python.exe")
        if (fs.existsSync(exe)) out.push(exe)
      }
    }
  } else {
    const home = process.env.HOME ?? ""
    for (const base of ["/opt", home, "/usr/local", "/opt/conda"]) {
      for (const distro of ["anaconda3", "miniconda3", "miniforge3"]) {
        const exe = path.join(base, distro, "bin", "python3")
        if (fs.existsSync(exe)) out.push(exe)
      }
    }
  }

  out.push(process.platform === "win32" ? "python" : "python3", "python")
  return [...new Set(out)]
}

/** 解释器与它的固定参数（`py -3` 这种要拆开，路径带空格则整体是一个参数）。 */
const parseCommand = value => {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) return null
  if (fs.existsSync(trimmed)) return { command: trimmed, args: [] }
  const [command, ...args] = trimmed.split(/\s+/)
  return command ? { command, args } : null
}

const utf8Env = () => ({ ...process.env, PYTHONUTF8: "1" })

/** 能不能真的 `import matplotlib`——只启动不算数。 */
const canDraw = candidate => {
  const res = spawnSync(candidate.command, [...candidate.args, "-c", "import matplotlib"], {
    windowsHide: true,
    env: utf8Env(),
    timeout: 30000,
  })
  return !res.error && res.status === 0
}

let cachedInterpreter

/**
 * 找一个带 matplotlib 的解释器（结果缓存：首次 import 会建字体缓存，可能要几秒）。
 * @returns {{command: string, args: string[]}}
 * @throws {Error} 一个都没有 —— 硬失败，并在信息里给出可操作的下一步
 */
const pythonRuntime = () => {
  if (cachedInterpreter !== undefined) {
    if (cachedInterpreter) return cachedInterpreter
    throw noPythonError()
  }
  const tried = []
  for (const raw of pythonCandidates()) {
    const candidate = parseCommand(raw)
    if (!candidate) continue
    try {
      if (canDraw(candidate)) {
        cachedInterpreter = candidate
        return candidate
      }
      tried.push(`${[candidate.command, ...candidate.args].join(" ")}（没有 matplotlib）`)
    } catch (error) {
      tried.push(`${candidate.command}: ${error.message}`)
    }
  }
  cachedInterpreter = null
  const error = noPythonError(tried)
  throw error
}

const noPythonError = tried => {
  const detail = tried?.length ? `；试过 ${tried.join("、")}` : ""
  return new Error(
    `找不到带 matplotlib 的 Python${detail}。` +
      `装一个（\`pip install matplotlib\`），或用 PYTHON_PATH 指到解释器（如 Anaconda 的 python.exe）`,
  )
}

/** 从混着用户 print 的 stdout 里取出标记行。 */
const parseResult = stdout => {
  const marker = `${RESULT_PREFIX} `
  const line = String(stdout)
    .split("\n")
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith(marker))
    .pop()
  if (!line) return null
  try {
    return JSON.parse(line.slice(marker.length))
  } catch {
    return null
  }
}

/**
 * @param {string} source matplotlib 源码（围栏内容，不含 ``` 行）
 * @param {object} [opts]
 * @param {number} [opts.dpi=192]  输出分辨率（与 graphviz 的 192 同口径）
 * @param {number} [opts.timeout=60000] 单块执行上限（毫秒）
 * @returns {{ mime: string, bitmap: Buffer, dataUrl: string, width?: number, height?: number }}
 *   动画块 mime=image/gif，静态块 image/png；width/height 解析自图片头
 * @throws {Error} 没解释器 / 执行出错 / 没画图 / 没吐位图 —— 一律硬失败，不降级
 */
const renderMatplotlib = (source, opts = {}) => {
  const text = String(source ?? "")
  if (!text.trim()) throw new Error("matplotlib 块是空的")

  const interpreter = pythonRuntime()
  const dpi = String(opts.dpi ?? 192)
  const res = spawnSync(interpreter.command, [...interpreter.args, "-c", HARNESS, dpi], {
    input: Buffer.from(text, "utf8"),
    env: utf8Env(),
    windowsHide: true,
    // 首次 import matplotlib 会建字体缓存，慢是正常的；超时仍要硬失败。
    timeout: opts.timeout ?? 60000,
    maxBuffer: 64 * 1024 * 1024,
  })

  if (res.error) {
    if (res.error.code === "ETIMEDOUT") {
      throw new Error(`matplotlib 渲染超时（${(opts.timeout ?? 60000) / 1000}s）`)
    }
    throw new Error(`跑不动 Python（${interpreter.command}）：${res.error.message}`)
  }

  const parsed = parseResult(res.stdout)
  if (!parsed) {
    throw new Error(
      `Python 没返回结果（退出码 ${res.status}）：${String(res.stderr ?? "").trim().slice(-400) || "无 stderr"}`,
    )
  }
  if (!parsed.ok) throw new Error(parsed.error || "matplotlib 渲染失败")

  const bitmap = Buffer.from(String(parsed.data ?? ""), "base64")
  const mime = sniffMime(bitmap)
  if (!bitmap.length || !mime) {
    throw new Error("matplotlib 没吐出位图（既不是 PNG 也不是 GIF 文件头）")
  }
  const size = (mime === "image/gif" ? gifSize(bitmap) : pngSize(bitmap)) ?? {}
  return {
    mime,
    bitmap,
    dataUrl: `data:${mime};base64,${bitmap.toString("base64")}`,
    width: size.width,
    height: size.height,
  }
}

module.exports = {
  renderMatplotlib,
  pythonRuntime,
  pythonCandidates,
  parseResult,
  pngSize,
  gifSize,
}
