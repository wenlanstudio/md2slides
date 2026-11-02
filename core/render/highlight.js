"use strict"

/**
 * highlight.js — 给代码块上色。
 *
 * 两件事必须说清楚，不然迟早踩：
 *
 * 1. **highlight.js 只切分，不上色**。它把代码切成 `.hljs-*` span，颜色来自 CSS
 *    （`core/themes/highlight.css`）。没有那份 CSS，加了 span 也是一片黑。
 *
 * 2. **必须在切页之后跑**。`overflow.js` 按行切代码块时会把 span 全部丢掉，
 *    所以高亮要等物理分页收敛后再补一次。好在它读的是 `code.textContent`（纯文本），
 *    幂等、可重复跑——这正是原链路"着色放在最后"的原因。
 *
 * 于是本模块被调两次：编排阶段（`compose`）上一次让离线产物也有颜色，
 * 浏览器里物理分页收敛后再上一次（宿主负责）。
 */

const fs = require("fs")
const path = require("path")

const HIGHLIGHT_CSS_FILE = path.resolve(__dirname, "../themes/highlight.css")

let hljs = null
try {
  hljs = require("../../lib/highlight.min.js")
} catch {
  hljs = null
}

/**
 * 方言折算：hljs 发行版不认识 HiveQL 等方言（Typora 自带的高亮器认识，所以编辑视图有色、
 * deck 里没色）。SQL 方言用 SQL 规则上色已基本正确，按别名表折算即可。
 *
 * 表是常量而非配置——新增方言改一行，没必要做成用户可调项。
 */
const HLJS_ALIASES = {
  hive: "sql", hiveql: "sql", hql: "sql", sparksql: "sql",
  mysql: "sql", psql: "sql", plsql: "sql", tsql: "sql",
  jshell: "java",
}

const defaultReadFile = file => fs.readFileSync(file, "utf8")

/** 高亮配色 CSS。同 KaTeX 一样，只在真需要时才拼进 deck CSS。 */
const highlightCss = ({ readFile = defaultReadFile } = {}) => {
  try {
    return readFile(HIGHLIGHT_CSS_FILE)
  } catch {
    return ""
  }
}

/**
 * 给文档里所有 `pre > code[class*='language-']` 上色。就地修改，返回改了几个。
 *
 * 染不了的（hljs 不认识这门语言、或抛错）一律保持纯文本——丢代码远比不上色糟。
 *
 * @param {Document} doc
 * @returns {number} 实际染色的代码块数量
 */
const highlightCode = doc => {
  if (!hljs || !doc) return 0
  let painted = 0
  for (const code of doc.querySelectorAll("pre > code[class*='language-']")) {
    const cls = [...code.classList].find(c => c.startsWith("language-"))
    if (!cls) continue
    const lang = cls.slice("language-".length).toLowerCase()
    const hlLang = HLJS_ALIASES[lang] ?? lang
    if (!hlLang || !hljs.getLanguage(hlLang)) continue
    try {
      code.innerHTML = hljs.highlight(code.textContent, {
        language: hlLang,
        ignoreIllegals: true,
      }).value
      painted += 1
    } catch {
      /* 染色失败就保持纯文本，不吞掉代码 */
    }
  }
  return painted
}

module.exports = { highlightCode, highlightCss, HLJS_ALIASES }
