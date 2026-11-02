"use strict"

/**
 * index.js — md2slides 的公开 API 面（库入口，P-1 库化）。
 *
 * 契约文档：docs/API.md（签名、运行环境矩阵、宿主钩子、版本承诺）；
 * 验收用例：docs/integration-marktext.md（纸面消费者——一个宿主把 md 变成
 * 幻灯片视图的完整调用序列，每一步都必须能对到这里转发的出口）。
 *
 * 这里只做「转发 + 冻结」，不放任何逻辑。分层原则不变：core/ 不知道编辑器的存在；
 * 宿主专属能力（图表渲染器、Electron、fs）一律经 opts 钩子注入，本文件永不 require
 * host/ 下的任何东西。
 *
 * 子路径（require("@wenlanstudio/md2slides/core/xxx.js")，注意带 .js 后缀）可以用，但没有兼容
 * 承诺——内部模块随时按 IR_v3 计划重构（overflow.js → plan/planner 等）。
 * 只有本文件转发的出口受 semver 保护。
 */

const { compose, DECK_DEFAULTS } = require("./core/compose")
const {
  renderDiagrams,
  assertDiagramsRendered,
  DiagramError,
} = require("./core/render/diagramHost")
const { splitOverflow, CONT_CSS, CONT_CLASS } = require("./core/paginate/overflow")
const { TOC_CSS } = require("./core/paginate/toc")
const { highlightCode } = require("./core/render/highlight")
const { extractIr, IR_VERSION } = require("./export/pptx/ir")
const { checkIr } = require("./export/pptx/check")
const { createDeckPlayer, TAP_IGNORE } = require("./kit/player")
const {
  sectionsOf,
  beginMeasure,
  endMeasure,
  SLIDE_SELECTOR,
} = require("./core/section")

module.exports = {
  // —— 管线五入口（时序：compose → renderDiagrams → splitOverflow → highlightCode → extractIr）——
  compose,          // md → { html, css, doc, meta, slideWidth/Height, … }（Node 传 jsdom document）
  renderDiagrams,   // 图表预通行：core 调度、宿主出图（renderDiagram 钩子）；必须在实测分页之前
  splitOverflow,    // 物理分页：真实布局引擎里跑，返回新增页数（反复调到返回 0）
  highlightCode,    // 代码染色（幂等）：splitOverflow 切块会丢 span，分页后必须重染一次
  extractIr,        // DOM → Slide IR（version 1 契约，export/pptx/ir.schema.json）

  // —— 校验闸门 ——
  checkIr,               // IR 验收：逐页文本等价 + 几何不越界（出 PPTX 前调，issues 非空即拒）
  assertDiagramsRendered,// 图表兜底：预通行全部跑完后必须零残留，否则抛 DiagramError

  // —— 播放器（kit 层）——
  // 框架无关的一页一屏视图：缩放适配容器 + 键盘翻页 + 页码状态；UI 归宿主。
  createDeckPlayer,
  // 触屏轻点的默认禁区（按钮 / 链接 / 图片 / 可激活元素…）：宿主可据此追加自己的面板。
  TAP_IGNORE,

  // —— 页容器契约（播放器 / 自建测量宿主用）——
  // 「这一页在哪」的全部知识 = sectionsOf(doc)；SLIDE_SELECTOR 是页容器选择器唯一出处。
  sectionsOf,
  SLIDE_SELECTOR,
  beginMeasure,     // 要量幻灯片先走这对：摊开所有页并钉到画布尺寸（进 / 出成对调用）
  endMeasure,

  // —— 类型与常量 ——
  DiagramError,     // 图表硬失败（缺钩子 / 空产出 / 渲染抛错），可 instanceof
  DECK_DEFAULTS,    // { headingDivider: 3, theme: "lecture" }
  IR_VERSION,       // IR 契约版本（当前 1；v3 落地时消费者按 ir.version 分流）
  CONT_CSS,         // 续页标记（「（续）」）的样式：宿主必须拼进自己的 deck CSS
  CONT_CLASS,       // 续页标记的 class 名
  TOC_CSS,          // 章节目录页的兜底样式（同 CONT_CSS；主题里的那份优先）
}
