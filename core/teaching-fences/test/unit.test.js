"use strict"

/**
 * unit.test.js — 原语级单元测试：语料锁「文档级行为」，这里锁「原语级约定」。
 * 两层分开：原语的边界条件（参数变体、前缀变体）在语料里写会稀释可读性。
 */

const { test } = require("node:test")
const assert = require("node:assert/strict")

const {
  parseParams,
  parseCommand,
  parseFenceInfo,
  stripOptionPrefix,
  hasPositionDependency,
  normalizeAnswer,
  COMMAND_VERBS,
  FENCE_VERBS,
} = require("../index.js")

// ---- parseParams：双形式（SPEC §一.2）----

test("parseParams: JSON 完整版（键小写、值转字符串）", () => {
  assert.deepStrictEqual(parseParams('{"ID":"a","Point":7}'), { id: "a", point: "7" })
})

test("parseParams: kv 简写（带引号/不带引号）", () => {
  assert.deepStrictEqual(parseParams('id=q1 name="编写 Mapper" point=7'), {
    id: "q1",
    name: "编写 Mapper",
    point: "7",
  })
})

test("parseParams: 空 → 空对象；读不出 → null（原样保留标记）", () => {
  assert.deepStrictEqual(parseParams(""), {})
  assert.deepStrictEqual(parseParams(",,, "), null)
  assert.deepStrictEqual(parseParams("没有参数形式的东西"), null)
})

// ---- parseCommand / parseFenceInfo ----

test("parseCommand: 独占一行识别，缩进 ≤3 空格", () => {
  assert.deepStrictEqual(parseCommand("<!--quiz id=q1-->"), { verb: "quiz", paramsRaw: " id=q1" })
  assert.deepStrictEqual(parseCommand("   <!--step id=s1-->"), { verb: "step", paramsRaw: " id=s1" })
  assert.strictEqual(parseCommand("文本 <!--quiz--> 行内不算"), null)
  assert.deepStrictEqual(parseCommand("<!--todo-->"), { verb: "todo", paramsRaw: "" })
})

test("parseFenceInfo: 首词动词 + 参数体；空 info → null", () => {
  assert.deepStrictEqual(parseFenceInfo("check-code path=a.java mode=loose"), {
    verb: "check-code",
    params: { path: "a.java", mode: "loose" },
  })
  assert.deepStrictEqual(parseFenceInfo("match-output"), { verb: "match-output", params: {} })
  assert.strictEqual(parseFenceInfo(""), null)
  assert.strictEqual(parseFenceInfo("   "), null)
})

// ---- normalizeAnswer：0 基归一（承 md2slides 惯例）----

test("normalizeAnswer: single 字母/序号 → 0 基", () => {
  assert.strictEqual(normalizeAnswer("B"), 1)
  assert.strictEqual(normalizeAnswer("a"), 0)
  assert.strictEqual(normalizeAnswer("2"), 2)
  assert.strictEqual(normalizeAnswer(1), 1)
  assert.strictEqual(normalizeAnswer("Z"), null)
  assert.strictEqual(normalizeAnswer("-1"), null)
})

test("normalizeAnswer: multi 字母串 → 序号数组（顺序无关输入）", () => {
  assert.deepStrictEqual(normalizeAnswer("AC", "multi"), [0, 2])
  assert.deepStrictEqual(normalizeAnswer("ca", "multi"), [2, 0])
  assert.strictEqual(normalizeAnswer("AZ", "multi"), null)
})

test("normalizeAnswer: fill 保文本、essay 可省", () => {
  assert.strictEqual(normalizeAnswer("  fs.defaultFS  ", "fill"), "fs.defaultFS")
  assert.strictEqual(normalizeAnswer(null, "essay"), null)
  assert.strictEqual(normalizeAnswer("参考要点", "essay"), "参考要点")
})

// ---- stripOptionPrefix / hasPositionDependency（SPEC §2.2/§2.4）----

test("stripOptionPrefix: 四种手写前缀都剥，前缀单独一行不剥", () => {
  assert.deepStrictEqual(stripOptionPrefix("A. 数据存在内存"), { text: "数据存在内存", letter: "A" })
  assert.deepStrictEqual(stripOptionPrefix("b、内存"), { text: "内存", letter: "B" })
  assert.deepStrictEqual(stripOptionPrefix("(C) 云上"), { text: "云上", letter: "C" })
  assert.deepStrictEqual(stripOptionPrefix("d）磁盘"), { text: "磁盘", letter: "D" })
  assert.deepStrictEqual(stripOptionPrefix("没有前缀的选项"), { text: "没有前缀的选项", letter: null })
  // 「A.」后面没字：当普通选项文字（可能是笔误，交给发布门），不剥
  assert.deepStrictEqual(stripOptionPrefix("A."), { text: "A.", letter: null })
})

test("hasPositionDependency: 信号词与字母引用", () => {
  assert.strictEqual(hasPositionDependency(["甲对", "乙对", "以上都对"]), true)
  assert.strictEqual(hasPositionDependency(["甲", "乙", "都不对"]), true)
  assert.strictEqual(hasPositionDependency(["A 和 B 都对", "丙", "丁"]), true)
  assert.strictEqual(hasPositionDependency(["甲", "乙", "丙"]), false)
  assert.strictEqual(hasPositionDependency(["以上", "无关词"]), false) // 「以上」单独出现不算
})

// ---- 动词表（SPEC §十：v0 收录 7 个）----

test("动词白名单 = 4 注释 + 3 围栏", () => {
  assert.deepStrictEqual([...COMMAND_VERBS].sort(), ["check-file", "fill", "quiz", "step"])
  assert.deepStrictEqual([...FENCE_VERBS].sort(), ["check-code", "match-output", "sql-result"])
})
