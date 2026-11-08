"use strict"

/**
 * answers.js — 答案归一（SPEC §2.1）。
 *
 * 归一目标统一为「讲义书写顺序的 0 基序号」：
 *   single：字母 A–F（忽略大小写）或 0 基序号 → 整数
 *   multi ：字母串 "AC" → 0 基序号数组（判集合相等，顺序无关）
 *   fill  ：文本原样（trim，调用方精确匹配）
 *   essay ：可省（人工批改）
 *
 * 认不出返回 null——宁可发布门报「没设答案」，也不能猜错把分判反。
 * 0 基承 md2slides core/quiz/parse.js（抢答态已验证）；`answer` 永远指
 * 书写顺序，与选项乱序无关（SPEC §2.4：显示字母按当前顺序生成）。
 */

/**
 * @param {string|number|null} value answer 原文
 * @param {"single"|"multi"|"fill"|"essay"} [type] 题型（缺省按 single 处理）
 * @returns {number|number[]|string|null}
 */
function normalizeAnswer(value, type = "single") {
  if (value == null) return null
  if (type === "fill") return String(value).trim()
  if (type === "essay") return value == null ? null : String(value).trim() || null

  if (type === "multi") {
    const text = String(value).trim().toUpperCase()
    if (!/^[A-F]+$/.test(text)) return null
    return [...text].map(ch => ch.charCodeAt(0) - 65)
  }

  // single：字母或 0 基序号
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  const text = String(value).trim()
  if (/^[A-Fa-f]$/.test(text)) return text.toUpperCase().charCodeAt(0) - 65
  if (/^\d+$/.test(text)) return Number(text)
  return null
}

module.exports = { normalizeAnswer }
