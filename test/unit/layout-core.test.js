"use strict"
// layout-core 的单元回归（node --test，纯函数秒级）。deck 侧行为的真正
// 锁是 npm test 的浏览器回归 + 截图基线；这里锁的是内核自身的算术与策略
// 阈值——两端（deck / marktext 纸叶）共用的那层契约。

const test = require("node:test")
const assert = require("node:assert/strict")

const {
  STRATEGY,
  isHeadingTag,
  classifyCore,
  assembleUnits,
  countFittingPrefix,
  cutIndexByBottom,
  trimTrailingBlankLines,
  bisectMaxFit,
  adjustForWidow,
  selectCoreBreak,
  cutLinesFitting,
} = require("../../core/paginate/layout-core")

test("STRATEGY is the frozen closed set (view-model §5 全参数化)", () => {
  assert.equal(Object.isFrozen(STRATEGY), true)
  assert.equal(STRATEGY.widowFill, 0.35)
  assert.equal(STRATEGY.coreBreakFill, 0.25)
  assert.equal(STRATEGY.tocRoomSlack, 12)
  assert.equal(STRATEGY.textShrinkFloor, 8)
  assert.equal(STRATEGY.mediaFitRounds, 4)
  assert.equal(STRATEGY.mediaFitShrink, 0.95)
})

test("classifyCore mirrors coreTypeOf (含 p>唯一img 陷阱)", () => {
  assert.equal(classifyCore({ tag: "PRE" }), "code")
  assert.equal(classifyCore({ tag: "TABLE" }), "table")
  assert.equal(classifyCore({ tag: "UL" }), "list")
  assert.equal(classifyCore({ tag: "OL" }), "list")
  assert.equal(classifyCore({ tag: "IMG" }), "image")
  assert.equal(classifyCore({ tag: "FIGURE" }), "image")
  // 独立成行的图片渲染成 <p><img></p>：必须判成图片核心，不能当引语。
  assert.equal(classifyCore({ tag: "P", soleImg: true }), "image")
  assert.equal(classifyCore({ tag: "P", soleImg: false }), null)
  assert.equal(classifyCore({ tag: "DIV", katexDisplay: true }), "math")
  assert.equal(classifyCore({ tag: "P" }), null)
})

test("assembleUnits: 引语+核心+结束语一体，其余走文档流", () => {
  // P(引语) PRE(核心) P(结束语) P(文档流)——描述子只给原始形状，分类在内核里。
  const d = tag => ({ tag })
  const units = assembleUnits([d("P"), d("PRE"), d("P"), d("P")])
  assert.deepEqual(units.map(u => u.role), ["core", "flow"])
  const u = units[0]
  assert.equal(u.type, "code")
  assert.equal(u.intro, 0)
  assert.equal(u.core, 1)
  assert.equal(u.outro, 2)
  assert.equal(u.start, 0)
  assert.equal(u.end, 2)
})

test("assembleUnits 歧义规则：两核心间的段落归后者当引语；引用归前者当结束语", () => {
  const d = tag => ({ tag })
  // PRE P UL：P 夹在两个核心之间 → 后面核心（UL）的引语。
  const r1 = assembleUnits([d("PRE"), d("P"), d("UL")])
  assert.equal(r1[0].outro, -1)          // 不归前一个核心
  assert.equal(r1[1].intro, 1)           // 归后面的核心
  // PRE BLOCKQUOTE P：引用不当下一个核心的引语（引语必须是段落）
  // → 后面不是核心时归前者当结束语。
  const r2 = assembleUnits([d("PRE"), d("BLOCKQUOTE"), d("P")])
  assert.equal(r2[0].outro, 1)
  // PRE BLOCKQUOTE UL：两核心间的引用两头都够不上 → 保持文档流单元。
  const r3 = assembleUnits([d("PRE"), d("BLOCKQUOTE"), d("UL")])
  assert.equal(r3[0].outro, -1)
  assert.equal(r3[1].role, "flow")
  assert.equal(r3[2].intro, -1)
})

test("countFittingPrefix（splitTable 切行循环）", () => {
  assert.equal(countFittingPrefix([100, 100, 100], 250), 2)   // 第三行越界
  assert.equal(countFittingPrefix([100, 100, 100], 300), 3)   // 恰好全放下
  assert.equal(countFittingPrefix([100, 100, 100], 99), 0)    // 一行都放不下
  assert.equal(countFittingPrefix([], 100), 0)
  // 恰好压线的行算放下（acc + h > room 为假）。
  assert.equal(countFittingPrefix([100], 100), 1)
})

test("cutIndexByBottom（splitList / splitFirstItemInside 切点循环）", () => {
  assert.equal(cutIndexByBottom([10, 20, 30], 25), 2)   // 第 3 项越界
  assert.equal(cutIndexByBottom([10, 20, 30], 30), 3)   // 无续项（调用方校验）
  assert.equal(cutIndexByBottom([10, 20], 5), 0)        // 首项即越界
  assert.equal(cutIndexByBottom([], 100), 0)
})

test("trimTrailingBlankLines 弹尾随空行且不变异入参", () => {
  const src = ["a", "b", "", " "]
  const out = trimTrailingBlankLines(src)
  assert.deepEqual(out, ["a", "b"])
  assert.deepEqual(src, ["a", "b", "", " "])            // 入参原样
  assert.deepEqual(trimTrailingBlankLines(["only"]), ["only"])
  assert.deepEqual(trimTrailingBlankLines(["", ""]), [""])   // 至少保一条
})

test("bisectMaxFit（splitCodeBlock 主循环）", () => {
  assert.equal(bisectMaxFit(10, k => k <= 7), 7)
  assert.equal(bisectMaxFit(10, () => true), 10)        // 全放得下（调用方查 best>=count）
  assert.equal(bisectMaxFit(10, () => false), 1)        // 调用方须先查 fits(1)
  assert.equal(bisectMaxFit(1, () => true), 1)
})

test("adjustForWidow 回退文档流单元，绝不越过核心", () => {
  // 单元：0..2=flow 3=core；切点候选 ui=3（首个越界单元）。
  const units = [
    { role: "flow", start: 0, end: 0 },
    { role: "flow", start: 1, end: 1 },
    { role: "flow", start: 2, end: 2 },
    { role: "core", start: 3, end: 3 },
  ]
  const tops = [0, 100, 200, 300]
  const budget = 1000
  // 尾部只有 340−300=40px（< 35% 页高）→ 一路回退到 units[0].start=0。
  assert.equal(adjustForWidow(units, tops, 3, 340, budget), 0)
  // 尾部足够长（600px ≥ 350）→ 无回退，null（调用方保住自己的精确断点）。
  assert.equal(adjustForWidow(units, tops, 3, 900, budget), null)
  // ui 的前一单元是核心 → 立即停（一页两个核心是硬约束）。
  const units2 = [
    { role: "core", start: 0, end: 0 },
    { role: "flow", start: 1, end: 1 },
  ]
  assert.equal(adjustForWidow(units2, [0, 500], 1, 550, budget), null)
})

test("selectCoreBreak（enforceOneCorePerSlide 选靶）", () => {
  const desc = tag => ({ tag })
  const core = { role: "core", type: "list", core: 1, intro: -1, outro: -1, start: 1, end: 1 }
  const units = [{ role: "flow", start: 0, end: 0 }, core]
  // 前面只有标题 → 不拆。
  assert.equal(selectCoreBreak(units, [desc("H2"), desc("UL")], [100], 1000), null)
  // 前面有实内容且够阈值 → 拆。
  assert.equal(selectCoreBreak(units, [desc("P"), desc("UL")], [300], 1000), core)
  // 前面内容不足页高 25%（且前单元不是核心）→ 不拆。
  assert.equal(selectCoreBreak(units, [desc("P"), desc("UL")], [100], 1000), null)
  // 前单元也是核心（一页两个）→ 硬规则压过软阈值。
  const prevCore = { role: "core", type: "table", core: 0, intro: -1, outro: -1, start: 0, end: 0 }
  assert.equal(
    selectCoreBreak([prevCore, core], [desc("TABLE"), desc("UL")], [10], 1000),
    core
  )
})

test("cutLinesFitting（段落切行，widow/orphan ≥ 2 镜像 Chromium）", () => {
  const lines = Array.from({ length: 9 }, () => 20)   // 9 行 × 20px
  // 全放得下 → fits。
  assert.deepEqual(cutLinesFitting(lines, 180, 400), { kind: "fits" })
  // 容量 8 行 > maxKeep 7 → widows 收口到 7（续页带 2 行）。
  assert.deepEqual(cutLinesFitting(lines, 160, 400), { kind: "at", keep: 7 })
  // 容量 5 行（< maxKeep）→ 容量切，续行 4 ≥ 2。
  assert.deepEqual(cutLinesFitting(lines, 100, 400), { kind: "at", keep: 5 })
  // 3 行段（total ≤ orphans+widows，内切必违约）→ 整段推下页。
  assert.deepEqual(cutLinesFitting([20, 20, 20], 50, 400), { kind: "before" })
  // 本页只容 1 行（< orphans 2）→ 整段推下页。
  assert.deepEqual(cutLinesFitting(lines, 30, 400), { kind: "before" })
  // 超整页段但约束可满足（续行 25 ≥ widows 2）→ 正常容量切，不是 split-anyway。
  const tall = Array.from({ length: 30 }, () => 20)
  assert.deepEqual(cutLinesFitting(tall, 100, 400), { kind: "at", keep: 5 })
  // 真正的 split-anyway：本页只容 1 行（< orphans 2）且整段又放不下一页
  // （600 > 400）→ 违规容量硬切（分页必须推进，不许死循环）。
  assert.deepEqual(cutLinesFitting(tall, 30, 400), { kind: "split-anyway", keep: 1 })
  // 空段。
  assert.deepEqual(cutLinesFitting([], 0, 400), { kind: "fits" })
})

test("cutLinesFitting 行高不齐与压线（keep 取容量与寡行收口的较小者）", () => {
  // 行高 [30,30,20,...]：容量 80 → 前 2 行（30+30）放得下、第 3 行 30+30+20=80
  // 恰好压线也算下 → maxFit = 3？——countFittingPrefix 压线放行：80 ≤ 80 ✓。
  const lines = [30, 30, 20, 20, 20]
  assert.deepEqual(cutLinesFitting(lines, 80, 400), { kind: "at", keep: 3 })
  // maxFit 3 行 < orphans 2？不，3 ≥ 2 → 正常切。
  // 2 行段：total 2 < orphans 2 + widows 2 → 内切必违约 → before。
  assert.deepEqual(cutLinesFitting([20, 20], 30, 400), { kind: "before" })
})
