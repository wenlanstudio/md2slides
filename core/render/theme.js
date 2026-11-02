"use strict"

/**
 * theme.js — 主题 CSS 的加载、补全与画布尺寸。
 *
 * 自建引擎里，主题不再经过 marp 的 themeSet，所以有两件事得自己干：
 *
 *  1. **`@import 'default'`**：这是 marp 的主题继承语法，浏览器不认。它原本引的是 marp 内置
 *     默认主题（标题/表格/代码的基础排版）。这里换成项目自带的 `core/themes/base.css`，
 *     语义等价但没有 marp。
 *  2. **画布尺寸**：marp 从渲染出的 svg 的 viewBox 上读。这里没有 svg 了，直接解析主题里
 *     `section { width … height … }`，来源唯一、不用等渲染。
 *
 * 读文件在浏览器里没有 `fs`，所以 `readFile` 可注入（Typora 宿主传它自己的实现）。
 */

const fs = require("fs")
const path = require("path")

const THEMES_DIR = path.resolve(__dirname, "../themes")
const BASE_THEME = "base.css"
const DEFAULT_CANVAS = { slideWidth: 1920, slideHeight: 1080 }
const KATEX_CSS_FILE = path.resolve(__dirname, "../../lib/katex/katex.min.css")

/** 主题文件里历史遗留的继承语法（`@import 'default'`）：剥离而不是报错。 */
const RE_IMPORT_DEFAULT = /@import\s+['"]default['"]\s*;?/g
// 主题名声明，两种写法都收：`/*!theme: x *\/` 与 `/* @theme x *\/`（后者是引擎写出的格式）。
// （写成行注释是因为这两种写法本身就含 `*/`，放进块注释会提前把它关掉。）
const RE_THEME_NAME = /\/\*!?\s*@?theme\s*:?\s*([\w-]+)\s*\*\//i

const defaultReadFile = file => fs.readFileSync(file, "utf8")

/** 主题名：优先认 CSS 里的声明，没有就用文件名（下划线折算成连字符，与 front-matter 对齐）。 */
const themeNameOf = (css, file) => {
  const declared = RE_THEME_NAME.exec(css)
  if (declared) return declared[1]
  return path.basename(file, ".css").replace(/_/g, "-")
}

/**
 * 画布尺寸：主题用 `section { width: 1920px; height: 1080px; }` 声明。
 * 只在第一个裸 `section {}` 块里找 —— `section::after`、`section.lead` 不参与。
 */
const canvasOf = css => {
  const block = /(^|\})\s*section\s*\{([^}]*)\}/.exec(css)
  if (!block) return { ...DEFAULT_CANVAS }
  const width = /width\s*:\s*(\d+)px/.exec(block[2])
  const height = /height\s*:\s*(\d+)px/.exec(block[2])
  return {
    slideWidth: width ? Number(width[1]) : DEFAULT_CANVAS.slideWidth,
    slideHeight: height ? Number(height[1]) : DEFAULT_CANVAS.slideHeight,
  }
}

/** 把 marp 的 `@import 'default'` 就地换成 base.css。没有该语句则原样返回。 */
const resolveImports = (css, readFile, themesDir) => {
  if (!/@import\s+['"]default['"]\s*;?/.test(css)) return css
  let base = ""
  try {
    base = readFile(path.join(themesDir, BASE_THEME))
  } catch {
    return css.replace(RE_IMPORT_DEFAULT, "")
  }
  return css.replace(RE_IMPORT_DEFAULT, () => base)
}

/**
 * 读一个主题。
 *
 * @param {string} name        主题名，如 `lecture`
 * @param {object} [opts]
 * @param {string} [opts.themesDir]  主题目录，默认 `core/themes`
 * @param {Function} [opts.readFile] 读文件实现，默认 `fs.readFileSync`
 * @returns {{ css: string, slideWidth: number, slideHeight: number, name: string, file: string }|null}
 */
const loadTheme = (name, opts = {}) => {
  const themesDir = opts.themesDir ?? THEMES_DIR
  const readFile = opts.readFile ?? defaultReadFile
  if (!name) return null

  let files = []
  try {
    files = fs.readdirSync(themesDir).filter(f => f.toLowerCase().endsWith(".css"))
  } catch {
    return null
  }

  for (const file of files) {
    if (file === BASE_THEME) continue
    const raw = readFile(path.join(themesDir, file))
    if (themeNameOf(raw, file) !== name) continue
    const css = resolveImports(raw, readFile, themesDir)
    return { css, ...canvasOf(css), name, file }
  }
  return null
}

/** 目录里所有主题（按名字），供 UI 列清单用。 */
const listThemes = (opts = {}) => {
  const themesDir = opts.themesDir ?? THEMES_DIR
  const readFile = opts.readFile ?? defaultReadFile
  let files = []
  try {
    files = fs.readdirSync(themesDir).filter(f => f.toLowerCase().endsWith(".css"))
  } catch {
    return []
  }
  return files
    .filter(f => f !== BASE_THEME)
    .map(file => themeNameOf(readFile(path.join(themesDir, file)), file))
}

/**
 * KaTeX 的样式表，只在文档里真的有公式时才需要拼进 deck CSS。
 *
 * 它的 `url(fonts/…)` 是相对自身的，内联到页面里就失效了，所以按 `fontsUrl` 重写一遍。
 * 默认值假设页面就放在项目根；宿主（比如 Typora 插件）应当传自己的字体地址。
 */
const katexCss = ({ readFile = defaultReadFile, fontsUrl = "./lib/katex/fonts/" } = {}) => {
  let css = ""
  try {
    css = readFile(KATEX_CSS_FILE)
  } catch {
    return ""
  }
  const base = fontsUrl.endsWith("/") ? fontsUrl : `${fontsUrl}/`
  return css.replace(/url\(\s*(['"]?)fonts\//g, `url($1${base}`)
}

module.exports = {
  loadTheme,
  listThemes,
  katexCss,
  themeNameOf,
  canvasOf,
  THEMES_DIR,
  DEFAULT_CANVAS,
}
