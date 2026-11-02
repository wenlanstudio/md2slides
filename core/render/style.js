"use strict"
/**
 * style.js — compose 拼进 deck CSS 的引擎侧规则。
 *
 * 主题 CSS 之外，引擎还有几条自己的排版规则（目前只有代码换行）。单独成模块而不是
 * 内联在 compose 里，是因为它们跟着引擎版本走、不跟主题走：宿主换主题不该影响它们。
 */

/**
 * Keep an over-long code line readable instead of letting the block be shrunk as a whole.
 * The font size itself is left to the theme.
 *
 * 两条规则对应两个层级：`pre` 自身与它里面的 `code` 都要声明——后者才是文字的直接
 * 容器，漏了它换行设置到不了正文。
 */
const codeCss = enabled => {
  if (!enabled) return ""
  return [
    "section pre { white-space: pre-wrap; overflow-wrap: anywhere; }",
    "section pre > code { white-space: pre-wrap; overflow-wrap: anywhere; }",
  ].join("\n")
}

module.exports = { codeCss }
