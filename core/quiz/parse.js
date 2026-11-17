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

const { parseParams, normalizeAnswer: normalizeAnswerBase, scan } = require("../teaching-fences")

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
 * 参数双形式（JSON 优先、kv 退回）与答案归一收敛到 teaching-fences——语法只允许
 * 一份实现（SPEC §八：原语复用，防「预览认得出的题，判分认不出」式漂移）。
 *
 * @param {string} raw 标记里 `<!--quiz` 与 `-->` 之间的内容
 * @returns {{answer: number|null, limit: number, id: string|null, raw: object}|null}
 *   null = 参数完全读不懂；answer 为 null = 参数读懂了但没给答案。
 */
function parseQuizMeta(raw) {
  const obj = parseParams(raw)
  if (obj === null) return null

  const answer = normalizeAnswerBase(obj.answer)
  // limitsec 是抢答态的历史键名（键已统一小写），保留识别防旧讲义失效
  const limit = Number(obj.limit ?? obj.limitsec ?? 30)
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
 * （实现委托 teaching-fences：0 基约定一处持有，课堂判分与平台判分同口径。）
 */
const normalizeAnswer = value => normalizeAnswerBase(value, "single")

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
 * scan 结果按「标记行号 → 题目记录」的索引缓存（键 = 文档原文）。
 *
 * 为什么 token 规则要 join scan：id 与元数据的唯一权威是 teaching-fences 的
 * scan()（判分/发布链同源）；这里若自带第二套自动编号，两轨口径必然漂移。
 * 同一份原文在编辑器里会被反复重渲染，缓存一份索引，命中即免重扫。
 */
const SCAN_INDEX_CACHE_MAX = 16
const scanIndexCache = new Map()

function scanIndexFor(src) {
  let index = scanIndexCache.get(src)
  if (!index) {
    index = new Map()
    for (const quiz of scan(src).quizzes) index.set(quiz.line, quiz)
    if (scanIndexCache.size >= SCAN_INDEX_CACHE_MAX) scanIndexCache.clear()
    scanIndexCache.set(src, index)
  }
  return index
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
  // 题面围栏块体的二次解析不认题：scan 对围栏体内的标记一律无视（结构上是
  // 题面的一部分），这里必须同口径，否则预览认得出的题判分认不出。
  if (state.env && state.env.__quizFenceNested) return false

  const tokens = state.tokens
  const drop = []
  let index = null

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type !== "html_block") continue
    const text = String(token.content ?? "").trim()
    if (!RE_MARKER.test(text)) continue

    if (!index) index = scanIndexFor(state.src)
    const line = token.map ? token.map[0] + 1 : null
    const rec = line != null ? index.get(line) : null
    // scan 不认（结构无效 / 缩进超限 / 围栏体内）→ 标记原样保留，与判分同口径
    if (!rec) continue

    const { stem, options } = locate(tokens, i + 1)
    // 防御：scan 认了但 token 侧定位不到（两侧行为不一致时不该有题）
    if (stem < 0 || options < 0) continue

    tokens[stem].attrSet(ATTR_QUIZ, rec.id)
    tokens[stem].attrSet(ATTR_META, JSON.stringify({
      answer: rec.answer,
      limit: rec.limit,
      id: rec.id,
    }))
    tokens[options].attrSet(ATTR_OPTIONS, rec.id)
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
 * 元素的「人话文本」。
 *
 * KaTeX 渲染一个公式会输出三份内容（MathML 无障碍层 + katex-html 可见层 +
 * annotation 里的 TeX 原文），直接取 textContent 会把公式重复三遍——放映页
 * 看着正常，可题目发到学生手机上就成了 `n(n+1)n(n+1)n(n+1)`。把每个
 * .katex 节点换回 `$<annotation>$`，文本侧就恢复成作者写的 TeX。
 * 双轨语法鼓励在题面写公式，这一层必须跟上；不含公式的题走原路径，零开销。
 */
function textOf(el) {
  if (!el) return ""
  if (!el.querySelector || !el.querySelector(".katex")) {
    return (el.textContent || "").trim()
  }
  const clone = el.cloneNode(true)
  for (const node of [...clone.querySelectorAll(".katex")]) {
    const tex = node.querySelector("annotation")?.textContent || ""
    node.replaceWith(clone.ownerDocument.createTextNode(tex ? `$${tex}$` : ""))
  }
  return (clone.textContent || "").trim()
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
        .map(textOf)
        .filter(Boolean)
      : []
    out.push({
      qid,
      stem: textOf(stemEl),
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
