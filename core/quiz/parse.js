"use strict"

/**
 * quiz/parse.js — 讲义里的「课堂竞答题」标记：把 Markdown 里的题目挖成结构化数据。
 *
 * 语法（承 md2slides 注释风格，与 `<!-- begin/split/end -->` 同族）：
 *
 *   <!--quiz {"answer":"B","limit":30}-->
 *   1 + 1 = ?
 *
 *   - 1
 *   - 2
 *   - 3
 *   - 4
 *
 * 标记之后的**第一个段落是题干**，**紧跟的第一个列表是选项**。两者之间不允许再插别的块
 * （插了就判为无效标记——题干的归属必须唯一可判，不能猜）。
 *
 * 为什么用注释而不是代码围栏：
 *  - 讲义源码里题干和选项仍是正常 Markdown，排版、强调、公式都能用；
 *  - 注释在渲染产物里天然消失，不会混进 IR 文本比对；
 *  - 和 md2slides 既有的三注释分栏是同一种语感，老师不用学第二种标记法。
 *
 * 为什么在 **token 流**上做，而不是渲染完再遍历 DOM：
 *  渲染产物里注释节点已经被 `sectionize` 丢掉了（它只搬 `host.children`，注释不是元素），
 *  到那一步标记已经不存在。token 流是唯一还看得见标记的地方。
 *
 * 产出：给题干段落打 `data-md2s-quiz`（题号）+ `data-md2s-quiz-meta`（元数据 JSON），
 * 给选项列表打 `data-md2s-quiz-options`（同一个题号）。宿主（kit/quiz）凭这两个属性
 * 找到题目、读出选项文字、挂「发放」按钮。
 *
 * 编辑器无关：这一层不认识 Typora，也不认识 classbuzz——它只认识「题」。
 */

/** 标记必须是独占一行的注释（最多 3 空格缩进，和分栏标记同规矩）。 */
const RE_MARKER = /^<!--\s*quiz\b([^>]*?)\s*-->$/i

/** 题干段落 / 选项列表上的属性（宿主据此认题）。 */
const ATTR_QUIZ = "data-md2s-quiz"
const ATTR_META = "data-md2s-quiz-meta"
const ATTR_OPTIONS = "data-md2s-quiz-options"

/** 扫描时遇到这些块就停：题干的归属必须唯一，跨不过去就判无效。 */
const BLOCKERS = new Set([
  "paragraph_open", "heading_open", "blockquote_open", "hr",
  "fence", "code_block", "table_open", "html_block",
])

/**
 * 解析标记里的参数。
 *
 * 首选 JSON（`{"answer":"B","limit":30}`）；JSON 不合法时退回 `key=value` 简写
 * （`answer=B limit=30`）——老师在讲义里手写，两种都得认。
 *
 * @param {string} raw 标记里 `<!--quiz` 与 `-->` 之间的内容
 * @returns {{answer: number|null, limit: number, id: string|null, raw: object}|null}
 *   null = 参数完全读不懂；answer 为 null = 参数读懂了但没给答案。
 */
function parseQuizMeta(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return { answer: null, limit: 30, id: null, raw: {} }

  let obj = null
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed
    } catch { /* 退回简写 */ }
  }
  if (!obj) {
    obj = {}
    // key=value（值可带引号），只认没有空格的值——带空格的值请用 JSON
    const re = /([A-Za-z][\w-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g
    let m
    while ((m = re.exec(text))) {
      obj[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "")
    }
    if (!Object.keys(obj).length) return null
  }

  const answer = normalizeAnswer(obj.answer)
  const limit = Number(obj.limit ?? obj.limitsec ?? obj.limitSec ?? 30)
  const id = obj.id ? String(obj.id) : null
  return {
    answer,
    limit: Number.isFinite(limit) ? Math.min(300, Math.max(5, Math.trunc(limit))) : 30,
    id,
    raw: obj,
  }
}

/**
 * 答案归一：字母（A–F，忽略大小写）或 0 基序号 → 0 基序号。
 * 认不出来返回 null——宁可让面板明确报「没设答案」，也不能猜错把分判反了。
 */
function normalizeAnswer(value) {
  if (value == null) return null
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  const text = String(value).trim()
  if (/^[A-Fa-f]$/.test(text)) return text.toUpperCase().charCodeAt(0) - 65
  if (/^\d+$/.test(text)) return Number(text)
  return null
}

/** 标记里的参数是不是「至少读出点东西」——用来决定要不要把标记留在文档里。 */
const isUsableMeta = meta => !!meta && meta.answer !== null

/**
 * 在 token 流里找题干段落与选项列表。
 * @returns {{stem: number, options: number}} token 下标；-1 表示没找到
 */
function locate(tokens, from) {
  let stem = -1
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].type === "paragraph_open") { stem = i; break }
    if (BLOCKERS.has(tokens[i].type)) return { stem: -1, options: -1 }
  }
  if (stem < 0) return { stem: -1, options: -1 }

  let options = -1
  for (let i = stem + 1; i < tokens.length; i++) {
    const type = tokens[i].type
    if (type === "bullet_list_open" || type === "ordered_list_open") { options = i; break }
    if (BLOCKERS.has(type)) break
  }
  return { stem, options }
}

/**
 * markdown-it core 规则：把 `<!--quiz ...-->` 标记消费掉，改写成题干/选项上的数据属性。
 *
 * 挂在 `block` 之后：此时段落与列表已经被解析成 token，标记本身是 html_block。
 *
 * @param {object} state markdown-it core 规则状态
 * @returns {boolean} 恒 false（不改内容就不阻断后续规则）
 */
function quizRule(state) {
  const tokens = state.tokens
  const drop = []
  let seq = 0

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type !== "html_block") continue
    const text = String(token.content ?? "").trim()
    const m = RE_MARKER.exec(text)
    if (!m) continue

    const meta = parseQuizMeta(m[1])
    // 参数读不出来（既不是 JSON 也不是 key=value）：把标记原样留着，别静默吞掉老师的笔误
    if (!meta) continue

    const { stem, options } = locate(tokens, i + 1)
    // 没有可判的题干/选项：标记留着（当普通注释），面板不会认它 → 老师能看出来没生效
    if (stem < 0 || options < 0) continue

    seq += 1
    const qid = meta.id || `q${seq}`
    tokens[stem].attrSet(ATTR_QUIZ, qid)
    tokens[stem].attrSet(ATTR_META, JSON.stringify({
      answer: meta.answer,
      limit: meta.limit,
      id: qid,
    }))
    tokens[options].attrSet(ATTR_OPTIONS, qid)
    drop.push(i)
  }

  for (let k = drop.length - 1; k >= 0; k--) tokens.splice(drop[k], 1)
  return false
}

/**
 * 把规则挂到 markdown-it 实例上。
 * @param {object} instance markdown-it 实例
 */
function registerQuiz(instance) {
  instance.core.ruler.after("block", "quiz", quizRule)
  return instance
}

/**
 * 从渲染产物（DOM）里读出一道题。宿主（kit/quiz）用它把 DOM 上的题目还原成
 * classbuzz 要的 `{stem, options, answer, limitSec}`。
 *
 * @param {Document|Element} root
 * @returns {Array<{qid:string, stem:string, options:string[], answer:number|null,
 *                  limitSec:number, stemEl:Element, optionsEl:Element}>}
 */
function readQuizzes(root) {
  if (!root?.querySelectorAll) return []
  // 题号是自造的小标识（q1/q2 或作者给的 id），但仍按 CSS 属性选择器的规矩转义一次，
  // 不然作者写个带引号的 id 就会把选择器拼坏（Node 侧没有 CSS.escape，不能依赖它）。
  const attrValue = s => String(s).replace(/["\\]/g, "\\$&")
  const out = []
  for (const stemEl of root.querySelectorAll(`[${ATTR_QUIZ}]`)) {
    const qid = stemEl.getAttribute(ATTR_QUIZ)
    const optionsEl = root.querySelector(`[${ATTR_OPTIONS}="${attrValue(qid)}"]`)
    let meta = {}
    try { meta = JSON.parse(stemEl.getAttribute(ATTR_META) || "{}") } catch { meta = {} }
    const options = optionsEl
      ? [...optionsEl.children]
        .filter(el => el.tagName === "LI")
        .map(li => li.textContent.trim())
        .filter(Boolean)
      : []
    out.push({
      qid,
      stem: (stemEl.textContent || "").trim(),
      options,
      answer: Number.isInteger(meta.answer) ? meta.answer : null,
      limitSec: Number(meta.limit) > 0 ? Number(meta.limit) : 30,
      stemEl,
      optionsEl,
    })
  }
  return out
}

module.exports = {
  registerQuiz,
  parseQuizMeta,
  normalizeAnswer,
  readQuizzes,
  RE_MARKER,
  ATTR_QUIZ,
  ATTR_META,
  ATTR_OPTIONS,
}
