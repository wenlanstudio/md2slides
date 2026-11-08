"use strict"

/**
 * command.js — 注释标记行的识别与拆解（注释标记族，SPEC §一.1）。
 *
 * 标记必须独占一行（缩进 ≤3 空格，与 md2slides 分栏注释同规矩）：
 *   <!--quiz id=q1 answer=B point=3-->
 *
 * 只做「认出来 + 拆出动词与参数体」；动词白名单判断交给调用方——文档里
 * 大量普通注释（分栏标记、TODO）不是教学指令，不能在这里误伤。
 */

/** 独占一行的注释标记（≤3 空格缩进）。捕获组：1 动词、2 参数体。 */
const RE_MARK = /^\s{0,3}<!--\s*([A-Za-z][\w-]*)\b([^>]*?)\s*-->\s*$/

/**
 * @param {string} line 单行文本
 * @returns {{verb: string, paramsRaw: string}|null} null = 不是注释标记行
 */
function parseCommand(line) {
  const m = RE_MARK.exec(String(line ?? ""))
  if (!m) return null
  return { verb: m[1].toLowerCase(), paramsRaw: m[2] }
}

module.exports = { parseCommand, RE_MARK }
