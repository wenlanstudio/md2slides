"use strict"

/**
 * smoke.js — md2slides 渲染链路的冒烟测试。
 *
 * 跑的是"没有浏览器也能跑的那一半"：Markdown 解析、主题加载、逻辑分页。
 * 物理分页需要真实布局（有高度才有溢出），不在这里，那是 `overflow.js` 且要在浏览器里验。
 *
 * Usage:  node tools/smoke.js
 *         （sectionize 需要 jsdom；没装会跳过并提示，其余照跑）
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const { renderMarkdown } = require("../core/parse/markdown")
const { deckMeta } = require("../core/parse/frontMatter")
const { loadTheme, canvasOf } = require("../core/render/theme")
const { sectionize } = require("../core/split/sectionize")
const { compose } = require("../core/compose")

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok    ${name}`)
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error.message}`)
    process.exitCode = 1
  }
}

// ---- 1. Markdown 解析 ------------------------------------------------------

const MD = [
  "# 一级标题",
  "",
  "正文段落。",
  "",
  "```python",
  "# 这是代码注释，不是标题",
  "---",
  "print(1)",
  "```",
  "",
  "## 二级标题",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "---",
  "",
  "### 三级标题",
  "",
  "末尾段落。",
].join("\n")

console.log("markdown.js")
const html = renderMarkdown(MD)
check("渲染出 h1", () => assert.ok(/<h1[ >]/.test(html)))
check("渲染出代码块且内容完整", () => {
  assert.ok(/<pre[ >]/.test(html), "没有 pre")
  assert.ok(/print\(1\)/.test(html), "代码内容丢了")
})
check("代码围栏内的 # 不会变成标题", () => assert.ok(!/这是代码注释<\/h1>/.test(html)))
check("代码围栏内的 --- 不会变成 hr", () => {
  const hrs = (html.match(/<hr[ >]/g) ?? []).length
  assert.strictEqual(hrs, 1, `hr 数量应为 1（手写分页符），实际 ${hrs}`)
})
check("渲染出 GFM 表格", () => assert.ok(/<table[ >]/.test(html)))

// ---- 1b. 源码行号 -----------------------------------------------------------

console.log("markdown.js（源码行号）")
const SRC_MD = [
  "# 标题一行",   // 1
  "",            // 2
  "正文段落。",   // 3
  "",            // 4
  "- 第一项",     // 5
  "- 第二项",     // 6
  "",            // 7
  "```js",       // 8
  "code()",      // 9
  "code2()",     // 10
  "```",         // 11
].join("\n")
check("块级元素带 data-src 行号（1 基含端点）", () => {
  const html = renderMarkdown(SRC_MD)
  assert.ok(html.includes('<h1 data-src-start="1" data-src-end="1">'), "h1 行号不对")
  assert.ok(html.includes('<p data-src-start="3" data-src-end="3">'), "段落行号不对")
  assert.ok(html.includes('<ul data-src-start="5" data-src-end="7">'), "列表行号不对")
  assert.ok(html.includes('<li data-src-start="5" data-src-end="5">'), "列表项行号不对")
})
check("围栏行号注入在 <pre> 上，含 ``` 两行", () => {
  const html = renderMarkdown(SRC_MD)
  assert.ok(html.includes('<pre data-src-start="8" data-src-end="11">'), "围栏行号不对")
})

// ---- 2. 主题 ---------------------------------------------------------------

console.log("theme.js")
const theme = loadTheme("lecture")
check("能按 front-matter 的名字加载主题", () => assert.ok(theme, "找不到 lecture"))
check("主题继承语句（@import 'default'）已被 base.css 换掉", () => {
  assert.ok(theme, "主题未加载")
  assert.ok(!/@import\s+['"]default['"]/.test(theme.css), "仍有继承语句")
  assert.ok(/markdown-alert/.test(theme.css), "base.css 没被注入")
})
check("画布尺寸来自主题的 section 规则", () => {
  assert.ok(theme, "主题未加载")
  assert.strictEqual(theme.slideWidth, 1920)
  assert.strictEqual(theme.slideHeight, 1080)
})
check("canvasOf 能直接读尺寸", () => {
  assert.deepStrictEqual(canvasOf("section { width: 1280px; height: 720px; }"), {
    slideWidth: 1280,
    slideHeight: 720,
  })
})

// ---- 3. 逻辑分页 -----------------------------------------------------------

let document = null
try {
  ({ document } = new (require("jsdom").JSDOM)("").window)
} catch {
  console.log("sectionize.js  — 跳过：需要 jsdom（npm i jsdom）")
}

if (document) {
  console.log("sectionize.js")
  const slides = divider => sectionize(html, { divider, document })

  check("divider=3：h1/h2/h3 与手写 --- 都分页", () => {
    const { slideCount } = slides(3)
    assert.strictEqual(slideCount, 3, `应为 3 页，实际 ${slideCount}`)
  })
  check("divider=1：只有 h1 分页，其余靠 --- 兜底", () => {
    const { slideCount } = slides(1)
    assert.strictEqual(slideCount, 2, `应为 2 页，实际 ${slideCount}`)
  })
  check("产出的是 section[data-slide]", () => {
    const { html: out } = slides(3)
    assert.strictEqual((out.match(/<section data-slide=""/g) ?? []).length, 3)
  })
  check("分页符本身不进页", () => {
    const { html: out } = slides(3)
    assert.ok(!/<hr[ >]/.test(out), "hr 被当成内容留在页里")
  })
  check("代码块整块留在同一页", () => {
    const { html: out } = slides(3)
    assert.ok(/<section data-slide="">[\s\S]*<pre[ >][\s\S]*print\(1\)[\s\S]*<\/section>/.test(out))
  })
  check("不留空页", () => {
    const { html: out } = sectionize("a\n\n---\n", { document })
    assert.ok(!/<section data-slide=""><\/section>/.test(out))
  })
}

// ---- 3.5 begin/split/end 三注释分栏 ---------------------------------------

const { expandColumns, parseRatio } = require("../core/split/cols")

console.log("cols.js（三注释分栏）")

check("parseRatio：正整数且和恰为 100 才认", () => {
  assert.deepStrictEqual(parseRatio("30:70"), [30, 70])
  assert.deepStrictEqual(parseRatio("25:25:50"), [25, 25, 50])
  assert.strictEqual(parseRatio("40:70"), null, "和不是 100")
  assert.strictEqual(parseRatio("30:70:30"), null, "和不是 100")
  assert.strictEqual(parseRatio("a:b"), null, "非数字")
  assert.strictEqual(parseRatio("0:100"), null, "0 不是正整数")
  assert.strictEqual(parseRatio(undefined), null)
})

check("begin/split/end 展开为 .cols 容器 + 各栏 + 内联栏宽", () => {
  const { text, count, diagnostics } = expandColumns(
    "<!-- begin 30:70 -->\n左栏\n<!-- split -->\n右栏\n<!-- end -->")
  assert.strictEqual(count, 1)
  assert.deepStrictEqual(diagnostics, [])
  assert.ok(/<div class="cols cols-2">/.test(text))
  assert.ok(/<div class="col" style="flex: 30 1 0">/.test(text))
  assert.ok(/<div class="col" style="flex: 70 1 0">/.test(text))
  assert.ok(!/<!--/.test(text), "标记注释应全部被替换")
  assert.ok(!/<style/.test(text), "不再需要 <style> 块（栏宽走内联）")
})

check("无占比 → 等宽（无内联 style、无 style 块）", () => {
  const { text } = expandColumns("<!-- begin -->\nA\n<!-- split -->\nB\n<!-- end -->")
  assert.ok(/<div class="col">/.test(text))
  assert.ok(!/flex:/.test(text))
  assert.ok(!/<style/.test(text))
})

check("三段占比 25:25:50 → cols-3", () => {
  const { text } = expandColumns(
    "<!-- begin 25:25:50 -->\nA\n<!-- split -->\nB\n<!-- split -->\nC\n<!-- end -->")
  assert.ok(/cols cols-3/.test(text))
  assert.ok(/style="flex: 25 1 0"/.test(text) && /style="flex: 50 1 0"/.test(text))
})

check("规则 1：孤立 split/end 忽略", () => {
  const { text, diagnostics } = expandColumns("<!-- split -->\nx\n<!-- end -->\ny")
  assert.strictEqual(diagnostics.length, 2)
  assert.ok(diagnostics.every(d => d.rule === 1 && d.level === "warning"))
  assert.ok(!/class="cols/.test(text))
})

check("规则 2：begin 无 end 不展开、内容原位保留", () => {
  const { text, diagnostics } = expandColumns("<!-- begin -->\nA\n<!-- split -->\nB")
  assert.strictEqual(diagnostics.length, 1)
  assert.strictEqual(diagnostics[0].rule, 2)
  assert.ok(!/class="cols/.test(text))
  assert.ok(/<!-- begin -->/.test(text), "标记应原位保留")
})

check("规则 3：嵌套 begin 内层忽略、外层照常", () => {
  const { text, diagnostics } = expandColumns(
    "<!-- begin -->\nA\n<!-- begin -->\nB\n<!-- split -->\nC\n<!-- end -->")
  assert.strictEqual(diagnostics.length, 1)
  assert.strictEqual(diagnostics[0].rule, 3)
  assert.ok(/cols cols-2/.test(text))
})

check("规则 4：split 多于 2（超 3 栏）整组线性", () => {
  const { text, count, diagnostics } = expandColumns(
    "<!-- begin -->\nA\n<!-- split -->\nB\n<!-- split -->\nC\n<!-- split -->\nD\n<!-- end -->")
  assert.strictEqual(count, 0)
  assert.strictEqual(diagnostics[0].rule, 4)
  assert.ok(!/class="cols/.test(text))
})

check("规则 5：占比非法 / 个数与栏数不符 → 等宽", () => {
  const bad = expandColumns("<!-- begin 40:70 -->\nA\n<!-- split -->\nB\n<!-- end -->")
  assert.strictEqual(bad.diagnostics[0].rule, 5)
  assert.ok(!/g\d/.test(bad.text))
  const mismatch = expandColumns(
    "<!-- begin 30:70 -->\nA\n<!-- split -->\nB\n<!-- split -->\nC\n<!-- end -->")
  assert.strictEqual(mismatch.diagnostics[0].rule, 5)
  assert.ok(!/g\d/.test(mismatch.text))
})

check("规则 6：注释未闭合 → 该标记无效", () => {
  const { diagnostics } = expandColumns("<!-- begin 30:70\nA\n<!-- end -->")
  assert.ok(diagnostics.some(d => d.rule === 6 && d.line === 1))
})

check("规则 7：非顶层标记 inert（缩进 / 引用 / 表格 / 行内）", () => {
  const { text, diagnostics } = expandColumns("    <!-- split -->\n> <!-- end -->")
  assert.ok(diagnostics.length >= 1 && diagnostics.every(d => d.rule === 7))
  assert.ok(!/class="cols/.test(text))
})

check("规则 9：begin 后没有 split 不成组", () => {
  const { count, diagnostics } = expandColumns("<!-- begin -->\nA\n<!-- end -->")
  assert.strictEqual(count, 0)
  assert.strictEqual(diagnostics[0].rule, 9)
})

check("代码围栏内的标记是字面文本，不动", () => {
  const { text } = expandColumns("```md\n<!-- begin 30:70 -->\n<!-- split -->\n<!-- end -->\n```")
  assert.ok(text.includes("<!-- begin 30:70 -->"))
  assert.ok(!/class="cols/.test(text))
})

check("关键字大小写不敏感、注释内空白容忍", () => {
  const { text, count } = expandColumns(
    "<!--  BEGIN  30 : 70  -->\nA\n<!--  Split  -->\nB\n<!--  END  -->")
  assert.strictEqual(count, 1)
  assert.ok(/style="flex: 30 1 0"/.test(text) && /style="flex: 70 1 0"/.test(text))
})

check("普通注释与形近词（beginn）不误伤", () => {
  const { text, count } = expandColumns("<!-- 这只是注释 -->\n<!-- beginn -->\n<!-- endpoint -->")
  assert.strictEqual(count, 0)
  assert.ok(text.includes("<!-- 这只是注释 -->") && text.includes("<!-- beginn -->"))
})

// ---- 3.6 数学公式 ---------------------------------------------------------

const MATH_MD = [
  "行内公式 $E = mc^2$，但价格 $ 100 不是公式。",
  "",
  "$$",
  "\\int_0^1 x^2 dx = \\frac{1}{3}",
  "$$",
  "",
  "```python",
  "cost = 5  # $ 在代码里也不是公式",
  "```",
].join("\n")

console.log("math (KaTeX)")
const mathHtml = renderMarkdown(MATH_MD)
check("行内公式被渲染", () => assert.ok(/class="katex"/.test(mathHtml)))
check("块级公式输出 katex-display（会被当核心内容保护）", () =>
  assert.ok(/class="katex-display"/.test(mathHtml)))
check("$ 后跟空格不是公式（价格不误伤）", () =>
  assert.ok(/\$ 100/.test(mathHtml), "价格文本被当成公式吃掉了"))
check("代码块里的 $ 不算公式", () => assert.ok(!/<code[^>]*>[^<]*katex/.test(mathHtml)))

// ---- 3.7 文档元数据（front-matter 八键）--------------------------------------

check("deckMeta：八键全解析", () => {
  const md = [
    "---",
    "title: 第2章 使用matplotlib绘制简单图表",
    "subtitle: 从直方图到分布拟合",
    "author: Yuan",
    "date: 2026-10-24",
    "book: Python 数据分析讲义",
    "header: true",
    "footer: false",
    "keywords: 直方图, 分布拟合",
    "show: element",
    "page: false",
    "---",
    "",
    "# T",
  ].join("\n")
  assert.deepStrictEqual(deckMeta(md), {
    title: "第2章 使用matplotlib绘制简单图表",
    subtitle: "从直方图到分布拟合",
    author: "Yuan",
    date: "2026-10-24",
    book: "Python 数据分析讲义",
    header: true,
    footer: false,
    keywords: ["直方图", "分布拟合"],
    show: "element",
    page: false,
    toc: true,
  })
})
check("deckMeta：keywords 三种写法 + 去重，缺省为空数组", () => {
  assert.deepStrictEqual(deckMeta("---\nkeywords: A, B, A\n---\n\n# T").keywords, ["A", "B"])
  assert.deepStrictEqual(deckMeta("---\nkeywords: [事实表, 度量]\n---\n\n# T").keywords,
    ["事实表", "度量"])
  assert.deepStrictEqual(deckMeta("---\nkeywords: 甲，乙;丙、丁\n---\n\n# T").keywords,
    ["甲", "乙", "丙", "丁"])
  assert.deepStrictEqual(deckMeta("---\ntitle: x\n---\n\n# T").keywords, [])
})
check("deckMeta：datetime 是 date 的别名", () => {
  assert.strictEqual(deckMeta("---\ndatetime: 2026-09-09 15:55:26\n---\n\n# T").date,
    "2026-09-09 15:55:26")
})
check("deckMeta：date 主键优先于 datetime", () => {
  assert.strictEqual(deckMeta("---\ndate: 2026-10-24\ndatetime: 2020-01-01\n---\n\n# T").date,
    "2026-10-24")
})
check("deckMeta：header/footer 缺省开", () => {
  assert.deepStrictEqual(deckMeta("---\ntitle: x\n---\n\n# T"), {
    title: "x", subtitle: null, author: null, date: null, book: null,
    header: true, footer: true, keywords: [], show: null, page: null, toc: true,
  })
})
check("deckMeta：header/footer 可自定义文本（三态）", () => {
  const m = deckMeta('---\nheader: "第 %page% 页"\nfooter: 内部资料\n---\n\n# T')
  assert.strictEqual(m.header, "第 %page% 页")
  assert.strictEqual(m.footer, "内部资料")
})
check("deckMeta：无 front-matter 不抛，八键全缺省", () => {
  assert.deepStrictEqual(deckMeta("# 只有正文"), {
    title: null, subtitle: null, author: null, date: null, book: null,
    header: true, footer: true, keywords: [], show: null, page: null, toc: true,
  })
})
check("deckMeta：toc 三态（缺省开 / false 关 / 数字=子项列到几级）", () => {
  assert.strictEqual(deckMeta("---\ntoc: false\n---\n\n# T").toc, false)
  assert.strictEqual(deckMeta("---\ntoc: true\n---\n\n# T").toc, true)
  assert.strictEqual(deckMeta("---\ntoc: 3\n---\n\n# T").toc, 3)
})

// ---- 3.8 家具注入（页眉页脚）------------------------------------------------

const { injectFurniture, SLOT_LEFT_CLASS, SLOT_RIGHT_CLASS } = require("../core/paginate/furniture")

/** jsdom 里拼几页：section 顺序即页序，注入器不测量、纯结构操作。 */
const furnitureDoc = pages => {
  const doc = new (require("jsdom").JSDOM)("<html><body></body></html>").window.document
  for (const html of pages) {
    const wrap = doc.createElement("div")
    wrap.innerHTML = html
    doc.body.appendChild(wrap.firstElementChild)
  }
  return doc
}
const textOf = (doc, i, sel) =>
  doc.body.children[i].querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? null
/** 槽位文本：页眉页脚各有左/右槽（2026-10-24 起路径在页脚左、页码在页脚右），断言精确到槽。 */
const slotText = (doc, i, sel, side) =>
  doc.body.children[i].querySelector(sel)
    ?.querySelector(`.md2s-slot-${side}`)?.textContent?.replace(/\s+/g, " ").trim() ?? null

if (document) {
  check("家具注入：封面豁免、扉页无页眉、面包屑在页脚左下", () => {
    const doc = furnitureDoc([
      // 封面由引擎生成：题名住在 div.cover 里，不是 section 的直接子元素
      `<section data-slide><div class="cover"><h1>课程封面</h1><p>副标题</p></div></section>`,
      `<section data-slide><h2>第2章</h2><h3>2.1</h3></section>`,
      `<section data-slide><h3>2.1</h3><p>内容</p></section>`,
    ])
    const n = injectFurniture(doc, { book: "讲义", title: "课程封面", header: true, footer: true })
    assert.strictEqual(n, 3, "应注入 1 页脚（扉页）+ 1 页眉 + 1 页脚（内容页）")
    assert.strictEqual(textOf(doc, 0, "header"), null, "封面不该有页眉")
    assert.strictEqual(textOf(doc, 0, "footer"), null, "封面不该有页脚")
    assert.strictEqual(textOf(doc, 1, "header"), null, "扉页不该有页眉")
    assert.strictEqual(slotText(doc, 1, "footer", "left"), null, "扉页的路径同样豁免")
    assert.strictEqual(slotText(doc, 1, "footer", "right"), "2 / 3", "扉页要保留页码")
    assert.strictEqual(textOf(doc, 2, "header"), "讲义", "页眉只剩左槽书名")
    assert.strictEqual(slotText(doc, 2, "footer", "left"), "第2章 > 2.1", "面包屑应搬到页脚左下")
    assert.strictEqual(slotText(doc, 2, "footer", "right"), "3 / 3")
  })
  check("家具注入：封面里的题名（div.cover 内）不进面包屑", () => {
    const doc = furnitureDoc([
      `<section data-slide><div class="cover"><h1>课程封面</h1></div></section>`,
      `<section data-slide><h2>第2章</h2><p>章引</p></section>`,
      `<section data-slide><h3>2.1</h3><p>内容</p></section>`,
    ])
    injectFurniture(doc, { book: "讲义", title: "课程封面", header: true, footer: true })
    assert.strictEqual(slotText(doc, 2, "footer", "left"), "第2章 > 2.1", "封面题名漏进了面包屑")
  })
  check("家具注入：H1 就是层级 1，正文 H1 照常进面包屑", () => {
    // 2026-10-24 规范：正文里没有"题名"这种特殊元素，H1–H6 都是标题
    const doc = furnitureDoc([
      `<section data-slide><div class="cover"><h1>全书题名</h1></div></section>`,
      `<section data-slide><h1>第一部分 · 基础</h1><p>x</p></section>`,
      `<section data-slide><h2>1.1 新特性</h2><p>x</p></section>`,
    ])
    injectFurniture(doc, { book: "讲义", header: true, footer: true })
    assert.strictEqual(slotText(doc, 2, "footer", "left"), "第一部分 · 基础 > 1.1 新特性")
  })
  check("家具注入：无 H1 的第一页是内容页，其标题照常计入路径", () => {
    const doc = furnitureDoc([
      `<section data-slide><h2>第2章</h2><p>章引</p></section>`,
      `<section data-slide><h3>2.1</h3><p>x</p></section>`,
    ])
    injectFurniture(doc, { book: "讲义", header: true, footer: true })
    assert.strictEqual(slotText(doc, 1, "footer", "left"), "第2章 > 2.1")
  })
  check("家具注入：H1 扉页自身无页眉、页脚无路径（连续两页同一路径零信息量）", () => {
    const doc = furnitureDoc([
      `<section data-slide><div class="cover"><h1>题</h1></div></section>`,
      `<section data-slide><h1>第一部分</h1></section>`,
      `<section data-slide><h2>1.1</h2><p>x</p></section>`,
    ])
    injectFurniture(doc, { book: "讲义", header: true, footer: true })
    assert.strictEqual(textOf(doc, 1, "header"), null, "扉页不该有页眉")
    assert.strictEqual(slotText(doc, 1, "footer", "left"), null, "扉页的路径也该豁免")
    assert.strictEqual(slotText(doc, 1, "footer", "right"), "2 / 3", "扉页要保留页码")
    assert.strictEqual(slotText(doc, 2, "footer", "left"), "第一部分 > 1.1")
  })
  check("家具注入：header:false 全无页眉；footer 自定义模板展开", () => {
    const doc = furnitureDoc([
      `<section data-slide><h1>题</h1><p>x</p></section>`,
      `<section data-slide><h2>a</h2><p>x</p></section>`,
    ])
    injectFurniture(doc, { header: false, footer: "第 %page% 页 · 共 %total% 页" })
    assert.strictEqual(textOf(doc, 1, "header"), null)
    assert.strictEqual(textOf(doc, 1, "footer"), "第 2 页 · 共 2 页")
  })
  check("家具注入：单页文档不显示 N / 1", () => {
    const doc = furnitureDoc([`<section data-slide><h1>只有一页</h1><p>x</p></section>`])
    injectFurniture(doc, { header: true, footer: true })
    assert.strictEqual(doc.querySelectorAll(".md2s-furniture").length, 0)
  })
  check("家具注入：幂等——反复调用不叠加（settle 多轮的保障）", () => {
    const doc = furnitureDoc([
      `<section data-slide><h1>题</h1><p>x</p></section>`,
      `<section data-slide><h2>a</h2><p>x</p></section>`,
    ])
    const meta = { book: "讲义", header: true, footer: true }
    injectFurniture(doc, meta)
    const after1 = doc.body.children[1].children.length
    injectFurniture(doc, meta)
    assert.strictEqual(doc.body.children[1].children.length, after1, "二次注入把家具叠上去了")
    assert.strictEqual(slotText(doc, 1, "footer", "right"), "2 / 2", "二次注入后页码应刷新而非残留")
  })
  check("家具注入：未知变量原样保留，不静默吞掉", () => {
    const doc = furnitureDoc([
      `<section data-slide><h1>题</h1><p>x</p></section>`,
      `<section data-slide><h2>a</h2><p>x</p></section>`,
    ])
    injectFurniture(doc, { header: "%book% %oops%", footer: true })
    assert.strictEqual(textOf(doc, 1, "header"), "%oops%")
  })
  check("家具注入：书名缺失回退标题，两者都缺则页眉整个省略", () => {
    const withTitle = furnitureDoc([
      `<section data-slide><div class="cover"><h1>题</h1><p>x</p></div></section>`,
      `<section data-slide><h2>a</h2><p>x</p></section>`,
    ])
    injectFurniture(withTitle, { title: "回退标题", header: true, footer: true })
    assert.strictEqual(textOf(withTitle, 1, "header"), "回退标题")
    const bare = furnitureDoc([
      `<section data-slide><div class="cover"><h1>题</h1><p>x</p></div></section>`,
      `<section data-slide><h2>a</h2><p>x</p></section>`,
    ])
    injectFurniture(bare, { header: true, footer: true })
    assert.strictEqual(bare.body.children[1].querySelector("header"), null,
      "无书名无标题时左槽为空，页眉整个省略")
    assert.strictEqual(slotText(bare, 1, "footer", "left"), "a", "路径与书名无关，照常进页脚")
  })
}

// ---- 3.9 关键词高亮（front-matter keywords）----------------------------------

if (document) {
  console.log("keywords.js")
  const { highlightKeywords } = require("../core/render/keywords")

  check("命中即包 mark，文本一个字符不丢", () => {
    const out = highlightKeywords("<p>事实表记录度量，度量可加。</p>", ["事实表", "度量"], document)
    assert.strictEqual((out.match(/<mark class="md2s-kw">/g) ?? []).length, 3)
    assert.strictEqual(out.replace(/<[^>]+>/g, ""), "事实表记录度量，度量可加。")
  })
  check("标题与代码块（含行内 code）不高亮", () => {
    const out = highlightKeywords(
      "<h2>事务事实表</h2><p>正文的事实表</p><p>行内 <code>事实表</code> 代码</p><pre><code>-- 事实表\n</code></pre>",
      ["事实表"], document)
    assert.strictEqual((out.match(/<mark class="md2s-kw">/g) ?? []).length, 1, "只该命中正文那一处")
    assert.ok(/<h2>事务事实表<\/h2>/.test(out), "标题被改了")
    assert.ok(/<code>事实表<\/code>/.test(out), "行内 code 被改了")
  })
  check("大小写不敏感；长词优先（事实表 不被 事实 抢走）", () => {
    const en = highlightKeywords("<p>mapreduce 与 MapReduce</p>", ["MapReduce", "map"], document)
    assert.strictEqual((en.match(/<mark class="md2s-kw">/g) ?? []).length, 2)
    const cn = highlightKeywords("<p>事实与事实表</p>", ["事实", "事实表"], document)
    assert.ok(/<mark class="md2s-kw">事实表<\/mark>/.test(cn), "长词应整体命中")
    assert.strictEqual((cn.match(/<mark/g) ?? []).length, 2)
  })
  check("词边界：A 不命中 Java / and 里的 a", () => {
    const out = highlightKeywords("<p>Java and A</p>", ["A"], document)
    assert.strictEqual((out.match(/<mark class="md2s-kw">/g) ?? []).length, 1)
  })
  check("空关键词 / 空 html / 无 document 原样返回", () => {
    const html = "<p>事实表</p>"
    assert.strictEqual(highlightKeywords(html, [], document), html)
    assert.strictEqual(highlightKeywords(html, ["事实表"], null), html)
    assert.strictEqual(highlightKeywords("", ["事实表"], document), "")
  })
  check("compose：keywords 走全链路，封面题名不被高亮", () => {
    const d = compose("---\ntitle: 事实表入门\nkeywords: 事实表\n---\n\n事实表是核心。\n", { document })
    assert.strictEqual(d.keywords, 1)
    assert.ok(/<mark class="md2s-kw">事实表<\/mark>/.test(d.html), "正文没高亮")
    const cover = d.doc.querySelector(".cover")
    assert.ok(cover, "封面呢")
    assert.strictEqual(cover.querySelector("mark"), null, "封面题名被高亮了")
  })
}

// ---- 3.10 章节目录页（core/paginate/toc.js，2026-10-30 拍板：每章前一页 + 当前章高亮）-

if (document) {
  console.log("toc.js")
  const { planToc, fillToc, TOC_CLASS, TOC_CURRENT_CLASS } = require("../core/paginate/toc")
  const { renumber } = require("../core/section")
  const { buildStepPlan } = require("../kit/steps")

  /** compose → 独立文档（与宿主把 html 塞进 iframe 同构），再跑目录两拍。 */
  const tocDeck = (md, opts = {}) => {
    const out = compose(md, { document })
    const host = new (require("jsdom").JSDOM)(`<html><body>${out.html}</body></html>`).window.document
    const settle = () => {
      const plan = planToc(host, { ...opts, meta: out.meta, diags: [] })
      renumber(host)
      fillToc(host, plan, {})
      return plan
    }
    return { out, host, settle, slides: () => [...host.querySelectorAll("section[data-slide]")] }
  }
  const entries = slide => [...slide.querySelectorAll(".md2s-toc-item")].map(li => ({
    text: li.querySelector(".md2s-toc-text")?.textContent ?? "",
    page: li.querySelector(".md2s-toc-page")?.textContent ?? "",
    current: li.classList.contains(TOC_CURRENT_CLASS),
  }))

  const MD3 = [
    "---",
    "title: 讲义",
    "paginate: true",
    "---",
    "",
    "# 第一章",
    "",
    "## 1.1",
    "",
    "内容 A。",
    "",
    "## 1.2",
    "",
    "内容 B。",
    "",
    "# 第二章",
    "",
    "## 2.1",
    "",
    "内容 C。",
    "",
    "# 第三章",
    "",
    "内容 D。",
    "",
  ].join("\n")

  check("目录页：每个章节起始页之前插一页，条目 = 全部章节 + 当前章子项", () => {
    const deck = tocDeck(MD3)
    const plan = deck.settle()
    assert.strictEqual(deck.out.chapters, 3, "markChapters 应认出 3 章")
    assert.strictEqual(plan.length, 3, "3 章 → 3 页目录")
    const slides = deck.slides()
    // 封面 / 目录1 / 第1章 / 1.1 / 1.2 / 目录2 / 第2章 / 2.1 / 目录3 / 第3章
    assert.strictEqual(slides.length, 10)
    assert.ok(slides[1].classList.contains(TOC_CLASS), "第 2 页应是目录页")
    assert.strictEqual(slides[1].getAttribute("data-toc"), "1")
    const items = entries(slides[1])
    assert.deepStrictEqual(items.map(it => it.text),
      ["第一章", "1.1", "1.2", "第二章", "第三章"], "当前章的子项应排在该章条目之后")
    assert.deepStrictEqual(items.filter(it => it.current).map(it => it.text),
      ["第一章", "1.1", "1.2"], "当前章及其子项高亮")
  })

  check("目录页：页码是 renumber 之后的真值（含目录页自己占的那一格）", () => {
    const deck = tocDeck(MD3)
    deck.settle()
    const slides = deck.slides()
    const pages = entries(slides[1]).map(it => `${it.text}=${it.page}`)
    assert.deepStrictEqual(pages,
      ["第一章=3", "1.1=4", "1.2=5", "第二章=7", "第三章=10"],
      "目录页插进去后页码整体后移，填的数字必须是 renumber 之后的")
    // 反查：目录里写的页码，与该标题所在页的 data-pagination 必须一致
    for (const slide of slides) {
      for (const li of slide.querySelectorAll(".md2s-toc-item")) {
        const head = [...slides].find(s =>
          s.querySelector("h1,h2,h3")?.textContent.trim() === li.querySelector(".md2s-toc-text").textContent)
        assert.strictEqual(li.querySelector(".md2s-toc-page").textContent,
          head.getAttribute("data-pagination"), `${li.textContent} 的页码对不上`)
      }
    }
  })

  check("目录页：幂等——反复 settle 不翻倍、不残留", () => {
    const deck = tocDeck(MD3)
    deck.settle()
    const after1 = deck.slides().length
    deck.settle()
    deck.settle()
    assert.strictEqual(deck.slides().length, after1, "跑三轮页数不该变")
    assert.strictEqual(deck.host.querySelectorAll(`section.${TOC_CLASS}`).length, 3)
  })

  check("目录页：一页放不下就分多页（tocPages 反馈，条目不砍不重）", () => {
    // 回归 2026-10-30 用户拍板：排不下新增幻灯片。tocPages 是 splitSection 实测的
    // 页数反馈（jsdom 无高度，这里直接注入模拟"上轮实测需要 2 页"）。
    const { planToc, fillToc } = require("../core/paginate/toc")
    const md = ["## 甲", "x", "", "### 甲1", "y", "", "## 乙", "z", "", "## 丙", "w"].join("\n")
    const out = compose(md, { document })
    const host = new (require("jsdom").JSDOM)(`<html><body>${out.html}</body></html>`).window.document
    const plan = planToc(host, {
      meta: out.meta, diags: [],
      tocPages: new Map([[1, 2]]),   // 第一章实测要 2 页，其余章节 1 页
    })
    assert.strictEqual(plan.length, 4, "第一章 2 页 + 第二三章各 1 页 = 4 条")
    const byCh = new Map()
    for (const p of plan) byCh.set(p.chapter.index, (byCh.get(p.chapter.index) ?? 0) + 1)
    assert.strictEqual(byCh.get(1), 2, "第一章该有 2 页")
    assert.strictEqual(byCh.get(2), 1, "第二章 1 页")
    assert.strictEqual(byCh.get(3), 1, "第三章 1 页")
    fillToc(host, plan, {})
    const pages = [...host.querySelectorAll("section.md2s-toc")]
    assert.deepStrictEqual(pages.map(s => s.querySelector("p.md2s-toc-title").textContent),
      ["目录", "目录（续）", "目录", "目录"], "续页题名要带（续）")
    // 条目不重不漏：第一章两页合起来 = 全部 3 章 + 甲1 子项。
    // 页码是 jsdom 无 data-pagination 时的序号回退（页序 = 目录1a,1b,2,3,甲…）。
    const ch1 = pages.filter(s => s.getAttribute("data-toc") === "1")
    const texts = ch1.flatMap(s => [...s.querySelectorAll("li")].map(li => li.textContent))
    assert.deepStrictEqual(texts, ["甲3", "甲14", "乙6", "丙8"], "条目按章均分两组，顺序不变")
  })

  check("目录页：toc: false 不插；opts.toc 可覆盖 front-matter", () => {
    const off = tocDeck(MD3.replace("paginate: true", "paginate: true\ntoc: false"))
    assert.strictEqual(off.settle().length, 0)
    assert.strictEqual(off.slides().length, 7, "关掉后就是原本的 7 页")
    const forced = tocDeck(MD3, { toc: false })
    assert.strictEqual(forced.settle().length, 0, "opts.toc 优先级应高于 meta.toc")
  })

  check("目录页：单章 / 无标题不插（那种目录页只是复读标题）", () => {
    assert.strictEqual(tocDeck("# 只有一章\n\n## 1.1\n\nx\n").settle().length, 0)
    assert.strictEqual(tocDeck("只是段落。\n\n再来一段。\n").settle().length, 0)
  })

  check("目录页：布尔 true 不是深度 1（子项照列）", () => {
    // 回归：Number(true) === 1，曾把"开"读成"子项列到 1 级"，子项被整片吃掉
    const deck = tocDeck("---\ntoc: true\n---\n\n# A\n\n## a1\n\nx\n\n# B\n\ny\n")
    deck.settle()
    const first = deck.slides().find(s => s.classList.contains(TOC_CLASS))
    assert.deepStrictEqual(entries(first).map(it => it.text), ["A", "a1", "B"])
  })

  check("目录页：整页一步（放映时不逐条蹦）", () => {
    const deck = tocDeck(MD3)
    deck.settle()
    const tocSlide = deck.slides().find(s => s.classList.contains(TOC_CLASS))
    assert.strictEqual(buildStepPlan(tocSlide).length, 0, "目录页不该有步")
  })

  check("目录页：家具按扉页口径——不给页眉与路径，保留页码", () => {
    const deck = tocDeck(MD3)
    deck.settle()
    const { injectFurniture } = require("../core/paginate/furniture")
    injectFurniture(deck.host, deck.out.meta, {})
    const tocSlide = deck.slides()[1]
    assert.strictEqual(tocSlide.querySelector("header"), null, "目录页不该顶页眉")
    assert.strictEqual(tocSlide.querySelector("footer .md2s-slot-left"), null, "路径沿用上一章是错的")
    assert.strictEqual(tocSlide.querySelector("footer .md2s-slot-right").textContent, "2 / 10")
  })

  check("目录页：子项认语义类 md2s-toc-sub，不按 -hN 后缀猜（2026-10-30 翻车回归）", () => {
    // 章是 H2 时：子项类名是 item-h3，CSS 若按 -h2 写死就会误伤章条目、漏掉子项
    const deck = tocDeck("## A\n\nx\n\n### a1\n\ny\n\n## B\n\nz\n")
    deck.settle()
    const first = deck.slides().find(s => s.classList.contains(TOC_CLASS))
    const items = [...first.querySelectorAll("li")]
    const trunk = items.filter(li => !li.classList.contains("md2s-toc-sub"))
    const subs = items.filter(li => li.classList.contains("md2s-toc-sub"))
    assert.strictEqual(trunk.length, 2, "两条章条目：A / B")
    assert.ok(trunk.every(li => li.classList.contains("md2s-toc-item-h2")), "H2 章条目不带子项类")
    assert.ok(trunk[0].classList.contains("md2s-toc-current"), "A 是当前章")
    assert.strictEqual(subs.length, 1, "当前章子项：a1")
    assert.ok(subs[0].classList.contains("md2s-toc-item-h3"), "H2 章的子项是 h3")
    assert.ok(subs[0].classList.contains("md2s-toc-current"), "当前章的子项也高亮")
  })

  check("目录页：子项横跨多页只列一次（2026-10-30 用户报障回归）", () => {
    // 续页（cloneNode）带着同一个 H3 标题：收集时不按文本去重就会列出 3 份、
    // 页码还各不相同（14/15/16）。这里手工造分页后的 DOM 复现该形态——
    // 续页标题里的「（续）」是 <span class="md2s-cont">（appendContinuationMarker
    // 加的标记），不是正文的一部分，headingText 会剥掉它再比对。
    const host = new (require("jsdom").JSDOM)(`<html><body>${[
      '<section data-slide data-toc-chapter="1" data-toc-level="2"><h2>甲</h2><h3>甲1</h3><p>x</p></section>',
      '<section data-slide data-toc-chapter="1" data-toc-level="2"><h2>甲<span class="md2s-cont">（续）</span></h2><h3>甲1<span class="md2s-cont">（续）</span></h3><p>y</p></section>',
      '<section data-slide data-toc-chapter="1" data-toc-level="2"><h2>甲<span class="md2s-cont">（续）</span></h2><h3>甲1<span class="md2s-cont">（续）</span></h3><p>z</p></section>',
      '<section data-slide data-toc-chapter="2" data-toc-level="2"><h2>乙</h2><p>w</p></section>',
    ].join("")}</body></html>`).window.document
    const plan = planToc(host, { toc: true, diags: [] })
    renumber(host)
    fillToc(host, plan, {})
    const first = host.querySelector(`section.${TOC_CLASS}`)
    const items = [...first.querySelectorAll("li")].map(li => li.textContent)
    assert.deepStrictEqual(items, ["甲2", "甲12", "乙6"], "甲1 只出现一次，页码取首次出现的页")
  })
}

// ---- 4. 编排层 -------------------------------------------------------------

if (document) {
  console.log("compose.js")
  const BARE = ["# H1", "", "p1", "", "## H2", "", "p2", "", "#### H4", "", "p4"].join("\n")
  const deck = compose(BARE, { document })

  check("裸文档自动补默认指令并出片", () => {
    assert.strictEqual(deck.slideCount, 2, `divider=3 时 H4 不分页，应 2 页，实际 ${deck.slideCount}`)
    assert.strictEqual(deck.theme, "lecture")
    assert.strictEqual(deck.slideWidth, 1920)
    assert.strictEqual(deck.slideHeight, 1080)
  })
  check("CSS 含主题内容与代码换行规则", () => {
    assert.ok(/markdown-alert/.test(deck.css), "base.css 没进来")
    assert.ok(/white-space:\s*pre-wrap/.test(deck.css), "缺少代码换行规则")
  })
  check("front-matter 的 divider=6 让四级标题也分页", () => {
    const d = compose(`---\nheadingDivider: 6\n---\n\n${BARE}`, { document })
    assert.strictEqual(d.slideCount, 3, `应为 3 页，实际 ${d.slideCount}`)
  })
  check("compose 透出八键 meta", () => {
    const d = compose("---\ntitle: 字节序\nauthor: 张三\n---\n\n# T", { document })
    assert.strictEqual(d.meta.title, "字节序")
    assert.strictEqual(d.meta.author, "张三")
    assert.strictEqual(d.meta.header, true)
    assert.strictEqual(d.meta.footer, true)
    assert.strictEqual(d.meta.date, null)
    assert.deepStrictEqual(d.meta.keywords, [])
  })
  check("paginate: true 才打页码", () => {
    const d = compose(`---\npaginate: true\n---\n\n${BARE}`, { document })
    assert.ok(/data-pagination="1"/.test(d.html), "没打上页码")
    assert.ok(!/data-pagination/.test(deck.html), "没要页码却打上了")
  })
  check("源码改写：front-matter 被补上，正文一字不动", () => {
    // compose 只在内存里补 front-matter，绝不回写源文件；这里验证正文原样进入输出。
    assert.ok(/<h1[^>]*>H1<\/h1>/.test(deck.html))
  })
  check("KaTeX 样式只在真有公式时才注入", () => {
    const withMath = compose(MATH_MD, { document })
    assert.ok(/katex/i.test(withMath.css), "有公式却没注入 KaTeX 样式")
    assert.ok(!/katex/i.test(deck.css), "没公式却背上了 KaTeX")
  })
  check("三注释分栏端到端：columns 计数 + DOM 出 .cols + 内联栏宽", () => {
    const d = compose(
      "<!-- begin 30:70 -->\n\n左\n\n<!-- split -->\n\n右\n\n<!-- end -->", { document })
    assert.strictEqual(d.columns, 1)
    assert.deepStrictEqual(d.columnDiags, [])
    assert.ok(/class="cols cols-2"/.test(d.html), "DOM 里没有分栏容器")
    assert.ok(/class="col" style="flex: 30 1 0"/.test(d.html))
    assert.ok(/class="col" style="flex: 70 1 0"/.test(d.html))
  })
  check("分栏诊断透传：非法占比在 columnDiags 里报出来", () => {
    const d = compose("<!-- begin 40:70 -->\nA\n<!-- split -->\nB\n<!-- end -->", { document })
    assert.strictEqual(d.columnDiags.length, 1)
    assert.strictEqual(d.columnDiags[0].rule, 5)
    assert.strictEqual(d.columns, 1, "降级组仍算展开")
  })
  check("expandCols: false 时注释原样留着", () => {
    const d = compose("<!-- begin -->\nA\n<!-- split -->\nB\n<!-- end -->",
      { document, expandCols: false })
    assert.strictEqual(d.columns, 0)
    assert.ok(!/class="cols/.test(d.html))
  })
  check("封面：声明 title 才生成，且排在全文第一页", () => {
    const d = compose("---\ntitle: 字节序\nauthor: 张三\ndate: 2026-10-24\n---\n\n## A\n\nx\n", { document })
    const first = d.doc.querySelector(".md2slides-deck").firstElementChild
    assert.strictEqual(d.slideCount, 2, `封面 + 1 页正文，实际 ${d.slideCount}`)
    assert.ok(first.matches("section[data-slide]"), "第一页不是 section")
    const cover = first.querySelector(".cover")
    assert.ok(cover, "第一页没有 .cover")
    assert.strictEqual(cover.querySelector("h1").textContent, "字节序")
    assert.strictEqual(cover.querySelectorAll("p").length, 2, "author/date 各一行")
    assert.ok(d.html.startsWith('<section data-slide=""><div class="cover">'), "封面不是 html 的第一页")
    assert.deepStrictEqual(d.coverDiags, [])
  })
  check("封面：author/date 缺项不上封面", () => {
    const d = compose("---\ntitle: 只有题名\n---\n\n## A\n\nx\n", { document })
    assert.strictEqual(d.doc.querySelector(".cover").querySelectorAll("p").length, 0)
  })
  check("封面：副标题排在题名与作者之间", () => {
    const d = compose(
      "---\ntitle: 字节序\nsubtitle: 大端序与小端序\nauthor: 张三\ndate: 2026-10-24\n---\n\n## A\n\nx\n",
      { document })
    const cover = d.doc.querySelector(".cover")
    const lines = [...cover.children].map(el =>
      el.tagName === "H1" ? el.textContent : `${el.className || "p"}:${el.textContent}`)
    assert.deepStrictEqual(lines, [
      "字节序",
      "subtitle:大端序与小端序",
      "p:张三",
      "p:2026-10-24",
    ])
  })
  check("封面：只写副标题不写题名，不生成封面", () => {
    const d = compose("---\nsubtitle: 只写副标题\n---\n\n## A\n\nx\n", { document })
    assert.ok(!/class="cover"/.test(d.html), "没有 title 却生成了封面")
    assert.strictEqual(d.slideCount, 1)
  })
  check("无 title 不生成封面（第一页即正文第一页）", () => {
    const d = compose("---\nauthor: 张三\n---\n\n## A\n\nx\n", { document })
    assert.ok(!/class="cover"/.test(d.html), "没有 title 却生成了封面")
    assert.strictEqual(d.slideCount, 1)
  })
  check("手写封面 div 被剥离，并记一条诊断", () => {
    const d = compose(
      "---\ntitle: T\n---\n\n<div class=\"cover\"><h1>手写封面</h1></div>\n\n## A\n\nx\n", { document })
    assert.ok(!/手写封面/.test(d.html), "手写封面 div 没剥掉")
    assert.strictEqual((d.html.match(/class="cover"/g) ?? []).length, 1, "应只剩引擎生成的封面")
    assert.strictEqual(d.coverDiags.length, 1)
    assert.strictEqual(d.coverDiags[0].level, "warning")
  })
}

// ---- 5. 代码高亮 -----------------------------------------------------------

if (document) {
  console.log("highlight.js")
  const CODE_MD = [
    "```python",
    "def f(x):",
    "    return x + 1",
    "```",
    "",
    "```hive",
    "SELECT * FROM t WHERE dt = '2026-10-18';",
    "```",
    "",
    "```jshell",
    "public class Demo {",
    "  int n = 42;",
    "}",
    "```",
  ].join("\n")
  const withCode = compose(CODE_MD, { document })

  check("代码块被染色", () => {
    assert.ok(withCode.highlighted > 0, "一个都没染")
    assert.ok(/class="hljs-keyword"/.test(withCode.html))
  })
  check("SQL 方言（hive）按别名折算后也能染", () => {
    assert.ok(/hljs-keyword">SELECT/.test(withCode.html), "hive 没折算成 sql")
  })
  check("jshell 代码块按 java 语法高亮", () => {
    assert.ok(/hljs-keyword">public/.test(withCode.html), "jshell 没按 java 上色")
  })
  check("高亮配色 CSS 只在染色后才注入", () => {
    const noCode = compose("# 标题\n\n正文，没有代码块。\n", { document })
    // 主题自己带了几条 .hljs-* 规则，所以得用 highlight.css 独有的标记来分辨。
    const MARK = /\.hljs-title\.function_/
    assert.strictEqual(noCode.highlighted, 0, "没代码却染了色")
    assert.ok(MARK.test(withCode.css), "染了色却没配色")
    assert.ok(!MARK.test(noCode.css), "没代码却背上了配色")
  })
  check("染色后可重复跑（幂等，供分页后重染）", () => {
    const { highlightCode } = require("../core/render/highlight")
    const before = withCode.html
    highlightCode(withCode.doc)
    assert.strictEqual(withCode.doc.body.innerHTML.includes("hljs-keyword"), true)
    assert.ok(before.length > 0)
  })
}

// ---- 8b. kit/player（播放器，jsdom 无布局只验行为）---------------------------

console.log("kit/player（播放器）")
check("接管 / 翻页 / 键盘 / 可见性 / 还原", () => {
  const { createDeckPlayer } = require("../kit/player")
  const root = document.createElement("div")
  document.body.appendChild(root)
  root.innerHTML = "<section data-slide>A</section><section data-slide>B</section><section data-slide>C</section>"
  const events = []
  const p = createDeckPlayer(root, { slideWidth: 1920, slideHeight: 1080, onChange: e => events.push(e.index) })
  assert.strictEqual(p.total, 3, "total 不对")
  assert.strictEqual(p.index, 1, "起始页不对")
  assert.ok(root.querySelector(":scope > .md2s-stage"), "stage 没建")
  assert.strictEqual(root.querySelectorAll(":scope .md2s-stage > section[data-slide]").length, 3, "页没搬进 stage")
  p.go(2)
  assert.deepStrictEqual(events, [1, 2], "onChange 没按序发")
  root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "ArrowRight" }))
  assert.strictEqual(p.index, 3, "键盘 → 无效")
  p.next()
  assert.strictEqual(p.index, 3, "末页 next 应钳住")
  root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Home" }))
  assert.strictEqual(p.index, 1, "Home 无效")
  const cur = [...root.querySelectorAll("section[data-slide]")].filter(s => s.classList.contains("md2s-current"))
  assert.deepStrictEqual(cur.map(s => s.textContent), ["A"], "可见页不对")
  p.destroy()
  assert.strictEqual(root.querySelectorAll(":scope > section[data-slide]").length, 3, "页没搬回")
  assert.ok(!root.querySelector(":scope > .md2s-stage"), "stage 没撤")
  assert.ok(!root.classList.contains("md2s-player"), "类没摘")
  root.remove()
})
check("element：步进表粒度（列表逐项 / 整表先行 / 标题锚点 / 键位）", () => {
  const { createDeckPlayer } = require("../kit/player")
  const root = document.createElement("div")
  document.body.appendChild(root)
  root.innerHTML = [
    "<section data-slide><h2>页标题</h2><p>引导语。</p>",
    "<ul><li>一</li><li>二</li><li>三</li></ul>",
    "<table><thead><tr><th>h</th></tr></thead><tbody>",
    "<tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody></table></section>",
    "<section data-slide>B</section>",
  ].join("")
  const p = createDeckPlayer(root, { mode: "element" })
  assert.strictEqual(p.total, 2)
  p.go(2)
  assert.strictEqual(p.steps, 0, "纯锚点页无步进")
  p.go(1)
  assert.strictEqual(p.steps, 8, "步数：p(1)+li(3)+整表(1)+行(3)")
  assert.ok(!root.querySelector("h2").classList.contains("md2s-step"), "标题不是步")
  // 隐藏元素 8 个 = 8 步各自一个（表格先把整套行按行占位藏掉）
  assert.strictEqual(root.querySelectorAll(".md2s-step-hidden").length, 8, "初始应全部隐藏")
  p.stepFwd(); p.stepFwd()
  assert.strictEqual(p.step, 2)
  assert.strictEqual(root.querySelectorAll(".md2s-step-past").length, 1, "累积：past=1")
  assert.strictEqual(root.querySelectorAll(".md2s-step-current").length, 1)
  assert.ok(root.querySelector("li").classList.contains("md2s-step-current"), "第一项应为当前步")
  for (let i = 0; i < 6; i++) p.stepFwd()
  assert.strictEqual(p.step, 8)
  // 退到表格的整表步：此刻只该有一个框——旧方案在这里是"表头 + 首行"两个框同时描边
  p.stepBack(); p.stepBack(); p.stepBack()
  assert.strictEqual(p.step, 5, "退三步应回到整表步")
  const steps = root.querySelectorAll(".md2s-step-current")
  assert.strictEqual(steps.length, 1, "同一时刻只该有一个当前步")
  assert.strictEqual(steps[0]?.tagName, "TABLE", "表格先整张表一步（表头不再各自成框）")
  assert.ok(root.querySelectorAll(".md2s-step-hidden").length > 0, "整表步：数据行仍占位隐藏")
  for (let i = 0; i < 3; i++) p.stepFwd()
  assert.strictEqual(p.step, 8, "恢复到步尽")
  root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "ArrowDown" }))
  assert.strictEqual(p.index, 2, "步尽 ↓ 应翻页")
  root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "ArrowUp" }))
  assert.strictEqual(p.index, 1, "第一步 ↑ 应回上一页")
  assert.strictEqual(p.step, 8, "回上一页应恢复步尽")
  root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "ArrowRight" }))
  assert.strictEqual(p.index, 2, "element 模式 ←→ 恒为翻页")
  p.destroy(); root.remove()
})
check("element：visibility 揭示 / 分栏递归 / setMode", () => {
  const { createDeckPlayer } = require("../kit/player")
  const root = document.createElement("div")
  document.body.appendChild(root)
  root.innerHTML = '<section data-slide><h2>T</h2>'
    + '<div class="cols cols-2"><div class="col"><p>左一</p><ul><li>l1</li><li>l2</li></ul></div>'
    + '<div class="col"><p>右一</p></div></div></section>'
  const p = createDeckPlayer(root, { mode: "element" })
  assert.strictEqual(p.steps, 4, "分栏应递归：左一+l1+l2+右一")
  const visibilityOf = el => document.defaultView.getComputedStyle(el).visibility
  assert.strictEqual(visibilityOf(root.querySelector(".col")), "visible", "容器不隐藏")
  const li = root.querySelectorAll("li")[1]
  assert.strictEqual(visibilityOf(li), "hidden", "未揭示项 visibility:hidden（占位不显示）")
  p.stepFwd(); p.stepFwd(); p.stepFwd()
  assert.strictEqual(visibilityOf(li), "visible", "揭示后可见")
  p.setMode("slide")
  assert.strictEqual(p.step, 0, "slide 模式无步概念")
  assert.strictEqual(visibilityOf(li), "visible", "slide 模式全显")
  p.setMode("element")
  assert.strictEqual(p.step, 0, "切回 element 当前页回第 0 步")
  assert.strictEqual(visibilityOf(li), "hidden")
  p.destroy(); root.remove()
})
check("steppers 钩子：图表切分 / 无钩子回退整块一步", () => {
  const { createDeckPlayer } = require("../kit/player")
  const mk = () => { const r = document.createElement("div"); document.body.appendChild(r); return r }
  const root = mk()
  root.innerHTML = '<section data-slide><h2>T</h2><div data-chart="pie">图</div></section>'
  const calls = []
  const p = createDeckPlayer(root, {
    mode: "element",
    steppers: [{ match: el => el.dataset?.chart != null, create: () => ({ count: 3, show: k => calls.push("s" + k), hide: k => calls.push("h" + k) }) }],
  })
  assert.strictEqual(p.steps, 3, "图表应切成 3 步")
  p.stepFwd(); p.stepFwd()
  assert.deepStrictEqual(calls, ["s0", "s1"], "show 序列不对")
  p.stepBack()
  assert.deepStrictEqual(calls, ["s0", "s1", "h1"], "回退应 hide")
  p.destroy(); root.remove()
  const root2 = mk()
  root2.innerHTML = '<section data-slide><h2>T</h2><div data-chart="pie">图</div></section>'
  const p2 = createDeckPlayer(root2, { mode: "element" })
  assert.strictEqual(p2.steps, 1, "无钩子图表应整块一步")
  p2.destroy(); root2.remove()
})
check("触屏手势：左右翻页 / 上下步进，与键盘同一语义", () => {
  const { createDeckPlayer } = require("../kit/player")
  const win = document.defaultView
  const mkRoot = () => {
    const el = document.createElement("div")
    document.body.appendChild(el)
    el.innerHTML = "<section data-slide><h2>T</h2><p>一</p><p>二</p></section>"
      + "<section data-slide>B</section><section data-slide>C</section>"
    return el
  }
  // jsdom 没有 PointerEvent → swipe 走 touch 路线；这里合成带 touches 的普通 Event
  // （dispatchEvent 只看 type，不在乎构造函数），四条序列 = 四种指法。
  const attach = (node, opts) => {
    const p = createDeckPlayer(node, { touchTimeout: 100000, ...opts })
    const fire = (type, x, y, n = 1) => {
      const e = new win.Event(type, { bubbles: true, cancelable: true })
      e.touches = n ? [{ identifier: 1, clientX: x, clientY: y }] : []
      e.changedTouches = e.touches
      node.dispatchEvent(e)
    }
    const swipe = (x0, y0, x1, y1) => { fire("touchstart", x0, y0); fire("touchmove", x1, y1); fire("touchend", x1, y1, 0) }
    return { p, fire, swipe }
  }

  const root = mkRoot()
  const { p, swipe } = attach(root)            // 默认 page + browse：两段落 = 两步
  assert.strictEqual(p.steps, 2, "步进表没建出来")
  swipe(500, 500, 400, 500)                    // ← 左滑
  assert.strictEqual(p.index, 2, "左滑应→下一页（同 → 键）")
  swipe(400, 500, 500, 500)                    // → 右滑
  assert.strictEqual(p.index, 1, "右滑应→上一页（同 ← 键）")
  swipe(500, 500, 500, 400)                    // ↑ 上滑
  assert.strictEqual(p.step, 1, "上滑应步进一次（同 ↓ 键）")
  swipe(500, 500, 500, 400)
  assert.strictEqual(p.step, 2, "第二次上滑应到第 2 步")
  swipe(500, 500, 500, 400)                    // 步尽溢出
  assert.strictEqual(p.index, 2, "步尽后上滑应翻页（键盘同款语义）")
  swipe(500, 500, 500, 600)                    // ↓ 下滑
  assert.strictEqual(p.index, 1, "下滑应回上一页")
  assert.strictEqual(p.step, 2, "回上一页应恢复它的步尽")

  //护栏：抖位移不翻、斜划不翻（20px / 斜 45° 都不到门槛）
  swipe(500, 500, 480, 500)
  assert.strictEqual(p.index, 1, "20px 抖动不该翻页")
  swipe(500, 500, 460, 460)
  assert.strictEqual(p.index, 1, "斜划（主轴不明）不该翻页")
  p.destroy(); root.remove()

  const root2 = mkRoot()
  const a2 = attach(root2)
  a2.fire("touchstart", 500, 500)
  const multi = new win.Event("touchmove", { bubbles: true, cancelable: true })
  multi.touches = [{ identifier: 1, clientX: 400, clientY: 500 }, { identifier: 2, clientX: 600, clientY: 500 }]
  multi.changedTouches = multi.touches
  root2.dispatchEvent(multi)
  assert.strictEqual(a2.p.index, 1, "双指期间不该翻页（那是 pinch 缩放）")
  a2.p.destroy(); root2.remove()

  // touch:false = 宿主彻底不接手势层
  const root3 = mkRoot()
  const a3 = attach(root3, { touch: false })
  a3.swipe(500, 500, 400, 500)
  assert.strictEqual(a3.p.index, 1, "touch:false 时手势不应生效")
  a3.p.destroy(); root3.remove()
})

check("触屏轻点：右半前进 / 左半后退，按钮·图片·长按不翻", () => {
  const { createDeckPlayer } = require("../kit/player")
  const win = document.defaultView
  const mkRoot = extra => {
    const el = document.createElement("div")
    document.body.appendChild(el)
    el.innerHTML = "<section data-slide><h2>T</h2><p>一</p><p>二</p>" + (extra ?? "") + "</section>"
      + "<section data-slide>B</section><section data-slide>C</section>"
    // jsdom 不做布局：钉一个矩形，「左半 / 右半」才有意义（player 读 root 的 rect）。
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, x: 0, y: 0,
    })
    return el
  }
  // 起点元素要能决定 target（dispatchEvent 的 target 是监听节点），所以显式传 target。
  const attach = (node, opts) => {
    const p = createDeckPlayer(node, { touchTimeout: 100000, ...opts })
    const fire = (target, type, x, y, n = 1) => {
      const e = new win.Event(type, { bubbles: true, cancelable: true })
      e.touches = n ? [{ identifier: 1, clientX: x, clientY: y }] : []
      e.changedTouches = e.touches
      target.dispatchEvent(e)
    }
    const tapAt = (target, x, y) => { fire(target, "touchstart", x, y); fire(target, "touchend", x, y, 0) }
    const tap = (x, y) => tapAt(node, x, y)
    return { p, fire, tap, tapAt }
  }

  const root = mkRoot()
  const { p, tap } = attach(root)
  assert.strictEqual(p.steps, 2, "步进表没建出来")
  tap(800, 300)                                    // 右半 = ↓：先步进
  assert.strictEqual(p.step, 1, "点右半应前进一步（同 ↓ 键）")
  tap(800, 300)
  assert.strictEqual(p.step, 2, "再点右半应到第 2 步")
  tap(800, 300)                                    // 步尽溢出
  assert.strictEqual(p.index, 2, "步尽后点右半应翻页")
  tap(200, 300)                                    // 左半 = ↑
  assert.strictEqual(p.index, 1, "点左半应回上一页")
  assert.strictEqual(p.step, 2, "回上一页应恢复它的步尽")
  tap(500, 300)                                    // 压线算前进，别让点正中没反应
  assert.strictEqual(p.index, 2, "点正中（fx=0.5）应前进而非后退")
  p.destroy(); root.remove()

  // 禁区：按钮 / 图片 / 可激活元素上轻点，只走它们自己的 click，不许顺带翻页
  for (const [label, html] of [
    ["按钮", '<button type="button">发放</button>'],
    ["图片", '<img src="a.png" alt="图">'],
    ["可激活元素", '<span data-md2s-activatable="">▶</span>'],
  ]) {
    const r = mkRoot(html)
    const a = attach(r)
    a.tapAt(r.querySelector("button,img,span"), 800, 300)
    assert.strictEqual(a.p.index, 1, `点${label}不该翻页`)
    assert.strictEqual(a.p.step, 0, `点${label}不该步进`)
    a.p.destroy(); r.remove()
  }

  // 长按（> tapTimeout）= 选词 / 长按菜单，不是点
  const rootLong = mkRoot()
  const aLong = attach(rootLong, { tapTimeout: 1 })
  aLong.fire(rootLong, "touchstart", 800, 300)
  const t0 = Date.now()
  while (Date.now() - t0 < 8) { /* 按住 8ms，足够越过 1ms 的 tap 门槛 */ }
  aLong.fire(rootLong, "touchend", 800, 300, 0)
  assert.strictEqual(aLong.p.step, 0, "长按不该算轻点")
  aLong.p.destroy(); rootLong.remove()

  // tapNav:"page" = 恒定整页翻；false = 关掉；触屏关掉时当然也没有轻点
  const rootPage = mkRoot()
  const aPage = attach(rootPage, { tapNav: "page" })
  aPage.tap(800, 300)
  assert.strictEqual(aPage.p.index, 2, 'tapNav:"page" 应直接翻页（不逐步揭示）')
  assert.strictEqual(aPage.p.step, 0, 'tapNav:"page" 不该动步进')
  aPage.p.destroy(); rootPage.remove()

  const rootOff = mkRoot()
  const aOff = attach(rootOff, { tapNav: false })
  aOff.tap(800, 300)
  assert.strictEqual(aOff.p.index, 1, "tapNav:false 时轻点不应导航")
  aOff.p.destroy(); rootOff.remove()

  const rootNoTouch = mkRoot()
  const aNoTouch = attach(rootNoTouch, { touch: false })
  aNoTouch.tap(800, 300)
  assert.strictEqual(aNoTouch.p.index, 1, "touch:false 时轻点也不该导航")
  aNoTouch.p.destroy(); rootNoTouch.remove()
})

// ---- 8b-bis. kit/lightbox（图片查看器，jsdom 无布局只验状态机）------------------

console.log("kit/lightbox（图片查看）")
check("打开 / fit / 缩放钳制 / 拖动边界 / pinch / 同页切图 / Esc", () => {
  const { mountLightbox } = require("../kit/lightbox")
  const win = document.defaultView
  const root = document.createElement("div")
  document.body.appendChild(root)
  root.innerHTML = '<section data-slide class="md2s-current">'
    + '<p><img src="a.png" alt="甲图"></p><p><img src="b.png" alt="乙图"></p></section>'
  const imgs = [...root.querySelectorAll("img")]
  const fire = (target, type, extra) => {
    const e = new win.Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, extra ?? {})
    target.dispatchEvent(e)
  }
  // key 是 KeyboardEvent 的只读 getter，只能走构造函数传，不能 Object.assign
  const key = k => document.body.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))
  const ptr = (type, id, x, y) => fire(document.querySelector(".md2s-lb-img"), type, {
    pointerId: id, pointerType: "touch", clientX: x, clientY: y,
  })

  const lb = mountLightbox(document, {})
  const lbImg = document.querySelector(".md2s-lb-img")
  const txOf = () => Number(/translate\((-?[\d.]+)px/.exec(lbImg.style.transform)?.[1] ?? NaN)
  // jsdom 不解码图片（naturalWidth 恒 0）：先把尺寸钉上去，再派发 resize 让它 measure
  Object.defineProperty(lbImg, "naturalWidth", { value: 2000, configurable: true })
  Object.defineProperty(lbImg, "naturalHeight", { value: 1200, configurable: true })

  fire(imgs[0], "click")
  assert.strictEqual(lb.isOpen, true, "点图片应打开")
  assert.strictEqual(lb.count, 2, "当前页两张图都应收进来")
  assert.strictEqual(lb.index, 0, "应停在被点的那张")
  assert.strictEqual(document.querySelector(".md2s-lb-cap").textContent, "甲图", "alt 应作为图注")
  win.dispatchEvent(new win.Event("resize"))

  const fitScale = lb.scale
  assert.ok(fitScale > 0 && fitScale < 1, `initial pose 应是适应比例 (0,1)：${fitScale}`)
  key("+")
  assert.ok(lb.scale > fitScale, "+ 应放大")
  for (let i = 0; i < 60; i++) key("+")
  assert.ok(lb.scale <= 8 + 1e-9, `放大到上限应停住：${lb.scale}`)
  for (let i = 0; i < 120; i++) key("-")
  assert.ok(lb.scale >= 0.1 - 1e-9, `缩小到下限应停住：${lb.scale}`)
  key("1")
  assert.ok(Math.abs(lb.scale - 1) < 1e-6, "1 键 = 1:1 原始像素")
  key("0")
  assert.ok(Math.abs(lb.scale - fitScale) < 1e-6, "0 键 = 适应屏幕")

  key("ArrowRight")
  assert.strictEqual(lb.index, 1, "→ 应切下一张")
  key("ArrowRight")
  assert.strictEqual(lb.index, 0, "末张 → 应循环回首张")
  assert.strictEqual(document.querySelector(".md2s-lb-cap").textContent, "甲图", "图注应跟着换")

  // 拖动：放大到超出视口才有可平移空间，且位移必须符合 clamped 边界
  for (let i = 0; i < 4; i++) key("+")
  const before = txOf()
  ptr("pointerdown", 1, 600, 400)
  ptr("pointermove", 1, 700, 400)
  assert.strictEqual(txOf(), before + 100, `单指右拖应位移 100px：${before} → ${txOf()}`)
  ptr("pointerup", 1, 700, 400)

  const k0 = lb.scale
  ptr("pointerdown", 1, 500, 400)
  ptr("pointerdown", 2, 700, 400)
  ptr("pointermove", 2, 900, 400)
  assert.ok(lb.scale > k0, `双指拉开应放大：${k0} → ${lb.scale}`)
  ptr("pointerup", 2, 900, 400)
  ptr("pointerup", 1, 500, 400)

  key("Escape")
  assert.strictEqual(lb.isOpen, false, "Esc 应关闭")
  fire(document.body, "click")
  assert.strictEqual(lb.isOpen, false, "点空白不该打开")
  lb.destroy()
  assert.strictEqual(document.querySelector(".md2s-lb"), null, "destroy 后浮层应拆掉")
  fire(imgs[1], "click")
  assert.strictEqual(lb.isOpen, false, "destroy 后点击委托应失效")
  root.remove()
})
check("查看器开着时输入不穿透到播放器（←→/滑动都不许翻页）", () => {
  const { createDeckPlayer } = require("../kit/player")
  const { mountLightbox } = require("../kit/lightbox")
  const win = document.defaultView
  const root = document.createElement("div")
  document.body.appendChild(root)
  root.innerHTML = '<section data-slide class="md2s-current"><p><img src="a.png" alt="图"></p></section>'
    + "<section data-slide>B</section><section data-slide>C</section>"
  const p = createDeckPlayer(root, { touchTimeout: 100000 })
  const lb = mountLightbox(document, {})
  const img = root.querySelector("img")
  const clickAt = node => node.dispatchEvent(
    new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
  const keyAt = k => root.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))

  clickAt(img)
  assert.strictEqual(lb.isOpen, true, "应先打开查看器")
  keyAt("ArrowRight")
  assert.strictEqual(p.index, 1, "开着查看器时 → 不许翻页（键盘被 window capture 拦下）")
  keyAt("ArrowDown")
  assert.strictEqual(p.step, 0, "开着查看器时 ↓ 不许步进")
  keyAt("Escape")
  assert.strictEqual(lb.isOpen, false, "Esc 关闭")
  keyAt("ArrowRight")
  assert.strictEqual(p.index, 2, "关闭后 → 应恢复翻页")
  lb.destroy()
  p.destroy()
  root.remove()
})

check("容器无尺寸时缩放保底 1（不把内容缩没了）", () => {
  const { createDeckPlayer } = require("../kit/player")
  const root = document.createElement("div")
  document.body.appendChild(root)
  root.innerHTML = "<section data-slide>A</section>"
  const p = createDeckPlayer(root, {})
  assert.strictEqual(Number(p.stage.style.getPropertyValue("--md2s-scale")), 1)
  p.destroy()
  root.remove()
})

// ---- 8c. 分号转列表（splitSemicolons 接线，2026-10-25 拍板：默认开 + fm 开关）----

console.log("splitSemicolons.js（分号转列表）")
check("护栏：句中句号/逗号/长短语不转换，围栏跳过", () => {
  const { splitSemicolons } = require("../core/split/splitSemicolons")
  const prose = splitSemicolons("今天晴。我们去公园；明天去爬山。")
  assert.ok(!prose.text.includes("- "), "句中带句号的散文不该转换")
  const comma = splitSemicolons("用户阳，AI阴；互济不盲从，制衡不妥协。")
  assert.ok(!comma.text.includes("- "), "短语内含逗号不该转换")
  const fenced = splitSemicolons("```sql\nSELECT a；b；c\n```")
  assert.ok(!fenced.text.includes("- a"), "围栏里的分号不该转换")
})
check("引导冒号拆分：引导行不进列表", () => {
  const { splitSemicolons } = require("../core/split/splitSemicolons")
  const r = splitSemicolons("优点包括：稳定；高效；易用。")
  assert.strictEqual(r.count, 1)
  assert.ok(r.text.startsWith("优点包括："), "引导行丢了")
  assert.deepStrictEqual(
    r.text.split("\n").slice(1),
    ["- 稳定", "- 高效", "- 易用"],
  )
})

if (document) {
  check("compose 接线：默认开 / front-matter 关 / opts 关", () => {
    const MD = "## t\n\n优点包括：稳定；高效；易用。\n"
    const on = compose(MD, { document })
    assert.strictEqual(on.semicolons, 1, "默认应转换")
    assert.ok(on.html.includes(">稳定</li>"), "列表没渲染出来")
    const fmOff = compose("---\nsemicolons: false\n---\n\n" + MD, { document })
    assert.strictEqual(fmOff.semicolons, 0, "front-matter 开关失效")
    assert.ok(fmOff.html.includes("稳定；高效"), "关闭后段落应原样保留")
    const optOff = compose(MD, { document, semicolons: false })
    assert.strictEqual(optOff.semicolons, 0, "opts 开关失效")
  })
}

// ---- 9. 公开 API 面（index.js，P-1 库化）------------------------------------
// 契约见 docs/API.md；纸面消费者 docs/integration-marktext.md 引用的每个出口都必须在这里。

console.log("index.js（公开 API 面）")
const md2slides = require("../")
check("管线五入口都是函数", () => {
  for (const name of ["compose", "renderDiagrams", "splitOverflow", "highlightCode", "extractIr"]) {
    assert.strictEqual(typeof md2slides[name], "function", `${name} 不是函数`)
  }
})
check("闸门与页容器契约出口都在", () => {
  for (const name of ["checkIr", "assertDiagramsRendered", "sectionsOf", "beginMeasure", "endMeasure", "createDeckPlayer"]) {
    assert.strictEqual(typeof md2slides[name], "function", `${name} 不是函数`)
  }
  assert.strictEqual(md2slides.SLIDE_SELECTOR, "section[data-slide]", "页容器选择器漂了")
})
check("契约常量：IR_VERSION / DiagramError / CONT_CSS / TOC_CSS / DECK_DEFAULTS", () => {
  assert.strictEqual(md2slides.IR_VERSION, 1, "IR 契约版本应为 1（v1 冻结）")
  assert.ok(typeof md2slides.DiagramError === "function", "DiagramError 不可 instanceof")
  assert.ok(md2slides.CONT_CSS.length > 0 && md2slides.CONT_CLASS.length > 0, "续页标记样式/类名缺失")
  assert.ok(md2slides.TOC_CSS.length > 0, "目录页兜底样式缺失")
  assert.ok(md2slides.DECK_DEFAULTS.headingDivider === 3, "默认分页级别漂了")
})

if (document) {
  check("公开入口能跑通 compose（转发的是同一实现）", () => {
    const deck = md2slides.compose("---\ntitle: 库入口冒烟\n---\n\n# 标题\n\n正文。\n", { document })
    assert.ok(deck.slideCount >= 1, "一页都没有")
    assert.strictEqual(deck.meta.title, "库入口冒烟", "meta 没透出")
    assert.ok(deck.css.length > 0 && deck.html.includes("data-slide"), "css/html 不成形")
  })
}

// ---- 8. 方言语料（e2e/fixtures/dialect/，与 marktext muya 共享） ---------------

// 这批文件是两个引擎的**同一份**方言输入（契约见该目录 README）：这里锁 md2slides
// 侧的解析行为；muya 侧（marktext fork 的 columns 测试）消费同一批文件。哪边改了
// 行为、与对方对不上，先红的是自己家——「用户混用两个编辑器时行为分叉」由这盯住。
{
  const DIALECT = path.join(__dirname, "..", "e2e", "fixtures", "dialect")
  const read = name => fs.readFileSync(path.join(DIALECT, name), "utf8")
  const markerCount = (text, marker) => (text.match(new RegExp(`<!-- ${marker}`, "g")) ?? []).length

  console.log("fixtures/dialect（方言语料）")

  check("cols.md：三组全部合法展开（等宽 / 30:70 / 25:25:50），零诊断", () => {
    const { text, count, diagnostics } = expandColumns(read("cols.md"))
    assert.strictEqual(count, 3, `应展开 3 组，实际 ${count}`)
    assert.deepStrictEqual(diagnostics, [], "合法语料不该有诊断")
    assert.strictEqual((text.match(/class="cols cols-2"/g) ?? []).length, 2)
    assert.strictEqual((text.match(/class="cols cols-3"/g) ?? []).length, 1)
    assert.ok(/flex: 30 1 0/.test(text) && /flex: 50 1 0/.test(text), "占比栏宽没生效")
  })

  check("cols.md：真标记全被消费，围栏内标记保持字面", () => {
    // 三组共 3 个真标记 + 围栏里 3 个字面副本；展开后应只剩围栏那份。
    const { text } = expandColumns(read("cols.md"))
    assert.strictEqual(markerCount(text, "begin"), 1, "只剩围栏里那一个 begin")
    assert.strictEqual(markerCount(text, "split"), 1, "只剩围栏里那一个 split")
    assert.strictEqual(markerCount(text, "end"), 1, "只剩围栏里那一个 end")
  })

  check("frontmatter.md：八键全部解析", () => {
    const meta = deckMeta(read("frontmatter.md"))
    assert.strictEqual(meta.title, "方言语料·八键封面")
    assert.strictEqual(meta.subtitle, "marktext 与 md2slides 的共享文档")
    assert.strictEqual(meta.author, "md-ecosystem")
    assert.strictEqual(meta.date, "2026-10-30")
    assert.strictEqual(meta.header, true)
    assert.strictEqual(meta.footer, "方言测试")
    assert.strictEqual(meta.toc, false)
    assert.deepStrictEqual(meta.keywords, ["分栏", "分页", "front-matter"])
  })

  if (document) {
    check("frontmatter.md：compose 出封面 + 两个章节页", () => {
      const deck = compose(read("frontmatter.md"), { document })
      assert.strictEqual(deck.slideCount, 3, `封面 + 引言 + 第一节 = 3 页，实际 ${deck.slideCount}`)
      assert.ok(/class="cover"/.test(deck.html), "没生成封面页")
    })

    check("slidebreak.md：裸 --- 全部切页，分页符本身不进页", () => {
      const out = sectionize(renderMarkdown(read("slidebreak.md")), { document })
      assert.strictEqual(out.slideCount, 3, `应为 3 页，实际 ${out.slideCount}`)
      assert.ok(!/<hr[ >]/.test(out.html), "hr 被当成内容留在页里")
    })
  }
}

console.log(`\n${passed} passed${process.exitCode ? "（有失败）" : ""}`)
