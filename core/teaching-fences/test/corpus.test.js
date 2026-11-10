"use strict"

/**
 * corpus.test.js — 一致性语料回归（本包的验收基线）。
 *
 * 每个用例是一对文件：cases/<name>.md（输入讲义片段）+ <name>.json（期望）。
 * 期望只写关心的字段（投影比较）——语料是给 md2slides / muya 接入时**共用**的
 * （README「开发」一节），写全量输出会让两侧实现被迫在同构细节上对齐，
 * 写子集只锁行为契约。新动词/新校验 = 加用例，三样同步（verbs.js 头注）。
 */

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const { scan } = require("../index.js")

const CASES_DIR = path.join(__dirname, "..", "corpus", "cases")

/** 从 scan 结果里按期望的键提取同名子集，做投影比较。 */
function pick(actual, expected) {
  const out = {}
  for (const key of Object.keys(expected)) out[key] = actual[key]
  return out
}

function projectQuiz(q, expected) {
  const full = {
    id: q.id,
    type: q.type,
    answer: q.answer,
    point: q.point,
    limit: q.limit,
    shuffle: q.shuffle,
    stem: q.stem,
    options: q.options.map(o => o.text),
    // 双轨来源与围栏行区间：期望里写了才比较（旧语料不涉及载体差异）
    source: q.source,
    lineStart: q.lineStart,
    lineEnd: q.lineEnd,
  }
  return pick(full, expected)
}

function projectResult(result, expected, name) {
  const projection = {}
  if (expected.quizzes) {
    projection.quizzes = zip(result.quizzes, expected.quizzes, name, "quizzes")
      .map(([q, exp]) => projectQuiz(q, exp))
  }
  if (expected.steps) {
    projection.steps = zip(result.steps, expected.steps, name, "steps")
      .map(([s, exp]) => pick({ id: s.id, name: s.name, point: s.point, asserts: s.asserts.length }, exp))
  }
  if (expected.fills) {
    projection.fills = zip(result.fills, expected.fills, name, "fills")
      .map(([f, exp]) => pick({ id: f.id, min: f.min, max: f.max }, exp))
  }
  if (expected.fences) {
    projection.fences = zip(result.fences, expected.fences, name, "fences")
      .map(([f, exp]) => pick({ verb: f.verb, lineStart: f.lineStart }, exp))
  }
  if (expected.problems) {
    projection.problems = zip(result.problems, expected.problems, name, "problems")
      .map(([p, exp]) => pick({ code: p.code, line: p.line, verb: p.verb }, exp))
  }
  if (expected.warnings) {
    projection.warnings = zip(result.warnings, expected.warnings, name, "warnings")
      .map(([w, exp]) => pick({ code: w.code, line: w.line }, exp))
  }
  return projection
}

/** 逐项配对；条数不符先报——错误定位到用例与字段，而不是深比较里猜。 */
function zip(actualList, expectedList, name, field) {
  assert.equal(
    actualList.length, expectedList.length,
    `${name} .${field} 条数不符：实际 ${actualList.length}，期望 ${expectedList.length}\n` +
    `实际：${JSON.stringify(actualList, null, 1)}`,
  )
  return actualList.map((item, i) => [item, expectedList[i]])
}

for (const file of fs.readdirSync(CASES_DIR).filter(f => f.endsWith(".md"))) {
  const name = path.basename(file, ".md")
  test(`corpus: ${name}`, () => {
    const md = fs.readFileSync(path.join(CASES_DIR, file), "utf8")
    const expected = JSON.parse(fs.readFileSync(path.join(CASES_DIR, `${name}.json`), "utf8"))
    const opts = expected.options ?? {}
    const result = scan(md, { requireIds: !!opts.requireIds })

    const actual = projectResult(result, expected, name)
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (key === "options") continue
      assert.deepStrictEqual(actual[key], expectedValue, `${name} .${key} 不符`)
    }
  })
}

test("corpus 目录里每个 .md 都有配对的期望 .json", () => {
  const files = fs.readdirSync(CASES_DIR)
  const mdFiles = files.filter(f => f.endsWith(".md"))
  for (const f of mdFiles) {
    assert.ok(files.includes(`${f.slice(0, -3)}.json`), `${f} 缺期望文件`)
  }
  assert.ok(mdFiles.length >= 10, `语料应有 ≥10 个用例，现在只有 ${mdFiles.length}`)
})
