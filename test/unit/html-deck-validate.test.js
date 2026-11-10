"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { existsSync, readFileSync } = require("node:fs")
const path = require("node:path")
const { JSDOM } = require("jsdom")

const {
  validateHtmlDeck,
  formatIssues,
  cssRules,
  CONTRACT_VERSION,
  ANIM_PLAY_CLASS,
} = require("../../core/htmlDeck/validate")

const parse = html => new JSDOM(html).window.document

/** 契约 §3 的最小合规样例（带页标题，故无 R12 警告）。 */
const MINIMAL = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="wenlan-deck:canvas" content="1920x1080">
<style>
  section[data-slide] { padding: 96px 120px; font: 42px system-ui, sans-serif; }
  h1 { font-size: 88px; }
</style></head><body>
<div id="deck" data-wenlan-deck="1">
  <section data-slide data-md2s-title="封面"><h1>标题</h1></section>
  <section data-slide data-md2s-title="要点"><ul><li>一</li><li>二</li></ul></section>
</div></body></html>`

const codesOf = result => result.errors.map(i => i.code)
const hasCode = (result, code) => result.errors.some(i => i.code === code)

test("最小合规样例：ok、版本、画布、无 error", () => {
  const r = validateHtmlDeck(parse(MINIMAL))
  assert.equal(r.ok, true, formatIssues(r))
  assert.equal(r.version, CONTRACT_VERSION)
  assert.deepEqual(r.canvas, { width: 1920, height: 1080 })
  assert.equal(r.errors.length, 0)
  assert.equal(r.warns.length, 0)
})

test("缺省画布 meta 时回落 1920x1080；可用 x 或 × 声明", () => {
  const noMeta = MINIMAL.replace(/<meta name="wenlan-deck:canvas"[^>]*>/, "")
  assert.deepEqual(validateHtmlDeck(parse(noMeta)).canvas, { width: 1920, height: 1080 })

  const cross = MINIMAL.replace('content="1920x1080"', 'content="1280×720"')
  const r = validateHtmlDeck(parse(cross))
  assert.deepEqual(r.canvas, { width: 1280, height: 720 })
  // 页上没有内联尺寸，所以画布改小不触发 R6
  assert.equal(r.ok, true)
})

test("画布 meta 格式非法 / 零尺寸 → E_CANVAS_CONFLICT", () => {
  for (const content of ["abc", "1920", "0x1080"]) {
    const html = MINIMAL.replace('content="1920x1080"', `content="${content}"`)
    assert.equal(hasCode(validateHtmlDeck(parse(html)), "E_CANVAS_CONFLICT"), true, content)
  }
})

test("R1：无 #deck → E_NO_ROOT；多个 #deck → E_NO_ROOT", () => {
  const none = parse("<html><body><section data-slide>x</section></body></html>")
  assert.equal(hasCode(validateHtmlDeck(none), "E_NO_ROOT"), true)

  const twice = parse(`<html><body>
    <div id="deck" data-wenlan-deck="1"><section data-slide>a</section></div>
    <div id="deck" data-wenlan-deck="1"><section data-slide>b</section></div>
  </body></html>`)
  assert.equal(hasCode(validateHtmlDeck(twice), "E_NO_ROOT"), true)
})

test("R1：缺版本声明 → E_NO_VERSION（不按 v1 猜）；未知版本 → E_UNSUPPORTED_VERSION", () => {
  const noVer = MINIMAL.replace(' data-wenlan-deck="1"', "")
  const r1 = validateHtmlDeck(parse(noVer))
  assert.equal(hasCode(r1, "E_NO_VERSION"), true)
  assert.equal(r1.ok, false)

  const badVer = MINIMAL.replace('data-wenlan-deck="1"', 'data-wenlan-deck="9"')
  assert.equal(hasCode(validateHtmlDeck(parse(badVer)), "E_UNSUPPORTED_VERSION"), true)
})

test("R2：0 页 → E_NO_SLIDES（绝不自动包单页）；嵌套页 → E_NESTED_SLIDES", () => {
  const empty = parse(`<html><body><div id="deck" data-wenlan-deck="1">
    <p>一个普通网页</p></div></body></html>`)
  const r0 = validateHtmlDeck(empty)
  assert.equal(hasCode(r0, "E_NO_SLIDES"), true)
  assert.equal(r0.ok, false)
  assert.doesNotMatch(formatIssues(r0), /单页放映/)

  const nested = MINIMAL.replace(
    '<section data-slide data-md2s-title="要点">',
    '<div><section data-slide data-md2s-title="要点">'
  ).replace("</ul></section>", "</ul></section></div>")
  assert.equal(hasCode(validateHtmlDeck(parse(nested)), "E_NESTED_SLIDES"), true)
})

test("R3：script / on* / javascript: / iframe → E_SCRIPT", () => {
  const cases = [
    "<script>go()</script>",
    '<button onclick="go()">x</button>',
    '<a href="javascript:go()">x</a>',
    "<iframe src=\"x\"></iframe>",
  ]
  for (const extra of cases) {
    const html = MINIMAL.replace("</body>", `${extra}</body>`)
    assert.equal(hasCode(validateHtmlDeck(parse(html)), "E_SCRIPT"), true, extra)
  }
})

test("R4：#stage / is-active / class=slide 分页 / section 可见性规则 → E_PLAYER_RESIDUE", () => {
  const cases = [
    '<div id="stage"><p>x</p></div>',
    '<section data-slide class="is-active" data-md2s-title="x">x</section>',
    '<div class="slide">x</div>',
  ]
  for (const extra of cases) {
    const html = MINIMAL.replace("</body>", `${extra}</body>`)
    assert.equal(hasCode(validateHtmlDeck(parse(html)), "E_PLAYER_RESIDUE"), true, extra)
  }
  const hidden = MINIMAL.replace(
    "h1 { font-size: 88px; }",
    "section[data-slide] { display: none; }"
  )
  assert.equal(hasCode(validateHtmlDeck(parse(hidden)), "E_PLAYER_RESIDUE"), true)
})

test("R5：link / @import / url(http) / 外链 img → E_EXTERNAL", () => {
  const cases = [
    '<link rel="stylesheet" href="a.css">',
    '<style>@import url("a.css");</style>',
    '<style>.x{background:url(https://cdn.example.com/a.png)}</style>',
    '<img src="https://example.com/a.png">',
  ]
  for (const extra of cases) {
    const html = MINIMAL.replace("</body>", `${extra}</body>`)
    assert.equal(hasCode(validateHtmlDeck(parse(html)), "E_EXTERNAL"), true, extra)
  }
})

test("R6：页内联尺寸与画布冲突 → error；相同 → 仅 R12 warn", () => {
  const conflict = MINIMAL.replace(
    '<section data-slide data-md2s-title="封面">',
    '<section data-slide data-md2s-title="封面" style="width:1280px;height:720px">'
  )
  assert.equal(hasCode(validateHtmlDeck(parse(conflict)), "E_CANVAS_CONFLICT"), true)

  const same = MINIMAL.replace(
    '<section data-slide data-md2s-title="封面">',
    '<section data-slide data-md2s-title="封面" style="width:1920px;height:1080px">'
  )
  const r = validateHtmlDeck(parse(same))
  assert.equal(r.ok, true)
  assert.equal(r.warns.some(w => w.code === "W_REDUNDANT_SIZE"), true)
})

test("R7：transform:scale / zoom / vw / @media → E_NESTED_SCALE 或 E_MEDIA_LAYOUT", () => {
  const cases = [
    ['<div style="transform:scale(1.5)">x</div>', "E_NESTED_SCALE"],
    ['<style>.x{zoom:1.5}</style>', "E_NESTED_SCALE"],
    ['<style>.x{width:50vw}</style>', "E_NESTED_SCALE"],
    ['<style>@media (min-width:900px){.x{width:100px}}</style>', "E_MEDIA_LAYOUT"],
  ]
  for (const [extra, code] of cases) {
    const html = MINIMAL.replace("</body>", `${extra}</body>`)
    assert.equal(hasCode(validateHtmlDeck(parse(html)), code), true, extra)
  }
})

test("R8：自动播放动画 → E_AUTO_ANIM；挂 .md2s-anim-play + data-md2s-anim 则合法", () => {
  const auto = MINIMAL.replace(
    "h1 { font-size: 88px; }",
    "@keyframes fly { from { transform: translateX(0) } to { transform: translateX(40px) } } .pkt { animation: fly 1s both; }"
  )
  const rAuto = validateHtmlDeck(parse(auto))
  assert.equal(hasCode(rAuto, "E_AUTO_ANIM"), true)
  assert.equal(rAuto.ok, false)

  const bound = `<!DOCTYPE html><html><head><style>
    @keyframes fly { from { transform: translateX(0) } to { transform: translateX(40px) } }
    .pkt[data-md2s-anim].${ANIM_PLAY_CLASS} { animation: fly 1.15s ease-out both; }
  </style></head><body>
  <div id="deck" data-wenlan-deck="1">
    <section data-slide data-md2s-title="动画页"><div class="pkt" data-md2s-anim="fly">包</div></section>
  </div></body></html>`
  const rBound = validateHtmlDeck(parse(bound))
  assert.equal(rBound.ok, true, formatIssues(rBound))
})

test("R8：infinite 循环禁止；gated 规则与 data-md2s-anim 必须配对", () => {
  const infinite = `<html><head><style>
    @keyframes f { from { opacity:0 } to { opacity:1 } }
    .pkt[data-md2s-anim].${ANIM_PLAY_CLASS}{ animation: f 1s infinite; }
  </style></head><body><div id="deck" data-wenlan-deck="1">
  <section data-slide data-md2s-title="x"><div class="pkt" data-md2s-anim>x</div></section>
  </div></body></html>`
  assert.equal(hasCode(validateHtmlDeck(parse(infinite)), "E_AUTO_ANIM"), true)

  const orphanEl = `<html><body><div id="deck" data-wenlan-deck="1">
  <section data-slide data-md2s-title="x"><div data-md2s-anim>x</div></section>
  </div></body></html>`
  assert.equal(hasCode(validateHtmlDeck(parse(orphanEl)), "E_AUTO_ANIM"), true)

  const orphanRule = `<html><head><style>
    @keyframes f { from { opacity:0 } to { opacity:1 } }
    .x.${ANIM_PLAY_CLASS}{ animation: f 1s both; }
  </style></head><body><div id="deck" data-wenlan-deck="1">
  <section data-slide data-md2s-title="x"><div class="x">x</div></section>
  </div></body></html>`
  assert.equal(hasCode(validateHtmlDeck(parse(orphanRule)), "E_AUTO_ANIM"), true)
})

test("R10：私有 data-* 未加前缀 → E_NS_COLLISION；data-x- 前缀合法", () => {
  const bad = MINIMAL.replace(
    '<section data-slide data-md2s-title="封面">',
    '<section data-slide data-md2s-title="封面" data-frame="1" data-chapter="封面">'
  )
  assert.equal(hasCode(validateHtmlDeck(parse(bad)), "E_NS_COLLISION"), true)

  const good = MINIMAL.replace(
    '<section data-slide data-md2s-title="封面">',
    '<section data-slide data-md2s-title="封面" data-x-frame="1" data-author-chapter="封面">'
  )
  assert.equal(validateHtmlDeck(parse(good)).ok, true)
})

test("R11：相对路径图片合法；外链图片 → E_EXTERNAL", () => {
  const rel = MINIMAL.replace("<h1>标题</h1>", '<h1>标题</h1><img src="./img/a.png">')
  assert.equal(validateHtmlDeck(parse(rel)).ok, true)
  const abs = MINIMAL.replace("<h1>标题</h1>", '<h1>标题</h1><img src="//cdn.example.com/a.png">')
  assert.equal(hasCode(validateHtmlDeck(parse(abs)), "E_EXTERNAL"), true)
})

test("R12：缺 data-md2s-title 只 warn，不阻止放映", () => {
  const noTitle = MINIMAL.replace(/ data-md2s-title="[^"]*"/g, "")
  const r = validateHtmlDeck(parse(noTitle))
  assert.equal(r.ok, true)
  assert.equal(r.warns.some(w => w.code === "W_NO_TITLE"), true)
})

test("Issue 结构完整：rule/code/severity/where/message/fix 六字段；formatIssues 可展示", () => {
  const r = validateHtmlDeck(parse("<html><body><p>普通网页</p></body></html>"))
  assert.equal(r.ok, false)
  for (const key of ["rule", "code", "severity", "where", "message", "fix"]) {
    assert.equal(typeof r.errors[0][key], "string", key)
    assert.ok(r.errors[0][key].length > 0, key)
  }
  const text = formatIssues(r)
  assert.match(text, /契约 v1/)
  assert.match(text, /\[R1/)
  assert.match(text, /→/)
  assert.match(text, /最小合规样例/)
})

test("cssRules：@keyframes 内部帧不当普通规则，@media 内部递归并标 inMedia", () => {
  const rules = cssRules(`
    @keyframes fly { from { transform: translateX(0) } to { transform: translateX(40px) } }
    .pkt.md2s-anim-play { animation: fly 1s both; }
    @media (min-width:900px) { .x { width: 50vw; } }
  `)
  assert.equal(rules.some(r => r.selector === "from"), false)
  assert.equal(rules.some(r => r.selector === ".pkt.md2s-anim-play"), true)
  assert.equal(rules.some(r => r.selector === ".x" && r.inMedia), true)
})

// ---- 真实样本：yarn-slides 三份文稿的裁决（契约 §9）-----------------------
// 该目录在用户工作机上，CI 无此路径时整组自动跳过。
const SAMPLES = "C:/Users/Yuan/WorkBuddy/2026-11-10-10-24-00/yarn-slides"

const sampleDoc = name => {
  const p = path.join(SAMPLES, name)
  if (!existsSync(p)) return null
  return parse(readFileSync(p, "utf8"))
}

test("样本 index.html：自带播放器 → 拒绝（R1/R2/R3/R4/R7）", t => {
  const doc = sampleDoc("index.html")
  if (!doc) return t.skip("样本目录不存在（CI）")
  const r = validateHtmlDeck(doc)
  assert.equal(r.ok, false)
  for (const code of ["E_NO_ROOT", "E_NO_SLIDES", "E_SCRIPT", "E_PLAYER_RESIDUE"]) {
    assert.equal(hasCode(r, code), true, `index.html 应命中 ${code}`)
  }
})

test("样本 deck.html：混合体 → 拒绝（R1 版本 / R4 / R7 二次缩放 / R8 自动动画）", t => {
  const doc = sampleDoc("deck.html")
  if (!doc) return t.skip("样本目录不存在（CI）")
  const r = validateHtmlDeck(doc)
  assert.equal(r.ok, false)
  for (const code of ["E_NO_VERSION", "E_PLAYER_RESIDUE", "E_NESTED_SCALE", "E_AUTO_ANIM"]) {
    assert.equal(hasCode(r, code), true, `deck.html 应命中 ${code}`)
  }
})

test("样本 animation-deck.html：最接近，error 恰为 R1/R8/R10，R12 只作 warn", t => {
  const doc = sampleDoc("animation-deck.html")
  if (!doc) return t.skip("样本目录不存在（CI）")
  const r = validateHtmlDeck(doc)
  assert.equal(r.ok, false)
  for (const code of ["E_NO_VERSION", "E_AUTO_ANIM", "E_NS_COLLISION"]) {
    assert.equal(hasCode(r, code), true, `animation-deck.html 应命中 ${code}`)
  }
  assert.equal(r.warns.some(w => w.code === "W_REDUNDANT_SIZE"), true)
  const rules = [...new Set(r.errors.map(i => i.rule))].sort()
  assert.deepEqual(rules, ["R1", "R10", "R8"])
  assert.equal(r.warns.some(w => w.rule === "R12"), true)
  assert.ok(codesOf(r).length > 0)
})

test("同类违规聚合：60 处相同私有属性只出 1 条带 ×N 的诊断", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    `<section data-slide data-md2s-title="p${i}" data-frame="${i}">x</section>`
  ).join("")
  const doc = parse(`<html><body><div id="deck" data-wenlan-deck="1">${rows}</div></body></html>`)
  const r = validateHtmlDeck(doc)
  const frame = r.errors.filter(i => i.code === "E_NS_COLLISION")
  assert.equal(frame.length, 1)
  assert.equal(frame[0].count, 60)
  assert.match(formatIssues(r), /×60/)
  assert.equal(r.rawCount, 60)
  assert.equal(r.errors.length, 1)
})

test("拒绝时诊断逐条可读：where/message/fix 都有内容", t => {
  const doc = sampleDoc("deck.html")
  if (!doc) return t.skip("样本目录不存在（CI）")
  const text = formatIssues(validateHtmlDeck(doc))
  assert.match(text, /必须修正/)
  assert.match(text, /→/)
  assert.ok(text.split("\n").length > 10)
})
