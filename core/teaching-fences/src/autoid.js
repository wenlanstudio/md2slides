"use strict"

/**
 * autoid.js — quiz 缺省 id 的内容寻址（SPEC §一.3 修订 / 总纲 ADR-26）。
 *
 * 为什么放弃位置自动编号（q1/q2…）：插入一题全体错位——发布后题库身份漂移
 * 会让成绩追溯指错行，多份讲义还互相撞车（course 级 question_key 唯一，
 * QUESTION-BANK §3）。内容寻址的语义：题面相同 ⇒ 同一身份（跨讲义天然走
 * 查重复用路径），题面变了 ⇒ 新身份（旧题 retired 留痕）。显式 id 仍最优先
 * ——教师起名的身份跨内容修改不变（走 diff 对齐 version+1）。
 *
 * 为什么不用 node:crypto：本模块跑在浏览器侧（muya/renderer/deck 沙箱没有
 * node 内置模块），双道 FNV-1a 拼出 48 位指纹即可——一门课几百道题的量级
 * 下碰撞概率可忽略；真撞上也有 QUESTION_KEY_CONFLICT 的可读错误兜底。
 *
 * 指纹输入 = type + stem + 选项文本（题面主体）。刻意不含 answer/point：
 * 改答案/调分值是同一道题的修订（题库 version+1），不该换身份——与显式 id
 * 题的版本语义对齐。
 */

/** FNV-1a 32 位：标准偏移基与质数各用一份，双道降低构造碰撞面。 */
const SEED_A = 0x811c9dc5
const SEED_B = 0x01000193

function fnv1a(text, seed) {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/**
 * @param {{type: string, stem: string, options: Array<{text: string}>}} quiz
 *   题面主体已组装完的 quiz 记录（scan/collectQuiz 调用）。
 * @returns {string} `q-` + 12 位十六进制（A 道 32 位 + B 道 16 位）
 */
function autoQuizId(quiz) {
  const basis = [quiz.type ?? "", quiz.stem ?? ""]
    .concat((quiz.options ?? []).map(o => String(o?.text ?? "")))
    .join("\u0000")
  const hex = (n, width) => (n >>> 0).toString(16).padStart(width, "0")
  const hi = fnv1a(basis, SEED_A)
  const lo = fnv1a(`${basis}\u0001`, SEED_B)
  return `q-${hex(hi, 8)}${hex(lo & 0xffff, 4)}`
}

module.exports = { autoQuizId }
