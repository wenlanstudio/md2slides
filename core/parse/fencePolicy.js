"use strict"

/**
 * fencePolicy.js — 围栏节点策略钩子（ARCHITECTURE ADR-6「通用节点规则钩子」的
 * M1.5 第一面：hide）。
 *
 * 机制与语义分离：本文件只认识「动词 → 动作」的通用规则表，不认识任何教学
 * 概念；默认规则表来自 core/teaching-fences（载荷围栏 → hide）。宿主要扩展
 * （教师版转备注、课堂题换占位，M2a）时传自己的表，机制不变。
 *
 * 为什么在 token 流上删而不是渲染后过滤：markdown-it 的 fence 是单个 token，
 * 删掉它，HTML、IR、PPTX 三条下游产物天然全干净——「预览什么样，导出就什么
 * 样」在泄题问题上同样成立，过滤层越靠下游，漏一处就是一次事故。
 *
 * 通用产品里为什么敢默认删这三个动词：它们是 SPEC 的教学词汇（载荷围栏族），
 * 不是通用 Markdown 方言；普通讲义不会用 `check-code` 当代码高亮语言。
 * 普通代码块（java/csv/`java map` slot/`file=` 数据块）首词不在表内，一律保留。
 */

/**
 * @param {object} instance markdown-it 实例
 * @param {Record<string, string>} actions 动词 → 动作（当前支持 "hide"；未知动作忽略）
 * @returns {object} instance（链式）
 */
function registerFencePolicy(instance, actions) {
  const table = actions ?? {}
  instance.core.ruler.push("fencePolicy", state => {
    const tokens = state.tokens
    // 倒序遍历：splice 不扰动未检查的下标
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i]
      if (token.type !== "fence") continue
      const info = String(token.info ?? "").trim()
      if (!info) continue
      const verb = info.split(/\s+/)[0].toLowerCase()
      if (table[verb] === "hide") tokens.splice(i, 1)
    }
    return false
  })
  return instance
}

module.exports = { registerFencePolicy }
