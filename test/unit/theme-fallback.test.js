"use strict"
// 主题回退回归：front-matter 写了不存在的主题名时，compose 不能静默返回
// 一份没有主题 CSS 的 deck（黑底小字错位的残页）——回退到默认主题，
// 并把警告交给宿主（deck 面板的提示胶囊）。

const test = require("node:test")
const assert = require("node:assert/strict")
const { JSDOM } = require("jsdom")

const { compose, DECK_DEFAULTS } = require("../../core/compose")

const doc = () => new JSDOM("<!doctype html><html><body></body></html>").window.document

const md = theme => `---
theme: ${theme}
title: 主题回退
---

# 第一节

正文。
`

test("未知主题回退到默认主题，并给出可读警告", () => {
  const deck = compose(md("python-mini-pptx"), { document: doc() })
  assert.equal(deck.theme, DECK_DEFAULTS.theme)
  assert.match(deck.themeWarning, /python-mini-pptx/)
  assert.match(deck.themeWarning, new RegExp(DECK_DEFAULTS.theme))
  // 关键：回退后主题 CSS 必须真的在，不能再是空串。
  assert.match(deck.css, /section/)
})

test("主题存在时没有警告", () => {
  const deck = compose(md(DECK_DEFAULTS.theme), { document: doc() })
  assert.equal(deck.theme, DECK_DEFAULTS.theme)
  assert.equal(deck.themeWarning, null)
})
