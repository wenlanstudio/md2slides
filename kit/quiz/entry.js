"use strict"

/**
 * quiz/entry.js — 课堂竞答能力的**浏览器侧打包入口**。
 *
 * 存在的理由：kit/quiz 的三个模块是普通 CommonJS 源码，既要能被 Typora 宿主壳的
 * bundle 收进去（node-entry.js），也要能被独立 HTML 放映器内联进一个自包含页面
 * （tools/export-html.js）。后者不能复用主 bundle——那个 bundle 里塞的是整条渲染
 * 管线，独立 HTML 只要竞答这三件套。
 *
 * 这里只做转发，与 node-entry.js 同一个思路：入口薄，逻辑在模块里。
 */

const { createQuizClient, DEFAULT_URL } = require("./client")
const { mountQuizPanel, QUIZ_CSS } = require("./panel")
const { readQuizzes, parseQuizMeta, registerQuiz } = require("../../core/quiz/parse")

module.exports = {
  createQuizClient,
  mountQuizPanel,
  readQuizzes,
  parseQuizMeta,
  registerQuiz,
  QUIZ_CSS,
  DEFAULT_URL,
}
