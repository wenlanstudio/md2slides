"use strict"
/**
 * check.js — IR 的验收闸门。
 *
 * 模板路线把"排版美观"交给了 PowerPoint，但"内容准确性"必须在抽取这一步就锁死，
 * 而且要让机器来判，不能靠眼睛。这里做两件事：
 *   1. 逐页文本等价：IR 里所有文字（含代码块、表格、活组件、未识别元素）拼起来，
 *      必须与该页 DOM 的文本完全一致 —— 少一个字就是抽取漏了东西；
 *   2. 几何不越界：每个块都落在归一化画布内，且尺寸为正 —— 越界说明测量或换算错了。
 *
 * 这两条是 P0 的硬门槛，sidecar 那侧还会再比对一次成品 PPTX 与 IR。
 */

const { beginMeasure, endMeasure, sectionsOf } = require("../../core/section")
const { RASTER_ATTR, MATH_ATTR } = require("./ir")

const EPS = 0.01 // 英寸容差：只吸收四舍五入，不吸收真实越界

const collapse = text => (text ?? "").replace(/\s+/g, " ").trim()

/**
 * 比较用的归一化：去掉全部空白。
 * 不是偷懒——DOM 的 textContent 在块与块之间不插任何分隔符，而 IR 是按块拼起来的，
 * 只要两边都保留空白就会因"多一个空格"误报。去掉空白后仍保序，漏字、多字、乱序照样抓得到。
 */
const strip = text => (text ?? "").replace(/\s+/g, "")

function runsText(runs) {
  // 公式不进文本比对：它去了 OMML 树（Office 原生公式），既不是"丢了字"，
  // 也不能拿 LaTeX 源码或排版字符去比——两边口径根本不同（见 ir.js 的 MATH_ATTR）。
  return (runs ?? []).map(run => (run.br ? "\n" : run.math ? "" : run.text ?? "")).join("")
}

/** IR 里一页的全部文字，按块类型还原 */
function blockText(block) {
  switch (block?.type) {
    case "heading":
    case "paragraph":
      return runsText(block.runs)
    case "list":
      return (block.items ?? []).map(item => runsText(item.runs)).join(" ")
    case "code":
      return (block.lines ?? []).map(runsText).join("\n")
    case "table":
      return (block.rows ?? []).map(row => (row.cells ?? []).map(cell => runsText(cell.runs)).join(" ")).join(" ")
    case "custom":
    case "unknown":
      return block.text ?? ""
    case "math":
      return ""   // 公式走 OMML，不进文本比对（理由见 runsText）
    default:
      return ""
  }
}

const slideText = slide => (slide?.blocks ?? []).map(blockText).filter(Boolean).join(" ")

/**
 * DOM 侧的同口径文本。剥掉三类子树：
 *   · 宿主插件 UI（opts.skipSelector 指到的编辑器按钮之类）；
 *   · 被整块栅格成图片的子树（data-md2s-raster）——那些字已经画进图片里了，
 *     不是内容丢失，不该算进文本比对；
 *   · 公式（data-md2s-math）——它变成 OMML 去了，DOM 里那点文字是 MathML 的
 *     字符 + LaTeX 源码 + 排版字符三份叠在一起，拿它比对必然误报。
 */
function domText(section, skipSelector = "") {
  if (!section?.cloneNode) return ""
  const clone = section.cloneNode(true)
  const skip = skipSelector ? `${skipSelector},` : ""
  // 宿主 UI 是可选的前缀，栅格与公式是无条件的
  for (const el of clone.querySelectorAll(`${skip}[${RASTER_ATTR}],[${MATH_ATTR}]`)) el.remove()
  return clone.textContent ?? ""
}

function checkGeometry(slide, canvas, issues) {
  const within = (label, geo) => {
    if (!geo) return
    if (geo.w <= 0 || geo.h <= 0) {
      issues.push(`第 ${slide.index + 1} 页：${label} 尺寸非正（${geo.w}×${geo.h} in）`)
      return
    }
    if (geo.x < -EPS || geo.y < -EPS || geo.x + geo.w > canvas.widthIn + EPS || geo.y + geo.h > canvas.heightIn + EPS) {
      issues.push(
        `第 ${slide.index + 1} 页：${label} 越界 ` +
          `(x=${geo.x}, y=${geo.y}, w=${geo.w}, h=${geo.h}；画布 ${canvas.widthIn}×${canvas.heightIn})`,
      )
    }
  }
  for (const block of slide.blocks) within(block.type, block.geo)
}

/**
 * @param {Document} doc deck 所在文档
 * @param {object} ir extractIr 的产物
 * @param {object} [opts] { skipSelector } 与 extractIr 同款的宿主 UI 豁免选择器
 * @returns {{ issues: string[], stats: object }}
 */
function checkIr(doc, ir, opts = {}) {
  const issues = []
  const sections = sectionsOf(doc)
  const canvas = ir?.canvas

  beginMeasure(doc, canvas?.pxWidth, canvas?.pxHeight)
  try {
    for (const slide of ir?.slides ?? []) {
      const expected = domText(sections[slide.index], opts.skipSelector ?? "")
      const actual = slideText(slide)
      if (strip(expected) !== strip(actual)) {
        issues.push(
          `第 ${slide.index + 1} 页文本不一致\n  DOM: ${collapse(expected).slice(0, 200)}\n  IR : ${collapse(actual).slice(0, 200)}`,
        )
      }
      checkGeometry(slide, canvas, issues)
      for (const block of slide.blocks ?? []) {
        if (block.type === "image" && !block.src) issues.push(`第 ${slide.index + 1} 页：图片未落盘（几何 ${JSON.stringify(block.geo)}）`)
      }
    }
  } catch (error) {
    issues.push(`校验过程异常：${error?.message ?? error}`)
  } finally {
    endMeasure(doc)
    // 抽取时打的标记用完即清，live deck 保持原样
    for (const el of doc.querySelectorAll?.(`[${RASTER_ATTR}]`) ?? []) el.removeAttribute(RASTER_ATTR)
    for (const el of doc.querySelectorAll?.(`[${MATH_ATTR}]`) ?? []) el.removeAttribute(MATH_ATTR)
  }

  const mediaWarnings = ir?.media?.warnings ?? []
  for (const warning of mediaWarnings) issues.push(warning)

  const blocks = (ir?.slides ?? []).reduce((sum, s) => sum + (s.blocks?.length ?? 0), 0)
  const byType = {}
  for (const slide of ir?.slides ?? []) {
    for (const block of slide.blocks ?? []) byType[block.type] = (byType[block.type] ?? 0) + 1
  }
  return { issues, stats: { slides: ir?.slides?.length ?? 0, blocks, byType } }
}

module.exports = { checkIr, slideText, blockText }
