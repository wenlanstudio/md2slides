"use strict"

/**
 * quiz-fence.test.js — 双轨题目语法在渲染侧的全链回归（2026-11-10）。
 *
 * 锁住四件事：题面围栏不会变成 <pre>；块体的 Markdown 与 KaTeX 公式真的渲染；
 * 两种载体在同一份讲义里归一成同样的题目卡；载荷围栏的默认 hide 不误伤题面。
 * 题干/选项仍是普通 <p>/<li>，所以分页、IR、PPTX、classbuzz 宿主零改动复用。
 */

const test = require("node:test")
const assert = require("node:assert/strict")
const { JSDOM } = require("jsdom")

const { renderMarkdown } = require("../../core/parse/markdown")
const { readQuizzes } = require("../../core/quiz/parse")
const { FENCE_ACTIONS } = require("../../core/teaching-fences")

const FENCE_MD = [
  "# 双轨讲义",
  "",
  "```quiz id=qf1 answer=B point=3",
  "求 $\\sum_{i=1}^n i$ 的值？（**n 为正整数**）",
  "",
  "- A. $n(n+1)$",
  "- B. $n(n+1)/2$",
  "- C. $n^2$",
  "```",
  "",
  "<!--quiz id=qc1 answer=A-->",
  "注释族题目仍在",
  "",
  "- 甲",
  "- 乙",
  "",
  "```check-code path=a.py",
  "SECRET_PAYLOAD_MARKER",
  "```",
  "",
  "```java",
  "System.out.println(1);",
  "```",
  "",
  "结尾正文。",
  "",
].join("\n")

const domOf = html => {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  return dom.window.document
}

test("```quiz 不渲染成代码块，题干与选项挂上题目卡属性", () => {
  const html = renderMarkdown(FENCE_MD)
  assert.ok(!html.includes("&lt;!--quiz"), "围栏体不能被当成字面代码")
  assert.ok(!/<pre[^>]*>\s*<code[^>]*>\s*求/.test(html), "题面不能落进 <pre><code>")
  assert.match(html, /<p[^>]*data-md2s-quiz="qf1"[^>]*>/)
  assert.match(html, /<ul[^>]*data-md2s-quiz-options="qf1"[^>]*>/)
  const stem = domOf(html).querySelector('[data-md2s-quiz="qf1"]')
  const meta = JSON.parse(stem.getAttribute("data-md2s-quiz-meta"))
  assert.equal(meta.answer, 1, "answer=B 归一成 0 基序号 1")
  assert.equal(meta.id, "qf1")
  assert.equal(meta.limit, 30)
})

test("块体走同一套 Markdown / KaTeX：公式、加粗、行内代码都渲染，且不重复", () => {
  const html = renderMarkdown(FENCE_MD)
  // 题干 1 个 + 选项 3 个 = 4 个行内公式；重复渲染会变成 8 个
  assert.equal((html.match(/class="katex"/g) || []).length, 4)
  assert.ok(html.includes("<strong>n 为正整数</strong>"), "加粗生效")
  const stem = domOf(html).querySelector('[data-md2s-quiz="qf1"]')
  assert.equal((stem.textContent.match(/求/g) || []).length, 1, "题干文字不能渲染两遍")
  const items = [...domOf(html).querySelectorAll('[data-md2s-quiz-options="qf1"] > li')]
  assert.equal(items.length, 3)
  for (const li of items) {
    assert.equal((li.textContent.match(/A\.|B\.|C\./g) || []).length, 1, "选项文字不能渲染两遍")
  }
})

test("双轨并存：readQuizzes 同时读出围栏题与注释题", () => {
  const doc = domOf(renderMarkdown(FENCE_MD))
  const quizzes = readQuizzes(doc)
  assert.deepEqual(quizzes.map(q => q.qid), ["qf1", "qc1"])
  assert.deepEqual(quizzes[0].options, [
    "A. $n(n+1)$", "B. $n(n+1)/2$", "C. $n^2$",
  ], "KaTeX 的三份副本要还原成作者写的 TeX")
  assert.match(quizzes[0].stem, /求 \$\\sum_\{i=1\}\^n i\$ 的值？/)
  assert.equal(quizzes[0].answer, 1)
  assert.deepEqual(quizzes[1].options, ["甲", "乙"])
  assert.equal(quizzes[1].answer, 0)
})

test("围栏体的 data-src-* 指回原文行号（点击放映页跳源码不跳错）", () => {
  const html = renderMarkdown(FENCE_MD)
  assert.match(html, /<p[^>]*data-md2s-quiz="qf1"[^>]*data-src-start="4"/)
  assert.match(html, /<ul[^>]*data-md2s-quiz-options="qf1"[^>]*data-src-start="6"/)
})

test("题面围栏不是载荷：默认不 hide，载荷与普通代码块各守其位", () => {
  assert.notEqual(FENCE_ACTIONS.quiz, "hide")
  const html = renderMarkdown(FENCE_MD)
  assert.ok(html.includes("求"), "题面必须完整进产物")
  assert.ok(!html.includes("SECRET_PAYLOAD_MARKER"), "载荷仍默认 hide")
  assert.ok(!html.includes("check-code"), "载荷动词也不该出现")
  assert.ok(html.includes("System.out.println(1);"), "普通代码块保留")
  assert.ok(html.includes("结尾正文。"))
})

test("参数读不出的 ```quiz 原样渲染成代码块（不静默吞笔误）", () => {
  const html = renderMarkdown([
    "```quiz 这不是参数也不是 JSON",
    "题干？",
    "```",
    "",
  ].join("\n"))
  assert.ok(html.includes("<pre"), "坏围栏应留作可见代码块")
  assert.ok(!html.includes("data-md2s-quiz"), "无效题不挂题目卡属性")
})

test("围栏边界确定：题后内容不被吃掉，后面的注释题与代码块照常渲染", () => {
  const html = renderMarkdown(FENCE_MD)
  assert.equal((html.match(/data-md2s-quiz=/g) || []).length, 2, "两道题都在")
  assert.ok(html.includes("注释族题目仍在"))
  assert.ok(html.includes("System.out.println(1);"))
  assert.ok(!html.includes("&lt;!--quiz"), "闭合行没把后续内容吞成字面代码")
  assert.ok(html.includes("结尾正文。"))
})

test("multi / fill 题型在围栏里同样归一", () => {
  const html = renderMarkdown([
    '```quiz id=qm1 type=multi answer=AC',
    "选出偶数",
    "",
    "- A. 2",
    "- B. 3",
    "- C. 4",
    "```",
    "",
  ].join("\n"))
  assert.match(html, /data-md2s-quiz="qm1"/)
  // 放映抢答链目前只吃单选（TEACHING-SPEC §八 M2a），multi 的 answer 由
  // 平台发题链从 scan() 取；这里只锁题面正常渲染、不炸管线。
  assert.ok(html.includes("选出偶数"))
})

test("缺 id 的题（双轨）由 scan 内容寻址赋 id，DOM 与 scan 同源（ADR-26）", () => {
  const md = [
    "<!--quiz answer=B limit=20-->",
    "没有 id 的注释题",
    "",
    "- 甲",
    "- 乙",
    "",
    "```quiz answer=A",
    "没有 id 的围栏题",
    "",
    "- 一",
    "- 二",
    "```",
    "",
  ].join("\n")
  const { scan } = require("../../core/teaching-fences")
  const scanned = scan(md).quizzes
  const doc = domOf(renderMarkdown(md))
  const quizzes = readQuizzes(doc)
  assert.deepEqual(
    quizzes.map(q => q.qid),
    scanned.map(q => q.id),
    "DOM 上的题号必须与 scan 的 id 逐题相等（deck 发题链的映射前提）",
  )
  assert.ok(scanned.every(q => q.autoId), "两道题都应标记为内容寻址 id")
  assert.notEqual(scanned[0].id, scanned[1].id, "不同题面 → 不同 id")
  assert.match(scanned[0].id, /^q-[0-9a-f]{12}$/)
  assert.equal(quizzes[0].limitSec, 20, "limit 元数据随 scan 透传")
})

test("围栏体内嵌的 quiz 标记不再是题（与 scan 同口径，防预览/判分漂移）", () => {
  const md = [
    "```quiz id=outer answer=A",
    "外围栏题干",
    "",
    "- 一",
    "- 二",
    "",
    "内嵌示例：<!--quiz answer=B--> 不是题",
    "",
    "- 甲",
    "- 乙",
    "```",
  ].join("\n")
  const { scan } = require("../../core/teaching-fences")
  assert.equal(scan(md).quizzes.length, 1, "scan 只认围栏题本身")
  const quizzes = readQuizzes(domOf(renderMarkdown(md)))
  assert.deepEqual(quizzes.map(q => q.qid), ["outer"], "渲染侧同样只出 outer 一题")
})
