"use strict"

/**
 * kit/steps.js — 步进表：一张页 → 有序的「步」。
 *
 * 立法在这里（一张页拆成哪些步、什么顺序），执法在 player.js（状态机、键盘、
 * 揭示类）。步进是放映时行为：不进 IR、不碰分页、不改版面——揭示靠 visibility
 * （占位不显示），页面从进来的那一刻就是最终版面（player.js 的职责边界）。
 *
 * 粒度封闭表（2026-10-25 拍板）：
 *   标题（任意级）/ 家具 / 封面容器   → 不算步（恒显锚点）
 *   顶层块（段落/代码/图/公式/引用/脚注块）→ 各一步
 *   列表                             → 每 li 一步；嵌套列表跟随父项整体出现
 *   表格                             → 先整张表一步，之后每数据行一步
 *   分栏                             → 递归每栏，栏内列表也逐步
 *   活图表                           → 宿主 steppers 钩子切分；没钩子 = 整块一步
 *   可激活元素 [data-md2s-activatable] → 各一步，附在所属块最后一步之后（翻页笔可达，
 *                                     Enter 触发——见 player.js 的 activate 契约）
 *
 * 判块只按标签与类名（UL/OL/TABLE/.cols/.cover），不需要 coreTypeOf——步的粒度
 * 不区分「哪种核心」。家具白名单 isFixed 则必须复用 overflow.js 那份：分页与步进
 * 对「什么不是内容」的判断不许各漂各的。
 *
 * 将来的「导出带动画的 PPTX」：Step 里 kind / srcRange / k 都可序列化，只有
 * el / handle 是运行时引用——IR v3 若加 slide.steps，从这里映射即可（v1 不动 IR）。
 */

const { isFixed } = require("../core/paginate/overflow")
const { isTocSlide } = require("../core/paginate/toc")

const isHeading = el => /^H[1-6]$/.test(el.tagName)
const isCols = el => !!el.classList?.contains("cols")

/** 行号（markdown.js 写进 data-src-*，1 基含端点）；与 ir.js 的 srcOf 同约定。 */
function srcRangeOf(el) {
  const start = Number(el.getAttribute?.("data-src-start"))
  if (!Number.isInteger(start) || start <= 0) return undefined
  const end = Number(el.getAttribute("data-src-end"))
  return [start, Number.isInteger(end) && end >= start ? end : start]
}

/**
 * 宿主图表切分钩子（core 调度、宿主执行——与 renderDiagram 同构）。
 *   steppers: [{ match: el => bool, create: el => ({ count, show(k), hide(k) }) }]
 * 命中且 count > 0 → 每个单元一步（扇区/数据项……show/hide 语义归宿主：高亮、
 * 重设数据都行）；钩子缺席、放弃（返回空）或抛错 → 整块一步，绝不硬猜图表内部。
 */
function chartSteps(el, steppers, issues) {
  for (const s of steppers ?? []) {
    try {
      if (!s?.match?.(el)) continue
      const handle = s.create?.(el)
      if (!handle || !(handle.count > 0) || typeof handle.show !== "function") break
      const range = srcRangeOf(el)
      return Array.from({ length: handle.count }, (_, k) => ({
        kind: "chart", el, handle, k, srcRange: range,
      }))
    } catch (error) {
      issues.push(`steppers 钩子异常（按整块一步处理）：${error?.message ?? error}`)
      break
    }
  }
  return null
}

/** 一个内容块 → 步（列表 / 表格 / 分栏展开；其余先问钩子，再整块一步）。 */
function stepsOfBlock(el, steppers, issues) {
  const steps = baseStepsOfBlock(el, steppers, issues)
  // 可激活元素（宿主契约，如 exec 桥的 ▶/⏩）各成一步，附在所属块的最后一步之后：
  // 翻页笔逐元素讲完代码块，再翻一下"落到"按钮上（md2s-step-current 高亮），
  // Enter 即运行（player.activate 命中当前步）。按钮未轮到时 visibility:hidden——
  // 先见代码、再见按钮浮现，渐进语义与揭示机制同构。
  for (const btn of el.querySelectorAll?.("[data-md2s-activatable]") ?? []) {
    steps.push({ kind: "activatable", el: btn, srcRange: srcRangeOf(btn) ?? srcRangeOf(el) })
  }
  return steps
}

/** 基本步（不含可激活元素）：列表 / 表格 / 分栏展开；其余先问钩子，再整块一步。 */
function baseStepsOfBlock(el, steppers, issues) {
  const range = srcRangeOf(el)

  // 列表：每项一步。嵌套列表是 li 的子树——visibility 继承让父项出现时整体出现。
  if (el.tagName === "UL" || el.tagName === "OL") {
    const items = [...el.children].filter(c => c.tagName === "LI")
    if (items.length > 1) {
      return items.map(li => ({ kind: "item", el: li, srcRange: srcRangeOf(li) ?? range }))
    }
    return [{ kind: "block", el, srcRange: range }]
  }

  // 表格：先整张表一步（"看这张表"），再逐数据行走下去（2026-10-30 修订）。
  // 旧方案是"表头跟首行同一步"（thead 当 extra 挂在首行步上）——一步同时点亮两个框：
  // thead 的框和首行的框紧紧贴在一起还互相交叉，看着像描边画重了，讲的时候也分不清
  // 到底框的是谁。改成两级后一步恒只有一个框：整表步的表框把表头一并包进去，
  // 之后每一步才是一个行框。element 揭示态同样受益——整表步进来的是"表框 + 表头
  // （数据行 visibility:hidden 占位）"，然后一行一行浮出来；版面依旧冻结。
  if (el.tagName === "TABLE") {
    const body = el.querySelector("tbody") ?? el
    const rows = [...body.children].filter(c => c.tagName === "TR")
    if (rows.length > 1) {
      return [
        { kind: "table", el, srcRange: range },
        ...rows.map(tr => ({ kind: "row", el: tr, srcRange: srcRangeOf(tr) ?? range })),
      ]
    }
    return [{ kind: "block", el, srcRange: range }]
  }

  // 分栏：递归每栏，栏内列表也逐步（2026-10-25 拍板）。
  if (isCols(el)) {
    const cols = [...el.children].filter(c => c.classList?.contains("col"))
    const out = []
    for (const col of cols) {
      for (const child of col.children) {
        if (!isFixed(child)) out.push(...stepsOfBlock(child, steppers, issues))
      }
    }
    return out.length ? out : [{ kind: "block", el, srcRange: range }]
  }

  const chart = chartSteps(el, steppers, issues)
  if (chart) return chart
  return [{ kind: "block", el, srcRange: range }]
}

/**
 * @param {Element} section 一页（section[data-slide]）
 * @param {object} [opts] { steppers, issues }  issues：钩子异常收集数组（可缺省）
 * @returns {Array<{kind: string, el: Element, extra?: Element[], handle?: object,
 *                   k?: number, srcRange?: [number, number]}>}
 */
function buildStepPlan(section, opts = {}) {
  const issues = opts.issues ?? []
  // 封面（div.cover 由引擎生成）：整页锚点，没有步
  if (section.querySelector?.(":scope > .cover")) return []
  // 章节目录页（toc.js）：整页一次出现（2026-10-30 拍板）。目录的作用是"一眼看到
  // 我们在哪"，逐条蹦出来不是导航是干扰；它也不是作者内容，不该被逐步审议。
  if (isTocSlide(section)) return []
  const out = []
  for (const el of section.children) {
    if (isFixed(el)) continue
    if (isHeading(el)) continue
    out.push(...stepsOfBlock(el, opts.steppers, issues))
  }
  return out
}

module.exports = { buildStepPlan }
