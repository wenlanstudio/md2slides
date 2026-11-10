"use strict"

/**
 * core/htmlDeck/validate.js — HTML 放映稿契约 v1 的静态校验器。
 *
 * 契约：md2slides/docs/html-deck-contract.md（引擎级协议，宿主无关）。
 *
 * 设计要点：
 *  · **接收已解析的 Document**，不碰 DOMParser / jsdom / Node API。宿主（iframe 内）
 *    用浏览器 DOMParser 解析字符串后传入；单测用 jsdom。同一份校验逻辑两端零差异，
 *    也不会把 Node 内置模块带进浏览器 bundle。
 *  · 校验发生在**注入之前**（契约 §2 的 ② 阶段）。有任何 error ⇒ 宿主拒绝放映，
 *    不包装、不降级、不猜测（P7）。
 *  · 只校验"文稿自己声明了什么"；宿主注入的播放器 CSS 不在这份 Document 里，
 *    不会被 .md2s-* 规则误伤。
 *
 * @param {Document} doc  由完整 HTML 文稿解析出的独立文档（不要求连到宿主 DOM）
 * @returns {{ ok: boolean, version: string|null, canvas: {width:number,height:number},
 *             issues: Issue[], errors: Issue[], warns: Issue[] }}
 */

const CONTRACT_VERSION = "1"
const DEFAULT_CANVAS = { width: 1920, height: 1080 }
const SLIDE_SELECTOR = "section[data-slide]"
const ANIM_PLAY_CLASS = "md2s-anim-play"

/** 保留的 data-* 前缀：作者私有属性必须用 data-x- / data-author-，其余归契约。 */
const RESERVED_DATA = new Set(["data-slide", "data-pagination", "data-wenlan-deck"])
const isContractData = name => RESERVED_DATA.has(name) || name.startsWith("data-md2s-")
const isPrivateData = name => name.startsWith("data-x-") || name.startsWith("data-author-")

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "")

/**
 * 轻量 CSS 规则切分：够用来判定「哪条选择器下出现了哪条声明」。
 * @keyframes 的内部帧不递归（帧里的 transform/animation 不是布局规则）；
 * @media / @supports / @layer / @container 的内部递归，并标 inMedia 供 R7 判违规。
 * @returns {Array<{selector:string, body:string, at:string|null, inMedia:boolean}>}
 */
function cssRules(text, inMedia = false) {
  const src = stripComments(text || "")
  const out = []
  let i = 0
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (i >= src.length) break
    const brace = src.indexOf("{", i)
    if (brace < 0) {
      // 只剩无块的 at-rule（@import / @charset …），按分号收尾，R5 要用。
      for (const part of src.slice(i).split(";")) {
        const head = part.trim()
        if (head.startsWith("@")) out.push({ selector: "", body: "", at: head, inMedia })
      }
      break
    }
    const semi = src.indexOf(";", i)
    if (semi >= 0 && semi < brace) {
      // 无块的 at-rule（@import / @charset）也记下来，R5 要用
      const head = src.slice(i, semi).trim()
      if (head.startsWith("@")) out.push({ selector: "", body: "", at: head, inMedia })
      i = semi + 1
      continue
    }
    const head = src.slice(i, brace).trim()
    let depth = 1
    let j = brace + 1
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++
      else if (src[j] === "}") depth--
      j++
    }
    const body = src.slice(brace + 1, j - 1)
    if (head.startsWith("@")) {
      out.push({ selector: "", body, at: head, inMedia })
      // @keyframes / @-webkit-keyframes 的内部帧不当普通规则
      if (/^@(media|supports|layer|container)\b/i.test(head)) {
        for (const r of cssRules(body, true)) out.push(r)
      }
    } else {
      out.push({ selector: head, body, at: null, inMedia })
    }
    i = j
  }
  return out
}

const hasDecl = (body, prop) =>
  new RegExp(`(?:^|;)\\s*(?:-[a-z]+-)?${prop}(?:-[a-z-]+)?\\s*:`, "i").test(body)

const collectStyles = doc => {
  const blocks = []
  doc.querySelectorAll("style").forEach((el, idx) => {
    blocks.push({ label: `<style> #${idx + 1}`, rules: cssRules(el.textContent || "") })
  })
  return blocks
}

/** 元素在文稿里的可读定位（诊断信息的 where 字段）。 */
const whereOf = (el, doc) => {
  if (!el || !el.tagName) return "文档"
  const tag = el.tagName.toLowerCase()
  const id = el.getAttribute?.("id")
  if (id) return `<${tag} id="${id}">`
  const cls = el.getAttribute?.("class")
  if (cls) return `<${tag} class="${String(cls).slice(0, 60)}">`
  const sections = [...doc.querySelectorAll(SLIDE_SELECTOR)]
  const si = sections.indexOf(el)
  if (si >= 0) return `第 ${si + 1} 页 <section data-slide>`
  return `<${tag}>`
}

const makeIssue = (rule, code, severity, where, message, fix) =>
  ({ rule, code, severity, where, message, fix })

/** 解析画布声明；缺省用默认值，格式错记 error。 */
const parseCanvas = (doc, issues) => {
  const meta = doc.querySelector('meta[name="wenlan-deck:canvas"]')
  if (!meta) return { ...DEFAULT_CANVAS }
  const raw = (meta.getAttribute("content") || "").trim()
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw)
  if (!m) {
    issues.push(makeIssue(
      "R6", "E_CANVAS_CONFLICT", "error", '<meta name="wenlan-deck:canvas">',
      `画布声明格式不合法："${raw}"`,
      '改成 content="1920x1080"（W x H，x 或 × 均可），或删掉该 meta 用默认 1920×1080'
    ))
    return { ...DEFAULT_CANVAS }
  }
  const width = Number(m[1])
  const height = Number(m[2])
  if (width <= 0 || height <= 0) {
    issues.push(makeIssue(
      "R6", "E_CANVAS_CONFLICT", "error", '<meta name="wenlan-deck:canvas">',
      `画布尺寸必须为正数，收到 ${width}×${height}`,
      '改成形如 content="1280x720" 的正整数尺寸'
    ))
    return { ...DEFAULT_CANVAS }
  }
  return { width, height }
}

/** R6：页内联尺寸与画布冲突记 error；一致记 R12 warn（冗余）。 */
const checkPageSizes = (sections, canvas, issues, doc) => {
  sections.forEach(sec => {
    const raw = sec.getAttribute("style") || ""
    const w = /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(raw)
    const h = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(raw)
    if (!w && !h) return
    const sw = w ? Number(w[1]) : null
    const sh = h ? Number(h[1]) : null
    if ((sw !== null && sw !== canvas.width) || (sh !== null && sh !== canvas.height)) {
      issues.push(makeIssue(
        "R6", "E_CANVAS_CONFLICT", "error", whereOf(sec, doc),
        `页内联尺寸 ${sw ?? "?"}×${sh ?? "?"} 与契约画布 ${canvas.width}×${canvas.height} 冲突`,
        `删掉该页内联 width/height，由宿主按画布统一钉死；若确需 ${sw}×${sh} 画布，改 <meta name="wenlan-deck:canvas" content="${sw}x${sh}">`
      ))
    } else {
      issues.push(makeIssue(
        "R12", "W_REDUNDANT_SIZE", "warn", whereOf(sec, doc),
        "页上写了与画布相同的内联 width/height（冗余）",
        "删掉内联尺寸，画布由宿主统一设置"
      ))
    }
  })
}

/** R7 / R8：扫描所有 CSS 规则与内联 style 的声明。 */
const checkCss = (doc, styleBlocks, issues) => {
  const inlineDecls = []
  doc.querySelectorAll("[style]").forEach(el => {
    inlineDecls.push({ el, text: el.getAttribute("style") || "", inMedia: false })
  })

  // R5：@import / url(http) 外链
  for (const block of styleBlocks) {
    for (const r of block.rules) {
      if (r.at && /^@import\b/i.test(r.at)) {
        issues.push(makeIssue(
          "R5", "E_EXTERNAL", "error", `${block.label} ${r.at.slice(0, 60)}`,
          "CSS @import 外链资源",
          "把样式内联进 <style>，或改成相对同目录路径；文稿必须自包含"
        ))
      }
      if (r.body && /url\(\s*['"]?\s*(?:https?:)?\/\//i.test(r.body)) {
        issues.push(makeIssue(
          "R5", "E_EXTERNAL", "error", `${block.label} ${r.selector || r.at}`,
          "CSS 引用了 http(s) 外链资源",
          "改成 data: URI 或相对文稿所在目录的路径"
        ))
      }
    }
  }

  // R7：@media 内的布局规则（固定画布不需要响应式）
  for (const block of styleBlocks) {
    for (const r of block.rules) {
      if (r.at && /^@(media|container)\b/i.test(r.at)) {
        issues.push(makeIssue(
          "R7", "E_MEDIA_LAYOUT", "error", `${block.label} ${r.at.slice(0, 60)}`,
          "@media/@container 会随视口改变布局，破坏固定画布的确定性",
          "删掉该 at-rule；画布尺寸恒定，页内布局不应依赖视口"
        ))
      }
    }
  }

  // R4：自带播放器机制也常只残留在 CSS 选择器里（DOM 上已无 #stage / is-active）。
  // 只认"分页/可见性"语义，避免把普通的 .slide 版式类误判。
  for (const block of styleBlocks) {
    for (const r of block.rules) {
      if (r.at || !r.selector) continue
      const sel = r.selector
      const label = `${block.label} ${sel.slice(0, 80)}`
      const controlsVisibility = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|position\s*:\s*absolute)/i.test(r.body)
      if (/#stage\b/.test(sel)) {
        issues.push(makeIssue(
          "R4", "E_PLAYER_RESIDUE", "error", label,
          "#stage 是自带播放器的舞台容器（播放器会把页搬进自己的 .md2s-stage）",
          "删掉 #stage 及相关规则；页容器只保留 <div id=\"deck\">"
        ))
      } else if (/\.is-active\b/.test(sel)) {
        issues.push(makeIssue(
          "R4", "E_PLAYER_RESIDUE", "error", label,
          ".is-active 是自带播放器的当前页标记",
          "删掉该类及相关规则；当前页由播放器的 .md2s-current 决定"
        ))
      } else if (/\.slide\b/.test(sel) && !/\[data-slide\]/.test(sel) && controlsVisibility) {
        issues.push(makeIssue(
          "R4", "E_PLAYER_RESIDUE", "error", label,
          "以 .slide 类充当分页并自行控制可见性（契约只认 section[data-slide]）",
          "改成 section[data-slide] 选择器，并删掉 display:none / position:absolute 等可见性控制；可见性归播放器"
        ))
      }
    }
  }

  // R7 / R8：普通规则 + 内联声明
  const declSources = []
  for (const block of styleBlocks) {
    for (const r of block.rules) {
      if (r.at || !r.selector) continue
      declSources.push({
        label: `${block.label} ${r.selector.slice(0, 80)}`,
        selector: r.selector, text: r.body, el: null
      })
    }
  }
  for (const d of inlineDecls) {
    declSources.push({
      label: `${whereOf(d.el, doc)} 内联 style`,
      selector: "", text: d.text, el: d.el
    })
  }

  let gatedAnimRules = 0
  for (const src of declSources) {
    // R7：二次缩放 / zoom / 视口单位
    if (/\btransform\s*:[^;]*\bscale\s*\(/i.test(src.text) ||
        /(?:^|;)\s*zoom\s*:/i.test(src.text) ||
        /\d+(?:\.\d+)?\s*(?:vw|vh|vmin|vmax)\b/i.test(src.text)) {
      issues.push(makeIssue(
        "R7", "E_NESTED_SCALE", "error", src.label,
        "页内出现 transform:scale / zoom / vw·vh 视口单位（第二套坐标系）",
        "按契约画布重新排版（尺寸按比例换算），不要套一层 scale()；缩放只由宿主做一次"
      ))
    }

    // R4：文稿自己控制 section 的可见性
    if (src.selector && /section\[data-slide\]/i.test(src.selector) &&
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(src.text)) {
      issues.push(makeIssue(
        "R4", "E_PLAYER_RESIDUE", "error", src.label,
        "文稿给 section[data-slide] 写了 display:none / visibility:hidden",
        "可见性归播放器（.md2s-current）独占，删掉这条规则"
      ))
    }


    // R8：动画声明必须挂在 .md2s-anim-play 下，且无限循环禁止
    const hasAnim = hasDecl(src.text, "animation") || hasDecl(src.text, "transition")
    if (!hasAnim) continue
    if (/infinite/i.test(src.text) && hasDecl(src.text, "animation")) {
      issues.push(makeIssue(
        "R8", "E_AUTO_ANIM", "error", src.label,
        "无限循环动画（infinite）与静态确定性冲突",
        "改成有限次数的一次性动画，或按 §4.1 绑定 .md2s-anim-play 由宿主触发"
      ))
    }
    if (!src.selector.includes(`.${ANIM_PLAY_CLASS}`)) {
      issues.push(makeIssue(
        "R8", "E_AUTO_ANIM", "error", src.label,
        `animation/transition 未挂在宿主保留类 .${ANIM_PLAY_CLASS} 下（自动播放）`,
        `把声明改成 元素[data-md2s-anim].${ANIM_PLAY_CLASS} { animation: … }，并给元素加 data-md2s-anim；触发时机由播放器按翻页/步进决定（契约 §4.1）`
      ))
    } else {
      gatedAnimRules += 1
    }
  }

  // R8 配对：声明了 data-md2s-anim 却没有对应的 gated 规则 → 动画永远不会触发
  const animEls = [...doc.querySelectorAll("[data-md2s-anim]")]
  if (animEls.length > 0 && gatedAnimRules === 0) {
    issues.push(makeIssue(
      "R8", "E_AUTO_ANIM", "error", whereOf(animEls[0], doc),
      `元素带 data-md2s-anim，但没有任何挂在 .${ANIM_PLAY_CLASS} 下的动画规则`,
      `在 <style> 里补一条 [data-md2s-anim].${ANIM_PLAY_CLASS} { animation: … }`
    ))
  } else if (gatedAnimRules > 0 && animEls.length === 0) {
    issues.push(makeIssue(
      "R8", "E_AUTO_ANIM", "error", "样式表",
      `存在 .${ANIM_PLAY_CLASS} 动画规则，但文稿里没有带 data-md2s-anim 的元素`,
      "给需要动画的元素加 data-md2s-anim，或删掉这条动画规则"
    ))
  }
}

/** R3 / R5 / R10 / R11：DOM 属性与元素扫描。 */
const checkDom = (doc, issues) => {
  // R3：脚本与可执行元素
  doc.querySelectorAll("script, iframe, object, embed").forEach(el => {
    issues.push(makeIssue(
      "R3", "E_SCRIPT", "error", whereOf(el, doc),
      `<${el.tagName.toLowerCase()}> 属于行为/嵌入元素，放映稿必须纯声明式`,
      "删掉该元素；放映稿是静态 HTML+CSS，交互由宿主播放器提供"
    ))
  })
  // R5：外链元素
  doc.querySelectorAll('link[rel~="stylesheet"], link[rel~="preload"], script[src]').forEach(el => {
    issues.push(makeIssue(
      "R5", "E_EXTERNAL", "error", whereOf(el, doc),
      "外链样式/脚本/预加载资源",
      "把样式内联进 <style>，资源用 data: 或相对同目录路径"
    ))
  })

  doc.querySelectorAll("*").forEach(el => {
    for (const attr of el.attributes || []) {
      const name = attr.name.toLowerCase()
      const value = attr.value || ""
      // R3：事件属性 / javascript: URL
      if (/^on[a-z]/i.test(name) || /javascript:/i.test(value)) {
        issues.push(makeIssue(
          "R3", "E_SCRIPT", "error", whereOf(el, doc),
          `属性 ${name} 携带行为或 javascript: URL`,
          "删掉该属性；放映稿不含事件处理"
        ))
      }
      // R10：data-* 命名空间
      if (name.startsWith("data-") && !isContractData(name) && !isPrivateData(name)) {
        issues.push(makeIssue(
          "R10", "E_NS_COLLISION", "error", `${whereOf(el, doc)} 的 ${name}`,
          `私有属性 ${name} 未加命名空间前缀，可能与契约/引擎保留字冲突`,
          `改名为 data-x-${name.slice(5)}（或 data-author-…）；契约属性见 §4 可选契约属性表`
        ))
      }
      // R11：图片 / 媒体资源协议
      if ((name === "src" || name === "href" || name === "poster") &&
          /^(?:https?:)?\/\//i.test(value.trim())) {
        issues.push(makeIssue(
          "R11", "E_EXTERNAL", "error", `${whereOf(el, doc)} 的 ${name}`,
          `资源 "${value.slice(0, 60)}" 是外链`,
          "改成 data: URI 或相对文稿所在目录的路径（宿主只放行该目录）"
        ))
      }
    }
  })

  // R4：自带播放器机制的 DOM 残留
  doc.querySelectorAll("#stage").forEach(el => {
    issues.push(makeIssue(
      "R4", "E_PLAYER_RESIDUE", "error", whereOf(el, doc),
      "#stage 是自带播放器的舞台容器（播放器会把页搬进自己的 .md2s-stage）",
      "删掉 #stage；页容器只保留 <div id=\"deck\">"
    ))
  })
  doc.querySelectorAll(".is-active").forEach(el => {
    issues.push(makeIssue(
      "R4", "E_PLAYER_RESIDUE", "error", whereOf(el, doc),
      "is-active 是自带播放器的当前页标记",
      "删掉该类；当前页由播放器的 .md2s-current 决定"
    ))
  })
  doc.querySelectorAll(".slide:not([data-slide])").forEach(el => {
    issues.push(makeIssue(
      "R4", "E_PLAYER_RESIDUE", "error", whereOf(el, doc),
      "以 class=\"slide\" 充当分页（契约只认 section[data-slide]）",
      "改成 <section data-slide>，或把 slide 类换成普通版式类名"
    ))
  })
}

function validateHtmlDeck(doc) {
  const issues = []
  if (!doc || typeof doc.querySelectorAll !== "function") {
    return {
      ok: false, version: null, canvas: { ...DEFAULT_CANVAS },
      errors: [makeIssue("R1", "E_NO_ROOT", "error", "输入", "没有可校验的 Document", "宿主应先用 DOMParser 解析文稿")],
      warns: [],
      issues: [makeIssue("R1", "E_NO_ROOT", "error", "输入", "没有可校验的 Document", "宿主应先用 DOMParser 解析文稿")]
    }
  }

  // R1：唯一 #deck + 版本声明
  const decks = [...doc.querySelectorAll("#deck")]
  let deck = null
  if (decks.length === 0) {
    issues.push(makeIssue(
      "R1", "E_NO_ROOT", "error", "文档",
      "缺少唯一根容器 <div id=\"deck\">",
      "按契约 §3 最小样例，用 <div id=\"deck\" data-wenlan-deck=\"1\"> 包住所有页"
    ))
  } else if (decks.length > 1) {
    issues.push(makeIssue(
      "R1", "E_NO_ROOT", "error", "文档",
      `出现 ${decks.length} 个 #deck（必须唯一）`,
      "合并成一个 <div id=\"deck\">；其余容器改成普通 div 并删掉 id"
    ))
  } else {
    deck = decks[0]
  }

  let version = null
  if (deck) {
    version = deck.getAttribute("data-wenlan-deck")
    if (!version) {
      issues.push(makeIssue(
        "R1", "E_NO_VERSION", "error", whereOf(deck, doc),
        "缺少契约版本声明 data-wenlan-deck=\"1\"",
        `在 <div id="deck"> 上加 data-wenlan-deck="${CONTRACT_VERSION}"（无声明一律拒绝，不按 v1 猜测）`
      ))
    } else if (String(version).trim() !== CONTRACT_VERSION) {
      issues.push(makeIssue(
        "R1", "E_UNSUPPORTED_VERSION", "error", whereOf(deck, doc),
        `契约版本 "${version}" 不受支持（本宿主实现 v${CONTRACT_VERSION}）`,
        `改成 data-wenlan-deck="${CONTRACT_VERSION}"，或用支持该版本的宿主打开`
      ))
    }
  }

  // R2：至少一页，且全部为 #deck 直接子元素
  const sections = [...doc.querySelectorAll(SLIDE_SELECTOR)]
  if (sections.length === 0) {
    issues.push(makeIssue(
      "R2", "E_NO_SLIDES", "error", deck ? whereOf(deck, doc) : "文档",
      "没有找到任何 <section data-slide>（0 页文稿不合法）",
      "把内容切成若干 <section data-slide>，作为 #deck 的直接子元素；契约不提供自动单页包装"
    ))
  } else if (deck) {
    const nested = sections.filter(s => s.parentElement !== deck)
    if (nested.length > 0) {
      issues.push(makeIssue(
        "R2", "E_NESTED_SLIDES", "error", whereOf(nested[0], doc),
        `${nested.length} 个 <section data-slide> 不是 #deck 的直接子元素（嵌套分页不被允许）`,
        "把这些 section 提升为 #deck 的直接子元素；播放器会搬走每页并剥离原父容器"
      ))
    }
  }

  const canvas = parseCanvas(doc, issues)
  checkPageSizes(sections, canvas, issues, doc)
  const styleBlocks = collectStyles(doc)
  checkCss(doc, styleBlocks, issues)
  checkDom(doc, issues)

  // R12：页标题（大纲/备注用）
  if (deck) {
    const noTitle = sections.filter(s => !s.hasAttribute("data-md2s-title"))
    if (noTitle.length > 0) {
      issues.push(makeIssue(
        "R12", "W_NO_TITLE", "warn", `${noTitle.length} 页`,
        `${noTitle.length}/${sections.length} 页缺少 data-md2s-title（大纲/演讲者备注会空白）`,
        "给每页加 data-md2s-title=\"页标题\"，可选 data-md2s-note=\"备注\""
      ))
    }
  }

  const errors = aggregate(issues.filter(i => i.severity === "error"))
  const warns = aggregate(issues.filter(i => i.severity === "warn"))
  return {
    ok: errors.length === 0,
    version: version ? String(version).trim() : null,
    canvas,
    issues: [...errors, ...warns],
    errors,
    warns,
    /** 聚合前的原始条数（宿主日志用，诊断展示用聚合后的 errors/warns）。 */
    rawCount: issues.length
  }
}

/**
 * 同类违规聚合：真实文稿里同一个私有属性可能在 60 个元素上重复出现，
 * 逐条列出会把错误框撑成几百行、把关键问题淹没。按 rule+code+message 归组，
 * 保留首个 where，附 count 与至多 3 个额外位置示例。
 */
const aggregate = list => {
  const groups = new Map()
  for (const i of list) {
    const key = `${i.rule}|${i.code}|${i.message}`
    const g = groups.get(key)
    if (g) {
      g.count += 1
      if (g.more.length < 3) g.more.push(i.where)
    } else {
      groups.set(key, { issue: i, count: 1, more: [] })
    }
  }
  return [...groups.values()].map(({ issue, count, more }) =>
    count === 1 && more.length === 0
      ? issue
      : { ...issue, count, where: `${issue.where}${more.length ? ` 等 ${count} 处` : ""}`, more }
  )
}

/** 把 issues 渲染成错误框里的多行文本（宿主 md2s:error 直接展示）。 */
const formatIssues = (result) => {
  const lines = []
  if (result.errors.length) {
    lines.push(`文稿不符合 HTML 放映稿契约 v${CONTRACT_VERSION}（${result.errors.length} 项必须修正）`, "")
    result.errors.forEach((i, n) => {
      lines.push(`${n + 1}. [${i.rule} / ${i.code}]${i.count > 1 ? ` ×${i.count}` : ""} ${i.where}`)
      lines.push(`   ${i.message}`)
      lines.push(`   → ${i.fix}`)
    })
  }
  if (result.warns.length) {
    lines.push("", `另有 ${result.warns.length} 条建议（不阻止放映）：`)
    result.warns.forEach(i => lines.push(`   · [${i.rule}] ${i.message}`))
  }
  if (result.errors.length) {
    lines.push("", "契约：md2slides/docs/html-deck-contract.md §3 最小合规样例")
  }
  return lines.join("\n")
}

module.exports = {
  validateHtmlDeck,
  formatIssues,
  cssRules,
  CONTRACT_VERSION,
  DEFAULT_CANVAS,
  SLIDE_SELECTOR,
  ANIM_PLAY_CLASS,
}
