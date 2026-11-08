"use strict"

/**
 * matplotlib 渲染器单测。
 *
 * 需要一台装了 matplotlib 的 Python；没有时相关用例 skip（不是失败——CI 未必有
 * 科学栈），但**类型识别**与**结果解析**这两类不依赖解释器的断言始终跑。
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { renderMatplotlib, pythonRuntime, parseResult } = require("../../host/thin/matplotlib")
const { DIAGRAM_TYPES } = require("../../core/render/diagramHost")
const { NODE_TYPES } = require("../../host/thin")

const hasPython = (() => {
  try {
    pythonRuntime()
    return true
  } catch {
    return false
  }
})()
const needPython = t => {
  if (hasPython) return false
  t.skip("本机没有带 matplotlib 的 Python（装一个或用 PYTHON_PATH 指过去）")
  return true
}

test("core 认识 ```matplotlib 这个围栏语言", () => {
  assert.equal(DIAGRAM_TYPES.matplotlib, "matplotlib")
})

test("matplotlib 属于 Node 侧可渲染类型", () => {
  assert.ok(NODE_TYPES.includes("matplotlib"))
})

test("真出 PNG（含中文标题）", t => {
  if (needPython(t)) return
  const result = renderMatplotlib(
    [
      "import matplotlib.pyplot as plt",
      'plt.plot([1, 2, 3], [2, 1, 3], marker="o")',
      'plt.title("中文标题 · matplotlib")',
      'plt.xlabel("x 轴")',
    ].join("\n"),
  )
  assert.equal(result.png.readUInt32BE(0), 0x89504e47, "必须是 PNG 文件头")
  assert.ok(result.png.length > 1000, "不能是空白图")
  assert.ok(result.dataUrl.startsWith("data:image/png;base64,"))
  assert.ok(result.width > 100 && result.height > 100, `尺寸异常：${result.width}x${result.height}`)
})

test("没有画图的代码给出人话错误", t => {
  if (needPython(t)) return
  assert.throws(() => renderMatplotlib("x = 1 + 1\nprint(x)"), /没有产生图形/)
})

test("空块直接报错", () => {
  assert.throws(() => renderMatplotlib("   \n"), /是空的/)
})

test("用户 print 不干扰结果解析", () => {
  assert.deepEqual(parseResult('hello\n__MD2S_MATPLOTLIB__ {"ok":true,"data":"AA=="}\n'), {
    ok: true,
    data: "AA==",
  })
  assert.equal(parseResult("只有普通输出\n"), null)
})

test("解释器缺失时给出的错误可操作", { skip: hasPython }, () => {
  assert.throws(() => pythonRuntime(), /PYTHON_PATH/)
})
