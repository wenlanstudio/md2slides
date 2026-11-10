"use strict"

/**
 * core/quiz/fence.js — ```quiz 题面围栏 → token 展开（双轨语法的渲染侧）。
 *
 * 2026-11-10 双轨裁决：题目既可用 `<!--quiz-->` 注释标记，也可用 ```quiz 围栏；
 * 两种载体归一成**同一份题目结构**（结构判定在 core/teaching-fences 的 scan()，
 * 富文本渲染在这里）。围栏解决注释族的两个真痛点：边界不确定、编辑器里看不见。
 *
 * 实现选择「token 级编译期展开」，而不是渲染后替换 DOM，也不是新增题目卡渲染器：
 *   一个 ```quiz fence token → 等价的 html_block 标记 + 块体二次解析出的 tokens。
 * 于是 quiz/parse.js 的 registerQuiz 一字不改就认得它，题干段落与选项列表照旧
 * 拿 data-md2s-quiz* 属性；分页、切页续块、元素游走、IR、PPTX、classbuzz 宿主
 * 全部零改动复用。块体走的是**同一个** markdown-it 实例，所以 `$…$` / `$$…$$`
 * 由 registerMath 的 KaTeX 规则渲染，加粗、行内代码、图片、表格同样白捡——
 * 这就是「内嵌二次解析」。
 *
 * 与载荷围栏的分野（务必别混）：载荷围栏 = 块体即秘密，fencePolicy 默认 hide，
 * 学生版整块删；题面围栏 = 块体即题面，必须完整进放映/PPTX/学生版。本规则
 * 在 fencePolicy 之前把 fence token 换掉，因此 hide 表碰不到它。
 *
 * 参数读不出时**不展开**：原样渲染成代码块，老师能一眼看出这题没生效
 * （与注释族「标记原样保留」同哲学，不静默吞笔误）。
 */

const { QUIZ_FENCE_VERBS, parseParams } = require("../teaching-fences")

/** info-string：首词动词 + 参数体（其余交给 parseParams，JSON/kv 双形式）。 */
const RE_INFO = /^\s*([A-Za-z][\w-]*)\b\s*([\s\S]*)$/

/**
 * 参数对象 → 注释标记里的参数文本。
 * 只保留合法键名；值里的 `>` / 换行会毁掉 <!--…--> 结构，直接剔除；
 * 含空格或引号的值用 JSON 引号包住（parseParams 的 kv 正则认双引号）。
 */
function markerParams(params) {
  return Object.entries(params)
    .filter(([key]) => /^[A-Za-z][\w-]*$/.test(key))
    .map(([key, value]) => {
      const raw = String(value).replace(/[>\r\n]/g, "")
      return /[\s"']/.test(raw) ? `${key}=${JSON.stringify(raw)}` : `${key}=${raw}`
    })
    .join(" ")
}

/**
 * 挂到 markdown-it 实例上。必须在 registerQuiz 之后调用——规则要排在 quiz
 * **之前**（ruler.after("block") 后注册的会插到更前面，用 before 才稳）。
 *
 * @param {object} instance markdown-it 实例
 * @returns {object} instance（链式）
 */
function registerQuizFence(instance) {
  instance.core.ruler.before("quiz", "quizFence", state => {
    // 二次解析会递归跑同一条 core 链；块体里再出现 ```quiz 不再展开，
    // 否则一份讲义里嵌语法示例就能把解析器带进递归。
    if (state.env && state.env.__quizFenceNested) return false

    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.type !== "fence") continue
      const m = RE_INFO.exec(String(token.info ?? "").trim())
      if (!m || !QUIZ_FENCE_VERBS.has(m[1].toLowerCase())) continue

      const params = parseParams(m[2])
      if (params === null) continue

      // 二次解析：同一个实例 ⇒ 同一套插件 / KaTeX / 行内规则。
      // env 是浅拷贝，避免把嵌套标记写回外层（footnote 等插件也吃 env）。
      const innerEnv = Object.assign({}, state.env || {}, { __quizFenceNested: true })
      const inner = instance.parse(String(token.content ?? ""), innerEnv)

      // 内层 map 是相对块体的 0 基行号，平移回原文；渲染层的 data-src-*
      // 与 IR 的 block.srcRange 才能指对「点击幻灯片跳源码行」。
      const offset = token.map ? token.map[0] + 1 : 0
      if (offset) {
        for (const t of inner) {
          if (t.map) t.map = [t.map[0] + offset, t.map[1] + offset]
        }
      }
      // 内层整条 core 链已经把 inline 解析过一遍；这些 tokens 插回主流后，
      // 外层的 inline / text_join 还会再跑一次。清掉 children，把行内解析
      // 统一交给主链做一次——否则题干与每个选项的文字会渲染两遍。
      for (const t of inner) {
        if (t.type === "inline") t.children = []
      }

      const marker = new state.Token("html_block", "", 0)
      marker.content = `<!--quiz ${markerParams(params)}-->\n`
      marker.block = true
      if (token.map) marker.map = [token.map[0], token.map[0] + 1]

      tokens.splice(i, 1, marker, ...inner)
      i += inner.length // marker 交给后续 quiz 规则消费，跳过刚插入的块体 tokens
    }
    return false
  })
  return instance
}

module.exports = { registerQuizFence, markerParams }
