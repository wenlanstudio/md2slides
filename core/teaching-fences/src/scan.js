"use strict"

/**
 * scan.js — 文档级扫描：一份 md → 全部教学结构 + 校验结果。
 *
 * 自写行状态机、不绑 markdown 库，理由：
 *  - 教学指令的识别是行级/块级模式匹配（注释行、围栏开闭、列表行），完整 AST
 *    反而引入宿主差异——markdown-it 与 muya 的 token/节点模型不同，行文本唯一；
 *  - 发布校验（wenshu 经引擎）要的是「结构和问题」，不是渲染树；
 *  - 「md 产物按行区间删除」（SPEC §七）本来就以行为单位，行号在此一处生成。
 *
 * 校验哲学（SPEC §六）：任一 problem 拒发；warnings 只提示不拦。
 * 为什么普通代码块要整体跳过：```java 块里贴一段 <!--quiz--> 示例是讲义常态，
 * 不跟踪围栏开闭就会把示例当代码——md2slides 在 token 流上天然正确，行状态机
 * 必须自己跟踪。
 */

const { parseCommand, RE_MARK } = require("./command")
const { parseFenceInfo } = require("./fence")
const { parseParams, toInt } = require("./params")
const { normalizeAnswer } = require("./answers")
const { stripOptionPrefix, hasPositionDependency } = require("./options")
const { COMMAND_VERBS, FENCE_VERBS, ASSERT_VERBS, PARAM_KEYS } = require("./verbs")

/** 块级阻断物：quiz 结构被它们打断即判无效（题干归属必须唯一可判，SPEC §2.2）。 */
const RE_HEADING = /^\s{0,3}#{1,6}\s/
const RE_BLOCKQUOTE = /^\s{0,3}>/
const RE_TABLE = /^\s{0,3}\|/
/** 选项列表项：bullet 或有序（承 md2slides：两种列表都当选项载体）。 */
const RE_LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+(.+)$/

const QUIZ_TYPES = new Set(["single", "multi", "fill", "essay"])

/**
 * @param {string} md 讲义全文
 * @param {object} [opts]
 * @param {boolean} [opts.requireIds=false] 发布校验传 true：quiz/step/fill 缺 id 即
 *   problem（SPEC §一.3：发布态 id 必填，自动编号插一题全错位）；纯抢答讲义不传，
 *   缺 id 沿用自动编号（q1/q2…）。
 * @returns {{marks: Array, fences: Array, quizzes: Array, steps: Array, fills: Array,
 *            problems: Array, warnings: Array}}
 */
function scan(md, opts = {}) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n")
  const out = { marks: [], fences: [], quizzes: [], steps: [], fills: [], problems: [], warnings: [] }
  const problem = (code, line, message, verb) =>
    out.problems.push(verb ? { code, line, message, verb } : { code, line, message })
  const warning = (code, line, message) => out.warnings.push({ code, line, message })

  const usedIds = { quiz: new Map(), step: new Map(), fill: new Map() }
  const seq = { quiz: 0, step: 0, fill: 0 }
  let currentStep = null

  // ---- frontmatter 整块跳过（仅文档头 --- 围栏；fm 教学字段的校验归 wenshu）----
  let i = 0
  if (lines[0]?.trim() === "---") {
    i = 1
    while (i < lines.length && lines[i].trim() !== "---") i++
    i++
  }

  while (i < lines.length) {
    const line = lines[i]

    // ---- 围栏（教学或普通都跟踪开闭；体内一切标记作废）----
    const fenceOpen = /^\s{0,3}(`{3,})(.*)$/.exec(line)
    if (fenceOpen) {
      const ticks = fenceOpen[1].length
      const startLine = i + 1
      const body = []
      i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}\`{${ticks},}\\s*$`).test(lines[i])) {
        body.push(lines[i])
        i++
      }
      const closed = i < lines.length
      if (closed) i++

      const info = parseFenceInfo(fenceOpen[2])
      if (!info || !FENCE_VERBS.has(info.verb)) continue // 普通代码块：跳过
      const params = info.params
      if (params === null) {
        problem("PARAMS_UNREADABLE", startLine, "围栏参数读不出（JSON 与 key=val 都失败）", info.verb)
        continue
      }
      validateParams(info.verb, params, startLine, problem)

      const fence = {
        verb: info.verb,
        params,
        body: body.join("\n"),
        lineStart: startLine,
        lineEnd: i, // 闭合行的下一行（行号语义：[lineStart, lineEnd) ，派生按行删正好用）
      }
      out.fences.push(fence)
      if (ASSERT_VERBS.has(info.verb)) {
        if (!currentStep) {
          problem("ASSERT_ORPHAN", startLine,
            `断言围栏（${info.verb}）出现在首个 step 之前，无处归属`, info.verb)
        } else {
          currentStep.asserts.push(fence)
        }
      }
      continue
    }

    // ---- 注释标记行 ----
    const mark = parseCommand(line)
    if (mark) {
      if (!COMMAND_VERBS.has(mark.verb)) { i++; continue } // 分栏等普通注释
      const rec = { verb: mark.verb, params: null, line: i + 1, raw: line.trim() }
      out.marks.push(rec)

      if (mark.verb === "check-file") {
        rec.params = parseParams(mark.paramsRaw)
        if (rec.params === null) {
          problem("PARAMS_UNREADABLE", rec.line, "标记参数读不出，已当普通注释保留", mark.verb)
          i++; continue
        }
        validateParams("check-file", rec.params, rec.line, problem)
        if (currentStep) currentStep.asserts.push({ verb: "check-file", params: rec.params, line: rec.line })
        else problem("ASSERT_ORPHAN", rec.line, "断言标记（check-file）出现在首个 step 之前", "check-file")
        i++; continue
      }

      rec.params = parseParams(mark.paramsRaw)
      if (rec.params === null) {
        problem("PARAMS_UNREADABLE", rec.line,
          "标记参数读不出（JSON 与 key=val 都失败），已当普通注释保留——请检查写法", mark.verb)
        i++; continue
      }
      validateParams(mark.verb, rec.params, rec.line, problem)

      if (mark.verb === "quiz") {
        i = collectQuiz(lines, i, rec, out, { opts, usedIds, seq, problem, warning })
        continue
      }
      if (mark.verb === "step") {
        const id = takeId(rec, "step", opts, usedIds, seq, problem)
        const step = {
          id,
          name: rec.params.name ?? id,
          point: toInt(rec.params.point) ?? 7,
          line: rec.line,
          asserts: [],
        }
        out.steps.push(step)
        currentStep = step
        i++
        continue
      }
      if (mark.verb === "fill") {
        const id = takeId(rec, "fill", opts, usedIds, seq, problem)
        i = collectFill(lines, i, { id, params: rec.params, line: rec.line }, out)
        continue
      }
      i++
      continue
    }

    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// quiz 组装（SPEC §2.2 结构硬约束：标记 → 空行 → 题干段落 → 空行 → 选项列表）
// ---------------------------------------------------------------------------

const isBlank = l => !l.trim()
const isBlocker = l =>
  RE_HEADING.test(l) || RE_BLOCKQUOTE.test(l) || RE_TABLE.test(l) ||
  /^\s{0,3}`{3,}/.test(l) || RE_MARK.test(l)

/**
 * 从标记行下标开始组装一道题；返回扫描推进到的新下标。
 * 结构无效时题目不入 `quizzes`（标记原样保留在 marks 里，老师看得到没生效）。
 */
function collectQuiz(lines, i, rec, out, ctx) {
  const { opts, usedIds, seq, problem, warning } = ctx
  const params = rec.params
  const type = params.type ?? "single"
  if (!QUIZ_TYPES.has(type)) {
    problem("BAD_ENUM", rec.line, `quiz type「${type}」不合法（single/multi/fill/essay）`, "quiz")
    return i + 1
  }

  // 题干：跳过空行后第一个连续段落
  let j = i + 1
  while (j < lines.length && isBlank(lines[j])) j++
  const stemLines = []
  while (j < lines.length && !isBlank(lines[j]) && !isBlocker(lines[j]) && !RE_LIST_ITEM.test(lines[j])) {
    stemLines.push(lines[j].trim())
    j++
  }
  if (!stemLines.length) {
    problem("QUIZ_NO_STEM", rec.line, "quiz 标记后没有题干段落（标记 → 空行 → 题干 → 空行 → 选项）", "quiz")
    return i + 1
  }
  while (j < lines.length && isBlank(lines[j])) j++

  // 选项：fill/essay 只要题干；其余必须紧跟选项列表
  const options = []
  if (type === "single" || type === "multi") {
    let inList = false
    while (j < lines.length) {
      const line = lines[j]
      if (isBlank(line)) break // 空行结束列表（列表内空行属多段列表，v0.1 从简）
      const item = RE_LIST_ITEM.exec(line)
      if (item) {
        const stripped = stripOptionPrefix(item[1])
        options.push(stripped)
        inList = true
        j++
        continue
      }
      // 缩进续行并入上一选项（选项两行描述是讲义常态）
      if (inList && /^\s{2,}\S/.test(line)) {
        options[options.length - 1].text += " " + line.trim()
        j++
        continue
      }
      break
    }
    if (!options.length) {
      problem("QUIZ_NO_OPTIONS", rec.line, "single/multi 题没有选项列表（- 开头的列表）", "quiz")
      return i + 1
    }
  }

  // ---- 字段校验与组装 ----
  const id = takeId(rec, "quiz", opts, usedIds, seq, problem)
  const quiz = {
    id,
    type,
    answer: null,
    point: toInt(params.point) ?? 5,
    limit: clampLimit(params.limit),
    min: toInt(params.min),
    max: toInt(params.max),
    shuffle: params.shuffle ?? "yes",
    stem: stemLines.join("\n"),
    options,
    line: rec.line,
  }

  const answer = normalizeAnswer(params.answer, type)
  if (answer === null && type !== "essay") {
    problem("QUIZ_NO_ANSWER", rec.line,
      `quiz「${id}」缺 answer 或 answer 认不出（非 essay 必填，宁拒不猜）`, "quiz")
  } else {
    quiz.answer = answer
  }
  if (Array.isArray(answer) && answer.some(a => a >= options.length)) {
    problem("QUIZ_ANSWER_OUT_OF_RANGE", rec.line,
      `quiz「${id}」answer 超出选项范围（${options.length} 个选项）`, "quiz")
  } else if (typeof answer === "number" && options.length && answer >= options.length) {
    problem("QUIZ_ANSWER_OUT_OF_RANGE", rec.line,
      `quiz「${id}」answer 超出选项范围（${options.length} 个选项）`, "quiz")
  }
  if (!["yes", "no"].includes(quiz.shuffle)) {
    problem("BAD_ENUM", rec.line, `quiz「${id}」shuffle 只认 yes/no`, "quiz")
    quiz.shuffle = "yes"
  }

  // W1：开着乱序 + 选项引用字母/位置 → 自相矛盾，提示但不拒发（SPEC §2.4）
  if (quiz.shuffle !== "no" && (type === "single" || type === "multi") && options.length >= 3) {
    if (hasPositionDependency(options.map(o => o.text))) {
      warning("SHUFFLE_POSITION_DEPENDENT", rec.line,
        `quiz「${id}」选项疑似依赖字母或位置（如「以上都对」），建议 shuffle=no`)
    }
  }

  out.quizzes.push(quiz)
  return j
}

function clampLimit(raw) {
  const n = toInt(raw)
  if (n == null) return 30
  return Math.min(300, Math.max(5, n))
}

// ---------------------------------------------------------------------------
// fill 作答区：标记之后到下一个块级边界（指令标记/围栏/标题）为止（SPEC §3.3）
// ---------------------------------------------------------------------------

function collectFill(lines, i, info, out) {
  let j = i + 1
  const contentLines = []
  while (j < lines.length && !RE_HEADING.test(lines[j]) && !/^\s{0,3}`{3,}/.test(lines[j]) &&
         !RE_MARK.test(lines[j])) {
    contentLines.push(lines[j])
    j++
  }
  while (contentLines.length && isBlank(contentLines[contentLines.length - 1])) contentLines.pop()
  out.fills.push({
    id: info.id,
    min: toInt(info.params.min),
    max: toInt(info.params.max),
    line: info.line,
    contentLines,
  })
  return j
}

// ---------------------------------------------------------------------------
// 公共校验
// ---------------------------------------------------------------------------

/** 自动编号前缀：quiz 沿用抢答态的 q1/q2…（SPEC §一.3），step/fill 各自独立计。 */
const ID_PREFIX = { quiz: "q", step: "s", fill: "f" }

/**
 * id 三规则（SPEC §一.3）：发布态必填（requireIds）、显式 id 文档内唯一、
 * 缺省自动编号（按「第几个」计——自动号要跟讲课顺序对得上，只数缺 id 的会错位）。
 */
function takeId(rec, verb, opts, usedIds, seq, problem) {
  seq[verb] += 1
  const explicit = rec.params.id ? String(rec.params.id) : null
  if (!explicit && opts.requireIds) {
    problem("ID_MISSING", rec.line, `${verb} 缺 id（发布态必填——自动编号插一题全错位）`, verb)
  }
  const id = explicit ?? `${ID_PREFIX[verb]}${seq[verb]}`
  if (explicit) {
    const prev = usedIds[verb].get(id)
    if (prev) {
      problem(`${verb.toUpperCase()}_DUPLICATE_ID`, rec.line, `${verb} id「${id}」与第 ${prev} 行重复`, verb)
    } else {
      usedIds[verb].set(id, rec.line)
    }
  }
  return id
}

function validateParams(verb, params, line, problem) {
  const allowed = PARAM_KEYS[verb]
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      problem("UNKNOWN_PARAM", line, `${verb} 的参数「${key}」不认识`, verb)
    }
  }

  // required（SPEC §六#2/§三）
  const required = { "check-file": "path", "check-code": "path", "match-output": "run", "sql-result": "db" }[verb]
  if (required && !params[required]) {
    problem("REQUIRED_MISSING", line, `${verb} 缺必填参数 ${required}=`, verb)
  }

  // enum（错值宽容处理：报 problem，消费方按默认走）
  const enums = {
    "check-file": { key: "mode", values: ["present", "absent"] },
    "check-code": { key: "mode", values: ["loose", "strict"] },
  }[verb]
  if (enums && params[enums.key] && !enums.values.includes(params[enums.key])) {
    problem("BAD_ENUM", line, `${verb} ${enums.key}= 只认 ${enums.values.join("/")}`, verb)
  }
  if (params.judge && !["local", "server"].includes(params.judge)) {
    problem("BAD_ENUM", line, `${verb} judge= 只认 local/server`, verb)
  }

  // 路径安全：禁绝对路径与 .. 逃逸（SPEC §3.2，同 file= 规矩）
  for (const key of ["path", "stdin"]) {
    if (params[key] && isUnsafePath(params[key])) {
      problem("BAD_PATH", line, `${verb} ${key}「${params[key]}」须是章工作目录内相对路径（禁绝对路径与 ..）`, verb)
    }
  }
}

function isUnsafePath(p) {
  const text = String(p)
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  if (text.startsWith("/") || text.startsWith("\\")) return true
  return text.split(/[\\/]/).includes("..")
}

module.exports = { scan }
