"use strict"

/** 契约 v1 §4.1：播放器按「页进入 / 步成为当前」切换 .md2s-anim-play。 */

const test = require("node:test")
const assert = require("node:assert/strict")
const { JSDOM } = require("jsdom")

const { createDeckPlayer, ANIM_PLAY_CLASS } = require("../../kit/player")
const { ANIM_PLAY_CLASS: VALIDATOR_CLASS } = require("../../core/htmlDeck/validate")

const mount = html => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="host"></div></body></html>`)
  const { document } = dom.window
  const root = document.getElementById("host")
  root.innerHTML = html
  return { document, root }
}

test("播放器与校验器共用同一个保留类名（防漂移）", () => {
  assert.equal(ANIM_PLAY_CLASS, "md2s-anim-play")
  assert.equal(ANIM_PLAY_CLASS, VALIDATOR_CLASS)
})

test("纯翻页形态：页进入触发页内动画，离页移除，回来可重播", () => {
  const { root } = mount(`
    <section data-slide><div data-md2s-anim id="a1">页1包</div></section>
    <section data-slide><div data-md2s-anim id="a2">页2包</div></section>
  `)
  const p = createDeckPlayer(root, { slideWidth: 1920, slideHeight: 1080, mode: "slide" })
  const a1 = root.querySelector("#a1")
  const a2 = root.querySelector("#a2")

  assert.ok(a1.classList.contains(ANIM_PLAY_CLASS), "第 1 页进入应触发")
  assert.ok(!a2.classList.contains(ANIM_PLAY_CLASS), "第 2 页未进入不该触发")

  p.next()
  assert.ok(!a1.classList.contains(ANIM_PLAY_CLASS), "离页应移除（复位静态终态）")
  assert.ok(a2.classList.contains(ANIM_PLAY_CLASS), "第 2 页进入应触发")

  p.prev()
  assert.ok(a1.classList.contains(ANIM_PLAY_CLASS), "回看应重新触发")
  assert.ok(!a2.classList.contains(ANIM_PLAY_CLASS))
  p.destroy()
})

test("逐元素形态：步成为当前才触发，离开该步移除", () => {
  const { root } = mount(`
    <section data-slide>
      <h2>标题</h2>
      <p data-md2s-anim id="p1">第一段动画</p>
      <p data-md2s-anim id="p2">第二段动画</p>
    </section>
  `)
  const p = createDeckPlayer(root, { slideWidth: 1920, slideHeight: 1080, mode: "page", browse: true })
  const p1 = root.querySelector("#p1")
  const p2 = root.querySelector("#p2")
  assert.ok(p.steps >= 2)

  // 起始只有标题锚点，两个段落都还没轮到
  assert.ok(!p1.classList.contains(ANIM_PLAY_CLASS))
  assert.ok(!p2.classList.contains(ANIM_PLAY_CLASS))

  p.stepFwd()
  assert.ok(p1.classList.contains(ANIM_PLAY_CLASS), "第 1 步成为当前应触发")
  assert.ok(!p2.classList.contains(ANIM_PLAY_CLASS))

  p.stepFwd()
  assert.ok(!p1.classList.contains(ANIM_PLAY_CLASS), "不再是当前步应移除")
  assert.ok(p2.classList.contains(ANIM_PLAY_CLASS), "第 2 步成为当前应触发")

  p.stepBack()
  assert.ok(p1.classList.contains(ANIM_PLAY_CLASS), "回退应重播")
  assert.ok(!p2.classList.contains(ANIM_PLAY_CLASS))
  p.destroy()
})

test("不属于任何步的元素（标题/家具）在页进入时触发", () => {
  const { root } = mount(`
    <section data-slide>
      <h2 data-md2s-anim id="title">标题动画</h2>
      <p>正文</p>
    </section>
    <section data-slide>第二页</section>
  `)
  const p = createDeckPlayer(root, { slideWidth: 1920, slideHeight: 1080, mode: "page", browse: true })
  const title = root.querySelector("#title")
  assert.ok(title.classList.contains(ANIM_PLAY_CLASS), "标题是锚点，不进步表 → 页进入即触发")
  p.next()
  assert.ok(!title.classList.contains(ANIM_PLAY_CLASS), "离页应移除")
  p.destroy()
})

test("freezeAnims 冻结静态终态（导出路径），unfreeze 恢复", () => {
  const { root } = mount(`<section data-slide><div data-md2s-anim id="a">包</div></section>`)
  const p = createDeckPlayer(root, { slideWidth: 1920, slideHeight: 1080, mode: "slide" })
  const a = root.querySelector("#a")
  assert.ok(a.classList.contains(ANIM_PLAY_CLASS))

  p.freezeAnims()
  assert.ok(!a.classList.contains(ANIM_PLAY_CLASS), "导出期间不应有播放类")
  p.next() // 单页钳住，但不应重新加类
  assert.ok(!a.classList.contains(ANIM_PLAY_CLASS), "冻结期间翻页也不触发")

  p.unfreezeAnims()
  assert.ok(a.classList.contains(ANIM_PLAY_CLASS), "解冻后回到当前进度")
  p.destroy()
})

test("destroy 后文稿节点复位到静态终态", () => {
  const { root } = mount(`<section data-slide><div data-md2s-anim id="a">包</div></section>`)
  const p = createDeckPlayer(root, { slideWidth: 1920, slideHeight: 1080, mode: "slide" })
  const a = root.querySelector("#a")
  assert.ok(a.classList.contains(ANIM_PLAY_CLASS))
  p.destroy()
  assert.ok(!a.classList.contains(ANIM_PLAY_CLASS))
})

test("无 data-md2s-anim 的普通 deck 零回归", () => {
  const { root } = mount(`
    <section data-slide><h2>A</h2><p>正文</p></section>
    <section data-slide><h2>B</h2><ul><li>一</li><li>二</li></ul></section>
  `)
  const events = []
  const p = createDeckPlayer(root, {
    slideWidth: 1920, slideHeight: 1080, mode: "page", browse: true,
    onChange: e => events.push(e.index),
  })
  assert.equal(p.total, 2)
  p.stepFwd()
  p.next()
  assert.equal(p.index, 2)
  assert.equal(root.querySelectorAll(`.${ANIM_PLAY_CLASS}`).length, 0)
  assert.ok(events.length >= 2)
  p.destroy()
})
