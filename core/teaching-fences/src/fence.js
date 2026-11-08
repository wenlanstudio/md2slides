"use strict"

/**
 * fence.js — 载荷围栏 info-string 的拆解（围栏族，SPEC §一.1/§三.4）。
 *
 * info-string 语法承 mdcode2run FENCE.md：`lang key=val`，值含空格加引号，
 * 未知 key= 记 problem。首词是动词（check-code / match-output / sql-result），
 * 其余是参数；块体即载荷（参考代码 / 期望输出 / 参考 SQL），由调用方取出。
 */

/**
 * @param {string} info 围栏开行 ``` 之后的部分
 * @returns {{verb: string, params: Object<string, string>|null}|null}
 *   null = 空 info-string（普通代码块）；params null = 参数体读不出
 */
function parseFenceInfo(info) {
  const text = String(info ?? "").trim()
  if (!text) return null
  const verb = text.split(/\s+/)[0].toLowerCase()
  const { parseParams } = require("./params")
  return { verb, params: parseParams(text.slice(verb.length)) }
}

module.exports = { parseFenceInfo }
