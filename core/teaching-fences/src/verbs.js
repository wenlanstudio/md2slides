"use strict"

/**
 * verbs.js — 动词白名单与参数 schema（唯一定义处）。
 *
 * SPEC §十：v0 收录 7 个动词，词汇表刻意从窄。新动词进来时改这一处 +
 * 补语料 + 补 SPEC 条目，三样同步——这是「词汇表从窄」能守住的机制前提。
 */

/** 注释标记族（独占一行的 `<!--verb ...-->`）。 */
const COMMAND_VERBS = new Set(["quiz", "step", "fill", "check-file"])

/** 载荷围栏族（块体承载判分秘密）。 */
const FENCE_VERBS = new Set(["check-code", "match-output", "sql-result"])

/** 断言性动词：必须归属某个 step（首个 step 前出现 = 发布拒绝，SPEC §六#3）。 */
const ASSERT_VERBS = new Set(["check-file", "check-code", "match-output", "sql-result"])

/**
 * 各动词的合法参数集（未知 key= 记 problem，SPEC §一.1/§六#5）。
 * 校验细节（required / enum / 路径安全）在 scan 层做，这里只管「哪些 key 认识」。
 */
const PARAM_KEYS = {
  quiz: new Set(["id", "type", "answer", "point", "limit", "min", "max", "shuffle"]),
  step: new Set(["id", "name", "point"]),
  fill: new Set(["id", "min", "max"]),
  "check-file": new Set(["path", "mode"]),
  "check-code": new Set(["path", "mode", "judge"]),
  "match-output": new Set(["run", "path", "stdin", "judge"]),
  "sql-result": new Set(["db", "judge"]),
}

/**
 * 教学载荷围栏的默认节点动作（SPEC §一.4 秘密边界：放映/导出产物一律不含载荷）。
 *
 * 为什么默认是 hide：通用产品不认识「教师版/学生版」，唯一安全的默认 = 不展示——
 * 把载荷印出去就是泄题（M1.5 防泄题裁决）。教师版（服务端投影，M2a）将经同一
 * 钩子换成 notes（答案进备注）/ placeholder（课堂题换插槽）动作，机制不变。
 * 词汇表新增动词时这里同步登记——「三样同步」的第三样。
 */
const FENCE_ACTIONS = {
  "check-code": "hide",
  "match-output": "hide",
  "sql-result": "hide",
}

module.exports = { COMMAND_VERBS, FENCE_VERBS, ASSERT_VERBS, PARAM_KEYS, FENCE_ACTIONS }
