"use strict"
// layout-core.js — 分页决策内核（纯函数，零 DOM 依赖）。view-model §5 / M4.1。
//
// 为什么抽它：`overflow.js` 的分页 = 量测（DOM）→ 决策（纯逻辑）→ 动刀（DOM）
// 的修复环。决策层——切点算术、孤行回退、单元装配、策略阈值——是 deck 与
// marktext 纸叶（Word 式 A4 分页）真正要**共用**的那一半：双端各自量 DOM，
// 各自动刀，中间只共享这份内核（"复用算法不复用进程"，view-model §5）。
// 每个函数头注明它在 overflow.js 的出处（移植评审可溯）；语义与阈值逐行
// 保真，deck 侧行为由 npm test 的浏览器回归 + 截图像素基线锁死。
//
// 输入约定：所有高度/坐标都是"调用方测量空间的数"——本模块不做任何单位
// 换算，px 与否、含否 zoom，全由调用方的量测口径决定（两端各自一致即可）。

/**
 * 策略封闭集（view-model §5：抽包时须全参数化，deck 侧快照回归锁行为）。
 * 每项 = overflow.js 里的现行字面量，出处随注释；改这里 = 改两端行为，
 * 必须同时过两端的回归。
 */
const STRATEGY = Object.freeze({
  /** 孤行回退阈值（overflow.js WIDOW_FILL）：尾部内容不足页高此比例时，
   *  向前回退文档流单元，避免续页只挂一条尾巴。 */
  widowFill: 0.35,
  /** 核心另起一页阈值（overflow.js CORE_BREAK_FILL）：核心前面的内容占页高
   *  不足此比例时，不为它另起一页（否则原页近乎空白、新页顶「（续）」题）。 */
  coreBreakFill: 0.25,
  /** 目录页切割的 room 收紧量 px（overflow.js TOC_ROOM_SLACK）：按 li 底边
   *  切与本函数溢出判据（含 margin）的口径差，不收紧会切出"差几像素仍溢出"
   *  的页，卡在缝里。 */
  tocRoomSlack: 12,
  /** 原位缩字号下限 px（overflow.js shrinkTextToFit 的 floor，1920 画布）。 */
  textShrinkFloor: 8,
  /** 裸页媒体缩放的最多轮数（overflow.js spillToBarePage）。 */
  mediaFitRounds: 4,
  /** 裸页媒体缩放每轮的盒高收缩系数（overflow.js spillToBarePage）。 */
  mediaFitShrink: 0.95,
  /** splitOverflow 外层 pass 上限（overflow.js opts.maxPasses 缺省）。 */
  maxPasses: 4,
  /** 预算系数（overflow.js opts.margin 缺省；测试钩子用 >1 放宽页高）。 */
  margin: 1,
  /** 续页是否重复标题（overflow.js opts.repeatHeading 缺省）。 */
  repeatHeading: true,
  /** 段落切行的孤儿下限（行）——页底至少留这么多行（CSS orphans 缺省 2，
   *  view-model §5 v2「widow/orphan ≥ 2」）。 */
  orphanLines: 2,
  /** 段落切行的寡行下限（行）——续页顶至少带这么多行（CSS widows 缺省 2）。 */
  widowLines: 2,
})

/** 标题判定（overflow.js isHeading 的标签层）。 */
const isHeadingTag = tag => /^H[1-6]$/.test(tag)

/** 引语只能是段落；结束语可以是段落、引用、脚注（overflow.js，PAGINATION.md §3）。 */
const canBeIntroTag = tag => tag === "P"
const canBeOutroTag = tag => tag === "P" || tag === "BLOCKQUOTE"

/**
 * 中心内容分类（overflow.js coreTypeOf 的纯层）。
 * `desc` = { tag, soleImg, katexDisplay }——DOM 侧由 overflow.js describeBlock
 * 生成（标签、p 是否只含一张图、是否 KaTeX 块级公式）。
 * 返回 null 表示"不是核心"——那它属于文档流、引语或结束语。
 * 陷阱（原注释保真）：markdown 里独立成行的图片渲染成 `<p><img></p>`，
 * "只含一张图、没有文字"的段落必须判成图片核心，否则会被当成引语。
 */
const classifyCore = desc => {
  switch (desc.tag) {
    case "PRE": return "code"
    case "TABLE": return "table"
    case "UL": case "OL": return "list"
    case "IMG": case "FIGURE": return "image"
    default: break
  }
  if (desc.tag === "P" && desc.soleImg) return "image"
  // 单行公式：渲染产物带 katex 类。认不出就当普通段落，保守回退到文档流。
  if (desc.katexDisplay) return "math"
  return null
}

/**
 * 装配"中心内容"（overflow.js coreUnits 的移植；PAGINATION.md §3）：
 * 引语 + 核心 + 结束语是一体的，其余是走文档流的其他段落。
 *
 * 歧义规则（紧贴核心的"唯一"块只能属于一方）：
 *   - 引用/脚注不当下一个核心的引语（引语必须是段落），所以优先归前一个核心当结束语；
 *   - 夹在两个核心之间的段落，归**后面**那个核心当引语。
 *
 * `descs[i]` = describeBlock 的原始描述子 { tag, soleImg, katexDisplay }——
 * 分类在本函数内部完成（classifyCore），调用方不给分类留错位的机会。
 * 返回 { role, type, core, intro, outro, start, end }[]，索引指向 descs；
 * intro/outro 为 -1 表示这一侧没有。
 */
const assembleUnits = descs => {
  const units = []
  let i = 0
  while (i < descs.length) {
    const type = classifyCore(descs[i])
    if (!type) {
      units.push({ role: "flow", type: null, core: -1, intro: -1, outro: -1, start: i, end: i })
      i += 1
      continue
    }
    const core = i
    // 引语：紧贴核心的唯一段落。它刚被当成了文档流，这里把它回吸回来。
    // 只认 role === "flow" 的前驱——若前驱本身是核心单元，说明那一块是上个核心的结束语，不能抢。
    let intro = -1
    const prev = units[units.length - 1]
    if (prev && prev.role === "flow" && prev.end === i - 1 && canBeIntroTag(descs[i - 1].tag)) {
      intro = i - 1
      units.pop()
    }
    const nextIsNextIntro = i + 2 < descs.length && !!classifyCore(descs[i + 2])
    const outro = i + 1 < descs.length && canBeOutroTag(descs[i + 1].tag) && !nextIsNextIntro ? i + 1 : -1
    units.push({
      role: "core", type, core, intro, outro,
      start: intro >= 0 ? intro : core,
      end: outro >= 0 ? outro : core,
    })
    i = (outro >= 0 ? outro : core) + 1
  }
  return units
}

/**
 * 顺序计数：前缀高度之和不超过 room 的最多项数（overflow.js splitTable 的
 * 切行循环）。返回值即"本页留下的行数"——0 = 连一行都放不下，length = 全放
 * 得下（无续行），调用方按各自语义校验。
 */
const countFittingPrefix = (heights, room) => {
  let count = 0
  let acc = 0
  for (const h of heights) {
    if (acc + h > room) break
    acc += h
    count += 1
  }
  return count
}

/**
 * 首个越界项的下标（overflow.js splitList / splitFirstItemInside 的切点循环）：
 * `bottoms` 为各项底边（调用方换算到与 limit 同一坐标系），返回第一个
 * bottom > limit 的下标；全部不越界返回 lengths（= 无续项，调用方校验）。
 */
const cutIndexByBottom = (bottoms, limit) => {
  for (let i = 0; i < bottoms.length; i++) {
    if (bottoms[i] > limit) return i
  }
  return bottoms.length
}

/**
 * 弹掉尾随空行（overflow.js splitCodeBlock）：闭合围栏会留一条空行，它不携带
 * 内容，切在它上面只会把空代码块甩给下一页。非变异，返回新数组。
 */
const trimTrailingBlankLines = lines => {
  const out = [...lines]
  while (out.length > 1 && out[out.length - 1].trim() === "") out.pop()
  return out
}

/**
 * 前缀二分（overflow.js splitCodeBlock 的主循环）：在 1..count 上找最大的
 * k 使 fits(k) 为真。`fits` 由调用方注入（换行让"行数 ↔ 视觉高"不可解析，
 * 只能逐次实测；两端各自注入自己的量测）。假定 fits(1) 已由调用方先行
 * 检查（一行都放不下 = 切分无从帮起，是独立分支）。
 */
const bisectMaxFit = (count, fits) => {
  let lo = 1
  let hi = count
  let best = 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (fits(mid)) { best = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return best
}

/**
 * 孤行回退（overflow.js splitSection 尾部的 widow 控制）：
 * 尾部内容不足页高 widowFill 时，把切点向前回退到更早的**文档流**单元——
 * 把前一个中心内容也拽过来会让一页出现两个核心，违反"每页最多一个"，
 * 所以只回退 role === "flow" 的单元。
 *
 * 判据必须是 `u < ui`（确实回退了才改切点）：写成 `u >= 1` 会在压根没回退时
 * 也执行赋值，把调用方算好的精确断点（引语/结束语独占）无条件冲掉——那正是
 * "规则没有主人"的病根（原注释保真）。
 *
 * `tops` 与单元索引同系（各单元首块的顶边），tailBottom = 末块底边。
 * 返回调整后的切点（units[u].start）；无需回退返回 null。
 */
const adjustForWidow = (units, tops, ui, tailBottom, budget, widowFill = STRATEGY.widowFill) => {
  let u = ui
  while (u > 0 && units[u - 1].role === "flow"
         && tailBottom - tops[units[u - 1].start] < budget * widowFill) u -= 1
  return u < ui ? units[u].start : null
}

/**
 * 核心另起一页的选靶（overflow.js enforceOneCorePerSlide 的扫描）：
 * 找第一个满足条件的核心单元——start > 0（前面还有内容）、前面除标题外
 * 有实内容（纯标题 → 不拆，标题本该带着它下面的内容）、且
 *   - 前一个单元也是核心（一页已塞两个，硬规则必须拆），或
 *   - 前面内容底边 ≥ avail × coreBreakFill（软阈值：不为少量正文另起一页）。
 * 软的不能压过硬的（原注释保真）。返回单元或 null。
 */
const selectCoreBreak = (
  units, descs, rowBottoms, avail, coreBreakFill = STRATEGY.coreBreakFill
) => {
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    if (u.role !== "core" || u.start === 0) continue
    let hasOwnContent = false
    for (let j = 0; j < u.start; j++) {
      if (!isHeadingTag(descs[j].tag)) { hasOwnContent = true; break }
    }
    if (!hasOwnContent) continue
    // 拆走这个单元后，原页剩下的内容底边——"原页还撑不撑得起来"。
    const used = rowBottoms[u.start - 1]
    const prevIsCore = i > 0 && units[i - 1].role === "core"
    if (avail > 0 && (prevIsCore || used >= avail * coreBreakFill)) return u
  }
  return null
}

/**
 * 段落切行策略（M4.2 新增——deck 现对段落只整搬/缩字号，这是 marktext 纸叶
 * v2「段落跨页切行」的主策略，双端共用的合同件；view-model §5 切页策略分级）。
 *
 * 语义镜像 Chromium 原生碎片化（打印链去掉块级 break-inside:avoid 后的行为，
 * 硬验收「屏显页数 = printToPDF 页数」由此逐条把关）：
 *   - orphans：页底至少留 orphanLines 行；widows：续页顶至少带 widowLines 行；
 *   - 切点先取容量上限 maxFit，再为 widows 收口（keep ≤ total − widowLines）；
 *   - 约束不可同时满足（段落行数 ≤ orphans+widows、或本页连 orphanLines 行
 *     都放不下）→ 整段推下页；整段连一整页都放不下 → 违规在容量处硬切
 *     （Chromium：不可避免时容忍违规——分页必须推进，不许死循环）。
 *
 * 返回：
 *   { kind: "fits" }                          全部放得下，无需切；
 *   { kind: "at", keep }                      本页留 keep 行，其余续页；
 *   { kind: "before" }                        整段推下页（本页一行不留）；
 *   { kind: "split-anyway", keep }            约束不可满足时的容量硬切。
 *
 * `room` = 段落顶部起的剩余空间；`pageRoom` = 一整页的内容高（判"整段推下页
 * 是否放得下"）。行高序列不含行间 margin（行盒之间没有 margin）。
 * 调用方须兜底：`before`/`keep === 0` 落在"整段连一页都放不下"的场合时，
 * 按各自的穿缝/跨页语义降级（本模块只报事实，不做降级）。
 */
const cutLinesFitting = (lineHeights, room, pageRoom, opts = {}) => {
  const orphansMin = opts.orphansMin ?? STRATEGY.orphanLines
  const widowsMin = opts.widowLines ?? STRATEGY.widowLines
  const total = lineHeights.length
  if (total === 0) return { kind: "fits" }
  const sum = lineHeights.reduce((a, b) => a + b, 0)
  if (sum <= room) return { kind: "fits" }

  const maxFit = countFittingPrefix(lineHeights, room)
  const maxKeep = total - widowsMin
  if (maxKeep >= orphansMin && maxFit >= orphansMin) {
    return { kind: "at", keep: Math.min(maxFit, maxKeep) }
  }
  if (sum <= pageRoom) return { kind: "before" }
  return { kind: "split-anyway", keep: Math.max(0, maxFit) }
}

module.exports = {
  STRATEGY,
  isHeadingTag,
  canBeIntroTag,
  canBeOutroTag,
  classifyCore,
  assembleUnits,
  countFittingPrefix,
  cutIndexByBottom,
  trimTrailingBlankLines,
  bisectMaxFit,
  adjustForWidow,
  selectCoreBreak,
  cutLinesFitting,
}
