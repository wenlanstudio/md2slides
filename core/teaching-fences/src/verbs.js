"use strict"

/**
 * verbs.js — 动词白名单与参数 schema（唯一定义处）。
 *
 * SPEC §十：v0 收录 7 个动词，词汇表刻意从窄。新动词进来时改这一处 +
 * 补语料 + 补 SPEC 条目，三样同步——这是「词汇表从窄」能守住的机制前提。
 *
 * 2026-11-10 双轨裁决：quiz 增「题面围栏」形态（```quiz）。它与载荷围栏
 * **产物命运相反**：载荷整块删、题面必须完整进放映/PPTX/学生版。故另立
 * QUIZ_FENCE_VERBS，不并入 FENCE_VERBS——后者继续表示「块体即秘密」，
 * 任何按 FENCE_VERBS 做批量删除/剥离的地方都不该碰到题面。
 */

/** 注释标记族（独占一行的 `<!--verb ...-->`）。 */
const COMMAND_VERBS = new Set(["quiz", "step", "fill", "check-file"])

/** 载荷围栏族（块体承载判分秘密，学生版整块删）。 */
const FENCE_VERBS = new Set(["check-code", "match-output", "sql-result"])

/** 题面围栏族（块体是题面 Markdown，须渲染，不是秘密）。双轨：与注释标记族同参数、同结构。 */
const QUIZ_FENCE_VERBS = new Set(["quiz"])

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
  // class=（2026-11-14）：project 档姓名包名工程的定位键——学生文件路径每人不同
  // 写不死，按类名解析（与 todo 块 class= 同一套约定）；path=（body 档章工作目录）
  // 与 class= 二选一，校验在 scan 层。
  "check-code": new Set(["path", "class", "mode", "judge"]),
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
  // 显式登记：题面围栏**不是**载荷，默认动作是渲染。fencePolicy 目前只认
  // "hide"，其它动作忽略；写在这里是防止后来有人按「围栏 = 一律 hide」的
  // 直觉给 quiz 补上 hide，把整道题静默吞掉（比泄题更难发现）。
  quiz: "render",
}

module.exports = {
  COMMAND_VERBS, FENCE_VERBS, QUIZ_FENCE_VERBS, ASSERT_VERBS,
  PARAM_KEYS, FENCE_ACTIONS,
}
