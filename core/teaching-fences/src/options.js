"use strict"

/**
 * options.js — 选项行的两个原语：手打字母前缀剥除、位置依赖检测（SPEC §2.2/§2.4）。
 *
 * 前缀是纯展示：`A.` `A、` `A)` `(A)` 解析时剥除，显示字母按当前顺序生成，
 * `answer` 永远指讲义书写顺序——这是选项乱序（ADR-17）能「教师零编写」的前提。
 *
 * 位置依赖检测喂给 W1 提示（不拒发）：选项文字引用了字母或位置
 * （「以上都对」「A 和 B」）的题，乱序后会自相矛盾，教师该用 `shuffle=no`。
 */

/** 手打字母前缀：`A.` `A、` `A)` `A）` `(A)` `(A、`…（A–F，忽略大小写）。 */
const RE_PREFIX = /^\(?([A-Fa-f])[.、)）]\s*/

/**
 * @param {string} text 选项文字（列表标记已剥）
 * @returns {{text: string, letter: string|null}} letter = 剥掉的手打字母（大写）
 */
function stripOptionPrefix(text) {
  const raw = String(text ?? "")
  const m = RE_PREFIX.exec(raw)
  if (!m) return { text: raw.trim(), letter: null }
  // 前缀剥掉后不能剩个空选项（"A." 单独一行是笔误不是选项）
  const rest = raw.slice(m[0].length).trim()
  if (!rest) return { text: raw.trim(), letter: null }
  return { text: rest, letter: m[1].toUpperCase() }
}

/** 位置/字母依赖的信号词与模式（窄匹配：宁可漏报也不冤枉正常选项）。 */
const DEPENDENT_PHRASES = ["以上都", "以上都不", "以上均是", "以上均不是", "都不对", "都对"]
const RE_LETTER_REF = /(?:^|[\s（(（,，、])[(]?([A-Fa-f])[)）]?[和与或、]\s*[(]?([A-Fa-f])[)）]?(?:[\s）),，。]|$)/

/**
 * @param {string[]} optionTexts 选项文字数组（剥前缀后的）
 * @returns {boolean} true = 疑似位置依赖，开乱序前应提示 shuffle=no
 */
function hasPositionDependency(optionTexts) {
  const joined = optionTexts.join("\n")
  if (DEPENDENT_PHRASES.some(p => joined.includes(p))) return true
  return RE_LETTER_REF.test(joined)
}

module.exports = { stripOptionPrefix, hasPositionDependency }
