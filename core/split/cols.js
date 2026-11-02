"use strict";
/**
 * cols.js — `<!-- begin / split / end -->` 三注释分栏。
 *
 * 与 marktext（`packages/muya/src/utils/columns/syntax.ts`）同族同规则：两侧 lint
 * 一致，用户混用两个编辑器时行为不会分叉。替代了早期的 `::: cols` 糖。
 *
 * 语法（关键字大小写不敏感，注释内空白容忍；标记必须**从行首开始**独占一行，
 * 最多 3 空格缩进——超过即视为列表/引用/表格/行内内容，不参与分栏）：
 *
 *   <!-- begin 30:70 -->     开组，可带占比（正整数，和为 100）
 *   左栏内容
 *   <!-- split -->           栏分隔（可多个；不计入栏数）
 *   右栏内容
 *   <!-- end -->             闭合
 *
 * 栏数 = split 数 + 1，无显式声明；占比个数与栏数不符 → 等宽。
 *
 * 合法性规则（1–8 同 marktext §1.3，编号一致；9 是本项目扩展）：
 *   1 孤立 split/end            → 忽略，warning
 *   2 begin 无 end（EOF 前）     → 该组不分栏、内容原位保留，warning
 *   3 嵌套 begin                → 内层忽略，warning
 *   4 split 多于 2（超过 3 栏）  → 整组线性排列，warning
 *   5 占比非法 / 个数与栏数不符   → 按等宽渲染，info
 *   6 注释未闭合（没有 -->）      → 该标记无效，warning
 *   7 标记不在顶层               → inert，info
 *   8 （marktext 专用：徽标形态，md2slides 无此项）
 *   9 begin 后没有 split          → 至少 2 栏才成组，不展开，warning
 *
 * 代码围栏内的标记是字面文本，天然安全（围栏跳过）。
 *
 * 输出结构不变：两个 python-mini 主题与 `export/pptx/ir.js` 都认 `.cols` / `.col`。
 * 栏宽：等宽栏靠主题 `.col` 默认的 `flex: 1 1 0`（零 CSS）；不等比栏内联
 * `style="flex: N 1 0"`（marp 已不在链路里，内联 style 直达 DOM——
 * 早期用 `<style>` 块是迁就 marp 剥 style，且那块 CSS 文本会污染 IR 的
 * 逐页文本比对，已删）。
 */
const MAX_COLUMNS = 3
const RATIO_TOTAL = 100

const RE_FENCE = /^[ \t]*(?:```|~~~)/
const RE_BEGIN = /^<!--\s*begin(?:\s+([^>]*?))?\s*-->$/i
const RE_SPLIT = /^<!--\s*split\s*-->$/i
const RE_END = /^<!--\s*end\s*-->$/i
const RE_MARKER_WORD = /^<!--\s*(?:begin|split|end)\b/i
const RE_TOP_LINE = /^ {0,3}<!--/

/**
 * 栏宽占比 → 各栏 flex-grow 值。必须全为正整数且和恰为 100（`30:70`、`25:25:50`）。
 * 任何不合法都返回 null——宽度绝不从畸形占比里猜（§1.3 #5 降级等宽）。
 * @param {string|undefined} text
 * @returns {number[]|null}
 */
const parseRatio = text => {
  if (!text) return null
  const nums = []
  for (const part of text.split(":")) {
    const t = part.trim()
    if (!/^\d+$/.test(t)) return null
    const n = Number(t)
    if (!Number.isSafeInteger(n) || n <= 0) return null
    nums.push(n)
  }
  if (!nums.length) return null
  return nums.reduce((s, n) => s + n, 0) === RATIO_TOTAL ? nums : null
}

const isMarkerLine = trimmed =>
  RE_BEGIN.test(trimmed) || RE_SPLIT.test(trimmed) || RE_END.test(trimmed)

/**
 * @param {string} text raw Markdown
 * @returns {{ text: string, count: number,
 *            diagnostics: Array<{rule:number, level:string, line:number, message:string}> }}
 *          diagnostics 按行号排序；count = 实际展开的组数（降级组不计）。
 */
const expandColumns = text => {
  const lines = (text ?? "").split(/\r?\n/)
  const diagnostics = []
  const groups = []
  let open = null
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (RE_FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    if (RE_TOP_LINE.test(line)) {
      const begin = RE_BEGIN.exec(trimmed)
      if (begin) {
        if (open) {
          diagnostics.push({
            rule: 3, level: "warning", line: i + 1,
            message: "不支持嵌套分栏，内层 begin 已忽略",
          })
          continue
        }
        open = { begin: i, splits: [], ratioText: begin[1] }
        continue
      }
      if (RE_SPLIT.test(trimmed)) {
        if (!open) {
          diagnostics.push({
            rule: 1, level: "warning", line: i + 1,
            message: "孤立的 split 标记（没有对应的 begin），已忽略",
          })
          continue
        }
        open.splits.push(i)
        continue
      }
      if (RE_END.test(trimmed)) {
        if (!open) {
          diagnostics.push({
            rule: 1, level: "warning", line: i + 1,
            message: "孤立的 end 标记（没有对应的 begin），已忽略",
          })
          continue
        }
        const columns = open.splits.length + 1
        const degraded = open.splits.length > MAX_COLUMNS - 1
        if (degraded) {
          diagnostics.push({
            rule: 4, level: "warning", line: open.begin + 1,
            message: "栏数超过 3（split 多于 2 个），整组降级为线性排列",
          })
        }
        // rule 9（本项目扩展）：marktext 会建 1 栏组，md2slides 不建——单栏容器无语
        if (open.splits.length === 0) {
          diagnostics.push({
            rule: 9, level: "warning", line: open.begin + 1,
            message: "begin 后没有 split，未形成分栏（至少 2 栏）",
          })
          open = null
          continue
        }
        const ratio = parseRatio(open.ratioText)
        const ratioUsable = !!ratio && ratio.length === columns
        if (open.ratioText && !ratioUsable) {
          diagnostics.push({
            rule: 5, level: "info", line: open.begin + 1,
            message: ratio
              ? "栏宽占比个数与栏数不符，按等宽渲染"
              : `栏宽占比需为和为 ${RATIO_TOTAL} 的正整数（如 30:70），按等宽渲染`,
          })
        }
        groups.push({
          begin: open.begin, end: i, splits: [...open.splits],
          columns, ratio: ratioUsable ? ratio : null, degraded,
        })
        open = null
        continue
      }
      // 行首是注释、关键词也对，但没有闭合 -->
      if (RE_MARKER_WORD.test(trimmed) && !trimmed.includes("-->")) {
        diagnostics.push({
          rule: 6, level: "warning", line: i + 1,
          message: "注释缺少闭合 -->，该标记无效",
        })
      }
      continue
    }

    // 非顶层标记：整行 trim 后是标记形状，但行首不是注释（缩进 / 引用 / 表格 / 行内）
    if (isMarkerLine(trimmed)) {
      diagnostics.push({
        rule: 7, level: "info", line: i + 1,
        message: "标记不在顶层（列表 / 引用 / 表格 / 行内），不参与分栏",
      })
    }
  }

  if (open) {
    diagnostics.push({
      rule: 2, level: "warning", line: open.begin + 1,
      message: "begin 没有对应的 end，该组不分栏，内容原位保留",
    })
  }

  // ---- 展开合法组（degraded 组线性排列：标记行原样保留）----
  // 栏宽只走内联 style：等宽栏连 style 都不需要（主题 .col 默认 flex: 1 1 0）。
  const replacement = new Map()
  for (const group of groups) {
    if (group.degraded) continue
    const ratio = group.ratio
    const colDiv = g => {
      const style = ratio ? ` style="flex: ${ratio[g]} 1 0"` : ""
      return `<div class="col"${style}>`
    }
    replacement.set(group.begin, [
      `<div class="cols cols-${group.columns}">`, "",
      colDiv(0), "",
    ])
    group.splits.forEach((line, idx) => {
      replacement.set(line, ["</div>", "", colDiv(idx + 1), ""])
    })
    replacement.set(group.end, ["</div>", "", "</div>", ""])
  }

  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (replacement.has(i)) out.push(...replacement.get(i))
    else out.push(lines[i])
  }

  return {
    text: out.join("\n"),
    count: groups.filter(g => !g.degraded).length,
    diagnostics: diagnostics.sort((a, b) => a.line - b.line),
  }
}

module.exports = { expandColumns, parseRatio, MAX_COLUMNS, RATIO_TOTAL }
