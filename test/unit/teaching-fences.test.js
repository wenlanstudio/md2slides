"use strict"

// teaching-fences 接入渲染管线的防泄题回归（M1.5 核心验收的机器面）。
// 「预览什么样，导出就什么样」在泄题上同样成立：token 层删一处，
// HTML / IR / PPTX 三条下游全干净。PPTX 是 IR 的忠实翻译（e2e 有逐页等价
// 校验锁着），IR 级断言即代表导出产物级；真机抽验（文览解冻后）走人工。

const test = require("node:test")
const assert = require("node:assert/strict")
const { JSDOM } = require("jsdom")

const { renderMarkdown } = require("../../core/parse/markdown")
const { compose } = require("../../core/compose")
const { registerFencePolicy } = require("../../core/parse/fencePolicy")
const { FENCE_ACTIONS } = require("../../core/teaching-fences")

const SECRET = [
  "REF_CODE_SECRET_MARKER",
  "EXPECTED_OUTPUT_SECRET_MARKER",
  "SQL_RESULT_SECRET_MARKER",
]

const LECTURE = [
  "# 讲义",
  "",
  "<!--quiz id=q1 answer=B-->",
  "1 + 1 = ?",
  "",
  "- 1",
  "- 2",
  "",
  "```check-code path=src/Main.java mode=loose",
  "REF_CODE_SECRET_MARKER",
  "```",
  "",
  "```match-output run=java stdin=data/in.txt",
  "EXPECTED_OUTPUT_SECRET_MARKER",
  "```",
  "",
  "```sql-result db=course",
  "SQL_RESULT_SECRET_MARKER",
  "```",
  "",
  "```java",
  "NORMAL_CODE_KEEP_MARKER",
  "```",
  "",
  "```csv file=data/in.txt",
  "FILE_BLOCK_KEEP_MARKER",
  "```",
  "",
  "结尾普通段落。",
  "",
].join("\n")

test("教学载荷围栏不进 HTML（普通代码块与 file= 数据块保留）", () => {
  const html = renderMarkdown(LECTURE)
  for (const marker of SECRET) {
    assert.ok(!html.includes(marker), `载荷泄漏进 HTML：${marker}`)
  }
  assert.ok(!html.includes("check-code"), "动词名也不该出现")
  assert.ok(html.includes("NORMAL_CODE_KEEP_MARKER"), "普通代码块必须保留")
  assert.ok(html.includes("FILE_BLOCK_KEEP_MARKER"), "file= 数据块必须保留（学生要做题）")
  assert.ok(html.includes("data-md2s-quiz"), "quiz 链路不受影响")
})

test("教学载荷围栏不进渲染 DOM（分页/导出都从这个 DOM 出发）", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>")
  const doc = dom.window.document
  const deck = compose(LECTURE, { document: doc })
  doc.body.innerHTML = deck.html
  const text = doc.body.textContent
  for (const marker of SECRET) {
    assert.ok(!text.includes(marker), `载荷泄漏进渲染 DOM：${marker}`)
  }
  assert.ok(text.includes("NORMAL_CODE_KEEP_MARKER"), "渲染 DOM 保留普通代码块")
  // IR / PPTX 逐页提取自这个 DOM（且需真实布局），忠实性由 npm test 的
  // 浏览器回归 + IR 等价校验兜底——这里锁住源头即可。
})

test("围栏策略钩子是通用的：宿主可注入自定义动词", () => {
  const MarkdownIt = require("../../lib/markdown-it")
  const instance = new MarkdownIt({ html: true })
  registerFencePolicy(instance, { ...FENCE_ACTIONS, "secret-x": "hide" })
  const html = instance.render("```secret-x\nMY_CUSTOM_SECRET\n```\n\n```java\nKEEP_ME\n```")
  assert.ok(!html.includes("MY_CUSTOM_SECRET"), "自定义 hide 动词生效")
  assert.ok(html.includes("KEEP_ME"), "表外动词不受影响")
})
