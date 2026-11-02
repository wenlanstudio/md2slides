"use strict"

/**
 * splitSemicolons.js — turn a paragraph of semicolon-joined parallel phrases into a list.
 *
 * Why: a run like `AAA；BBB。` or `AAA；BBB；CCC。` reads as one wall of text on a slide, but the
 * phrases are really a list. Rendered as `<ul><li>`, it becomes a *core* block (see
 * overflow.js `coreTypeOf`) — so it gets the nicer per-item focus and, if it ever overruns
 * the slide, the list splitter can page it item by item instead of slicing the paragraph
 * blindly. 接线点：compose（renderMarkdown 之前），front-matter `semicolons: false` 可关。
 *
 * Guard rails (this must NOT fire on ordinary prose):
 *  - only plain paragraph lines — headings, list items and fenced code are skipped;
 *  - the delimiter is the FULL-WIDTH semicolon `；` only (a half-width `;` in English would turn
 *    "do a; b." into a list, which is almost never intended);
 *  - the line must be exactly "phrase；phrase；…phrase。" — every phrase but the last carries NO
 *    sentence-ending punctuation, and the last one ENDS with one. A paragraph made of several
 *    real sentences ("今天晴。我们去公园。") has periods in the middle and is left alone.
 */

const RE_FENCE = /^\s*(```|~~~)/
const RE_HEADING = /^(#{1,6})\s/
const RE_LIST = /^\s*([-*+]|\d+[.)])\s/
const RE_SENT_END = /[。.!?！？]+$/
const RE_SENT_ANY = /[。.!?！？]/
const DELIM = "；"
// A semicolon join is "listing" only when every phrase is a short noun-ish chunk. A comma/、
// inside a phrase means it is prose rhythm (e.g. "用户阳，AI阴；互济不盲从，制衡不妥协。"),
// and an over-long phrase is a clause, not an item — both must stay a paragraph.
const RE_COMMA = /[，、]/
const MAX_PHRASE = 15

const toListLine = line => {
  const t = line.trim()
  if (!t.includes(DELIM)) return null

  const parts = t.split(DELIM).map(s => s.trim())
  if (parts.length < 2) return null

  // 引导语：首个分号前的片段若含冒号，则「冒号及之前」是引导行、「冒号之后」才是列表首项。
  // 「优点包括：稳定；高效；易用。」→ 引导「优点包括：」+ 列表[稳定, 高效, 易用]，而非把
  // 「优点包括：稳定」当成第一项（用户反馈：引导语不应进列表）。
  let lead = null
  const cm = parts[0].match(/(.+[：:])(\S.*)$/)
  if (cm) { lead = cm[1]; parts[0] = cm[2] }

  // The final phrase must close with a sentence-ending mark, but NO phrase may carry one
  // anywhere inside it (otherwise this is several real sentences, not parallel phrases —
  // e.g. "这是一句...句子。今天去公园；明天去爬山。" must stay a paragraph).
  const last = parts[parts.length - 1]
  if (!RE_SENT_END.test(last)) return null
  for (let i = 0; i < parts.length - 1; i++) {
    if (RE_SENT_ANY.test(parts[i])) return null
  }
  // Listing items are short and comma-free; a long or comma'd phrase is prose, not a list.
  for (const p of parts) {
    if (p.length > MAX_PHRASE || RE_COMMA.test(p)) return null
  }

  parts[parts.length - 1] = last.replace(RE_SENT_END, "")
  if (parts.some(p => !p)) return null
  const list = parts.map(p => "- " + p).join("\n")
  return lead ? lead + "\n" + list : list
}

/**
 * @param {string} text md 源文本
 * @returns {{ text: string, count: number }} count = 转成列表的段落数
 */
const splitSemicolons = text => {
  const lines = String(text ?? "").split(/\r?\n/)
  const out = []
  let inFence = false
  let count = 0
  for (const line of lines) {
    if (RE_FENCE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || RE_HEADING.test(line) || RE_LIST.test(line)) {
      out.push(line)
      continue
    }
    const list = toListLine(line)
    if (list != null) count += 1
    out.push(list ?? line)
  }
  return { text: out.join("\n"), count }
}

module.exports = { splitSemicolons, toListLine }
