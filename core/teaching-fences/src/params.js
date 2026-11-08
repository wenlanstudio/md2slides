"use strict"

/**
 * params.js — 教学指令的参数双形式（SPEC §一.2）。
 *
 * JSON 完整版优先（值含空格/复杂结构时用），非法退回 `key=val` 简写；
 * 两者都读不出返回 null——调用方必须把标记**原样保留**并报 problem，
 * 不静默吞笔误（发布门哲学：进成绩册的东西宁拒不猜）。
 *
 * 惯例承 md2slides core/quiz/parse.js（quiz 抢答态已验证的实现），
 * 键统一小写：kv 简写本就无大小写约定，JSON 版写错大小写也照读。
 */

/**
 * @param {string} raw 标记体内（动词之后）的原文
 * @returns {Object<string, string>|null} 键值对（值一律字符串）；null = 完全读不出
 */
function parseParams(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return {}

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = {}
        for (const [k, v] of Object.entries(parsed)) obj[k.toLowerCase()] = String(v)
        return obj
      }
    } catch { /* 退回简写 */ }
  }

  const obj = {}
  // key=val：值可带引号（引号内空格合法），裸值不含空格——带空格请用 JSON
  const re = /([A-Za-z][\w-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g
  let m
  while ((m = re.exec(text))) obj[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "")
  if (!Object.keys(obj).length) return null
  return obj
}

/** 宽松取整：数字字符串/数字 → 整数；读不出返回 null（由调用方定默认或报错）。 */
function toInt(value) {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

module.exports = { parseParams, toInt }
