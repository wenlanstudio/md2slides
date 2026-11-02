"use strict"

/**
 * check.js — 浏览器端回归（`npm run e2e`）。
 *
 * 验的是 `tools/smoke.js` 验不了的那一半：物理分页。它靠真实布局量高度，jsdom 没有布局
 * 引擎，量出来全是 0 —— 所以这一步只能在真浏览器里跑。
 *
 * 断言分四组，正好对应分页最容易出事的四个地方：
 *
 *   1. **几何**——收敛后不溢出、无空页、每页最多一个中心内容、无扉页重复页；
 *      （"只有标题的扉页"不是缺陷——书本式结构的部标题页就该长这样；缺陷是
 *        扉页之后下一页还把同一标题原样重复一遍，那一页零信息量。）
 *   1.5 **封面**——题名只在 front-matter：声明了 title 就有自动封面（题名/作者/日期
 *      对得上）、封面两样家具豁免；
 *   2. **守恒**——分页只搬不丢，代码全文 / 表体行 / 列表项数量必须与分页前一致；
 *   3. **时序**——代码块被按行切开后 span 全没了，收敛后必须补染回来。
 *
 * 判据全部来自浏览器里量到的数字；`runner.js` 只负责把它们带回来。
 *
 * Usage:  node e2e/check.js [path/to/deck.md]     默认 examples/demo.md
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const { runDeck } = require("./runner")

const FIXTURES = path.join(__dirname, "fixtures")

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok    ${name}`)
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error.message}`)
    process.exitCode = 1
  }
}

/** 代码切分只在行边界上动刀，空白差异无意义，比之前先归一化。 */
const norm = s => String(s).replace(/\s+/g, " ").trim()

const audit = async input => {
  const r = await runDeck({ file: input })
  const { deck, report, before, after, rounds, roundsAfterRepaint, repainted, ir, diagram, diagramPass } = r
  const s = report.summary
  const added = rounds.reduce((a, b) => a + b, 0)

  console.log(`${path.basename(input)}`)
  console.log(
    `  逻辑分页 ${deck.slideCount} 页 → 物理分页 ${s.total} 页（新增 ${added}）· 染色 ${repainted} 块`,
  )
  // 切分规模，供肉眼确认这一轮到底打到了哪些分支。
  console.log(
    `  块数：代码 ${before.codeBlocks}→${after.codeBlocks}` +
      ` · 表格 ${before.tables}→${after.tables}` +
      ` · 列表 ${before.lists}→${after.lists}` +
      ` · 列表项 ${before.listItems}→${after.listItems}`,
  )
  console.log(
    `  IR v${ir.version} · ${ir.stats.slides} 页 · ${ir.stats.blocks} 块` +
      `（${Object.entries(ir.stats.byType).map(([k, v]) => `${k}×${v}`).join(" ")}）`,
  )
  console.log("")

  // ---- 1. 几何 ------------------------------------------------------------

  console.log("几何")

  await check("bundle 装上了：浏览器里能看到分页后的页", () => {
    assert.ok(s.total > 0, "一页都没有")
  })

  await check("物理分页收敛（最后一轮不再新增页）", () => {
    assert.strictEqual(rounds[rounds.length - 1], 0, `各轮新增页数：${rounds.join(", ")}`)
    assert.strictEqual(
      roundsAfterRepaint[roundsAfterRepaint.length - 1] ?? 0,
      0,
      `染色后又冒出新页：${roundsAfterRepaint.join(", ")}（染色不该改变高度）`,
    )
  })

  await check("收敛后无溢出页", () => {
    const bad = report.pages.filter(p => p.overflow > 0)
    const detail = bad.map(p => `第${p.index || "?"}页溢出 ${p.overflow}px（内容 ${p.bottom} / 可用 ${p.avail}）`)
    assert.strictEqual(s.overflowing, 0, `${s.overflowing} 页溢出，最大 ${s.maxOverflow}px\n        ${detail.join("\n        ")}`)
  })

  await check("物理分页没把页数越切越少", () => {
    assert.ok(s.total >= deck.slideCount, `逻辑 ${deck.slideCount} 页，物理只剩 ${s.total} 页`)
  })

  await check("没有扉页重复页（只有标题、下页还把同一标题再摆一遍）", () => {
    const detail = report.pages
      .filter(p => p.dividerRepeat)
      .map(p => `第${p.index || "?"}页只有标题「${p.heading}」，第${(p.index || 0) + 1}页又重复了它`)
    assert.deepStrictEqual(s.dividerRepeats, [], detail.join("\n        "))
  })

  await check("没有空页", () => {
    assert.deepStrictEqual(s.empties, [], `这些页是空的：${s.empties.join(", ")}`)
  })

  await check("每页最多一个中心内容", () => {
    const detail = report.pages
      .filter(p => p.cores.length > 1)
      .map(p => `第${p.index || "?"}页有 ${p.cores.length} 个：${p.cores.join("+")}`)
    assert.deepStrictEqual(s.multiCore, [], detail.join("\n        "))
  })

  await check("「（续）」不随拆分轮数叠加", () => {
    const bad = report.pages.filter(p => p.contMarks > 1)
    assert.strictEqual(bad.length, 0, `这些页有 ${bad.map(p => p.index).join(", ")} 个续标记`)
  })

  // ---- 1.5 封面（front-matter 自动生成）-------------------------------------

  // 规范（USAGE.md §3.0）：题名只写在 front-matter，封面由引擎生成、排在全文第一页，
  // 手写封面 div 不被接受。这里验"声明了 title 的文档"那条主路。
  console.log("封面（front-matter 自动生成）")

  const meta = r.deck.meta ?? null
  if (meta?.title) {
    await check("第一页是自动封面，题名来自 front-matter", () => {
      const first = report.pages[0]
      assert.ok(first.cover, "第一页没有封面（缺 .cover）——声明了 title 却没生成封面？")
      assert.ok(
        first.cover.includes(meta.title),
        `封面文字「${first.cover}」不含 front-matter 的 title「${meta.title}」`,
      )
    })
    if (meta.author) {
      await check("封面带作者", () => {
        assert.ok(report.pages[0].cover.includes(meta.author), `封面上没有作者「${meta.author}」`)
      })
    }
    if (meta.subtitle) {
      await check("封面带副标题", () => {
        assert.ok(
          report.pages[0].cover.includes(meta.subtitle),
          `封面上没有副标题「${meta.subtitle}」`,
        )
      })
    }
    if (meta.date) {
      await check("封面带日期", () => {
        assert.ok(report.pages[0].cover.includes(meta.date), `封面上没有日期「${meta.date}」`)
      })
    }
  }

  // ---- 1.6 家具（页眉页脚）-------------------------------------------------

  console.log("家具（页眉页脚注入）")

  await check("封面两样豁免（第一页没有页眉页脚）", () => {
    const first = report.pages[0]
    assert.ok(first, "没有页？")
    // 没声明 title 的文档没有封面，第一页就是正文第一页，家具照常给——只审有封面的。
    if (!first.cover) return
    assert.ok(!first.furniture.header, `封面多了页眉：${first.furniture.header}`)
    assert.ok(!first.furniture.footer, `封面多了页脚：${first.furniture.footer}`)
  })

  await check("扉页无页眉（与 dividerRepeat 同款判据：连续两页同一路径是零信息量）", () => {
    // 只在文档真的启用了页眉时才判——header: false 的文档没有页眉可漏。
    const anyHeader = report.pages.some((p, i) => i > 0 && !p.divider && p.furniture.header)
    if (!anyHeader) return
    const bad = report.pages
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i > 0 && p.divider && p.furniture.header)
      .map(({ p, i }) => `第 ${i + 1} 页是扉页却有页眉「${p.furniture.header}」`)
    assert.deepStrictEqual(bad, [], bad.join("\n        "))
  })

  await check("面包屑在页脚左下：内容页有、扉页没有（右下仍是页码）", () => {
    // 只审默认页脚的文档：自定义 footer 模板是作者自己的布局，不强求路径槽。
    const anyPath = report.pages.some((p, i) => i > 0 && p.furniture.path)
    if (!anyPath) return
    const bad = report.pages
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i > 0 && p.divider && p.furniture.path)
      .map(({ p, i }) => `第 ${i + 1} 页是扉页，页脚却挂着路径「${p.furniture.path}」`)
    assert.deepStrictEqual(bad, [], bad.join("\n        "))
    const noPage = report.pages
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i > 0 && p.furniture.path && !p.furniture.page)
      .map(({ i }) => `第 ${i + 1} 页有路径没页码`)
    assert.deepStrictEqual(noPage, [], noPage.join("\n        "))
  })

  await check("页码连续且总数正确（启用页脚时：一页不漏、一页不错）", () => {
    const withPage = report.pages
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i > 0 && p.furniture.page)
    const withoutPage = report.pages
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i > 0 && !p.furniture.page)
    if (!withPage.length) return // 文档关掉了页脚（footer: false）
    // 页脚是全局开关：不可能有的页有、有的页没有——出现半漏就是注入漏了页。
    assert.deepStrictEqual(withoutPage.map(({ i }) => i + 1), [], "这些页没有页码")
    const total = s.total
    const bad = []
    for (const { p, i } of withPage) {
      const m = /^(\d+)(?:\s*\/\s*(\d+))?$/.exec(p.furniture.page)
      if (!m) {
        bad.push(`第 ${i + 1} 页页码格式不对：「${p.furniture.page}」`)
        continue
      }
      if (Number(m[1]) !== i + 1) bad.push(`第 ${i + 1} 页页码是 ${m[1]}`)
      if (total > 1 && Number(m[2]) !== total) {
        bad.push(`第 ${i + 1} 页总页数是 ${m[2]}，应为 ${total}`)
      }
    }
    assert.deepStrictEqual(bad, [], bad.join("\n        "))
  })

  // ---- 2. 守恒 ------------------------------------------------------------

  console.log("守恒（分页只搬不丢）")

  await check("代码块：按行切分后全文守恒", () => {
    assert.strictEqual(norm(after.codeText), norm(before.codeText), "代码文本前后对不上")
  })

  await check("表格：表体行数守恒（表头克隆不算）", () => {
    assert.strictEqual(after.tableRows, before.tableRows, `${before.tableRows} → ${after.tableRows}`)
  })

  await check("列表：文本守恒（按项切 / 切进项内部都不丢字）", () => {
    assert.strictEqual(norm(after.listText), norm(before.listText), "列表文本前后对不上")
  })

  await check("列表：项数不减少（切进项内部时会 +1）", () => {
    assert.ok(
      after.listItems >= before.listItems,
      `${before.listItems} → ${after.listItems}，少了 ${before.listItems - after.listItems} 项`,
    )
  })

  await check("公式：没有被切开也没丢", () => {
    assert.strictEqual(after.katex, before.katex, `${before.katex} → ${after.katex}`)
  })

  await check("图片：数量守恒", () => {
    assert.strictEqual(after.images, before.images, `${before.images} → ${after.images}`)
  })

  await check("没有块掉到页外（deck 的直接子元素全是 section）", () => {
    assert.strictEqual(after.strays, 0, `有 ${after.strays} 个直接子元素不是 section`)
  })

  await check("块只会被切多、不会被切少", () => {
    const dropped = [
      ["代码块", before.codeBlocks, after.codeBlocks],
      ["表格", before.tables, after.tables],
      ["列表", before.lists, after.lists],
    ].filter(([, b, a]) => a < b)
    assert.deepStrictEqual(
      dropped,
      [],
      dropped.map(([name, b, a]) => `${name} ${b} → ${a}`).join("；"),
    )
  })

  await check("续页表格都带表头（不能是一堆裸行）", () => {
    assert.strictEqual(
      after.tablesWithHead,
      after.tables,
      `${after.tables} 张表里有 ${after.tables - after.tablesWithHead} 张没有 thead`,
    )
  })

  await check("续页表头内容与首页一致（逐字，不是只有 thead 壳）", () => {
    const problems = []
    let lastHead = null
    for (const page of report.pages) {
      for (const table of page.tables ?? []) {
        if (table.cont) {
          if (!table.head) problems.push(`第 ${page.index + 1} 页续页表没有表头内容`)
          else if (table.head !== lastHead) {
            problems.push(`第 ${page.index + 1} 页续页表头与上一张不一致：「${table.head}」≠「${lastHead}」`)
          }
        }
        if (table.head) lastHead = table.head
      }
    }
    assert.deepStrictEqual(problems, [], problems.join("\n        "))
  })

  // ---- 3. 时序 ------------------------------------------------------------

  console.log("时序")

  await check("分页后重新染色：代码块仍有颜色", () => {
    if (before.codeText.trim() === "") {
      console.log("        （文档里没有代码块，跳过）")
      return
    }
    assert.ok(repainted > 0, "一块都没染上")
    assert.ok(s.highlighted > 0, "收敛后 deck 里找不到 .hljs span —— 忘了补染？")
  })

  // ---- 3b. 图表（宿主渲染） ---------------------------------------------

  // 两遍加起来：Node 侧渲染的（graphviz）+ 页面里渲染的（mermaid）。
  const renderedTotal = (diagram?.rendered ?? 0) + (diagramPass?.rendered ?? 0)

  // 文档里真有图才验：demo / overflow 没有图表围栏，这一段整段跳过。
  if (renderedTotal) {
    console.log("图表（宿主渲染）")

    await check("图表块全部渲染成了图节点", () => {
      assert.strictEqual(
        after.diagrams,
        renderedTotal,
        `两遍共渲染 ${renderedTotal} 张（Node ${diagram?.rendered ?? 0} + 页面 ${diagramPass?.rendered ?? 0}），` +
          `deck 里只有 ${after.diagrams} 个 [data-diagram] 节点`,
      )
    })

    await check("没有残留未渲染的图表代码块（不接受缺图降级）", () => {
      assert.strictEqual(
        after.unrenderedCharts,
        0,
        `还有 ${after.unrenderedCharts} 个图表围栏没被渲染`,
      )
    })

    await check("图量得到正高度（几何可信，不是 0 尺寸块）", () => {
      const imgs = (r.blocks ?? []).flatMap(p => p.kids.filter(k => k.tag === "IMG"))
      assert.ok(imgs.length > 0, "分页后一页里都找不到图节点")
      const flat = imgs.filter(k => !(k.height > 0))
      assert.deepStrictEqual(flat, [], `这些图量出来高度不是正数：${JSON.stringify(flat)}`)
    })
  }

  // ---- 4. IR（管线末端） --------------------------------------------------

  // `checkIr` 把所有问题塞进一个字符串数组，这里按类别拆开，好让断言各自精准报。
  const kinds = {
    崩溃: ["校验过程异常"],
    文本: ["文本不一致"],
    几何: ["越界", "尺寸非正"],
    图片: ["图片未落盘"],
  }
  const ofKind = keys => ir.issues.filter(i => keys.some(k => i.includes(k)))
  const irCrash = ofKind(kinds.崩溃)
  const irText = ofKind(kinds.文本)
  const irGeo = ofKind(kinds.几何)
  const irMedia = ofKind(kinds.图片)
  const irOther = ir.issues.filter(i =>
    !Object.values(kinds).flat().some(k => i.includes(k)),
  )

  console.log("IR 闸门（export/pptx）")

  await check("IR 抽取没有抛异常", () => {
    assert.deepStrictEqual(irCrash, [], irCrash.join("\n        "))
  })

  await check("IR 页数与物理分页的页数一致", () => {
    assert.strictEqual(
      ir.stats.slides,
      s.total,
      `物理 ${s.total} 页，IR 只抽出 ${ir.stats.slides} 页`,
    )
  })

  await check("逐页文本与 DOM 完全等价（去空白比较）", () => {
    assert.deepStrictEqual(irText, [], irText.join("\n        "))
  })

  await check("每个块都落在画布内且尺寸为正", () => {
    assert.deepStrictEqual(irGeo, [], irGeo.join("\n        "))
  })

  await check("IR 抽得出东西（不是空 IR）", () => {
    assert.ok(ir.stats.blocks > 0, "一个块都没抽出来")
    const types = Object.keys(ir.stats.byType)
    assert.ok(types.length > 0, "抽出来的块没有任何类型")
  })

  await check("没有 IR 认不出的块（unknown）", () => {
    const unknowns = ir.stats.byType.unknown ?? 0
    assert.strictEqual(unknowns, 0, `有 ${unknowns} 个块被判为 unknown —— 抽取漏认了元素`)
  })

  await check("内容块都带源码行号（srcRange），且页内不回跳", () => {
    const problems = []
    for (const slide of ir.ir?.slides ?? []) {
      let prev = 0
      for (const block of slide.blocks ?? []) {
        // 封面/页眉页脚/续页标记是引擎生成的，没有源码行号，豁免。
        // 目录页不在豁免之列：它的每个条目都标了所指章节的源码行号（toc.js 写入），
        // 语义上"这个目录项指向源码第 N 行"，因此照常受行号校验。
        if (block.role === "header" || block.role === "footer" || block.container === "cover") continue
        const markerText = (block.runs ?? []).map(r => r.text ?? "").join("").trim()
        if (markerText === "（续）") continue
        const range = block.srcRange
        if (!range || range[0] < 1 || range[1] < range[0]) {
          problems.push(`第 ${slide.index + 1} 页 ${block.type} 块没有合法 srcRange（${JSON.stringify(range)}）`)
          continue
        }
        if (range[0] < prev) {
          problems.push(`第 ${slide.index + 1} 页 ${block.type} 块 srcRange 回跳（${range[0]} < ${prev}）`)
        }
        prev = range[0]
      }
    }
    assert.deepStrictEqual(problems, [], problems.join("\n        "))
  })

  await check("IR 没有别的毛病（图片落盘 / 其他）", () => {
    assert.deepStrictEqual([...irMedia, ...irOther], [], [...irMedia, ...irOther].join("\n        "))
  })

  // ---- 5. PPTX 成品 -------------------------------------------------------

  // IR 只是内容契约，成品是 PPTX。sidecar 自带 verify()（拿 IR 文本逐页比对成品，
  // 并把 custom/unknown 记成待办），这里驱动它，把 issues / pending 带回来。
  console.log("PPTX 成品（Python sidecar）")

  if (r.pptx.skipped) {
    console.log(`  （跳过：${r.pptx.reason}）`)
  } else {
    await check("sidecar 出片成功", () => {
      assert.ok(r.pptx.ok, `sidecar 没跑成：\n        ${r.pptx.stderr}`)
    })

    await check("PPTX 逐页文本与 IR 一致", () => {
      assert.deepStrictEqual(r.pptx.issues, [], r.pptx.issues.join("\n        "))
    })

    await check("没有内容被落下（无 custom / unknown 块）", () => {
      assert.deepStrictEqual(r.pptx.pending, [], r.pptx.pending.join("\n        "))
    })

    await check("sidecar 没有别的提示（图片找不到之类）", () => {
      // Office 的 MML2OMML.XSL 只在 Windows/Office 环境存在；Linux 走内置转换是设计内行为。
      const notes = r.pptx.notes.filter(n => !/MML2OMML\.XSL/.test(n))
      assert.deepStrictEqual(notes, [], notes.join("\n        "))
    })

    await check("PPTX 文件真的落盘了", () => {
      assert.ok(fs.existsSync(r.pptxFile), `没有生成 ${r.pptxFile}`)
      assert.ok(fs.statSync(r.pptxFile).size > 0, "PPTX 是空的")
    })

    // IR 的几何对了不算完：sidecar 还要把英寸换算成 EMU、照绝对坐标摆下去。
    await check("成品里每个形状都落在画布内", () => {
      assert.deepStrictEqual(r.shapes?.issues ?? [], [], (r.shapes?.issues ?? []).join("\n        "))
    })

    // 只比英寸：IR 的 canvas 还带一份 pxWidth/pxHeight（成品里没有），全键比必挂。
    await check("成品形状之间不重叠（叠字类破版的亡羊补牢）", () => {
    const overlaps = (r.shapes?.issues ?? []).filter(i => i.includes("重叠"))
    assert.deepStrictEqual(overlaps, [], overlaps.join("\n        "))
  })

  await check("成品画布就是 IR 声明的那张", () => {
      const got = r.shapes?.canvas
      assert.ok(got, "读不回成品画布")
      assert.strictEqual(got.widthIn, ir.canvas.widthIn, `宽度 ${ir.canvas.widthIn} → ${got.widthIn}`)
      assert.strictEqual(got.heightIn, ir.canvas.heightIn, `高度 ${ir.canvas.heightIn} → ${got.heightIn}`)
    })

    const shapeCount = (r.shapes?.slides ?? []).reduce((n, s) => n + s.shapes, 0)
    console.log(
      `  → ${path.basename(r.pptxFile)}（${(fs.statSync(r.pptxFile).size / 1024).toFixed(0)} KB` +
        ` · ${r.shapes?.slides?.length ?? 0} 页 · ${shapeCount} 个形状）`,
    )
  }

  // ---- 6. 页码 ------------------------------------------------------------

  // 只有文档要了 paginate 才打页码；没要的话 index 全是 0，这条无从验起。
  if (/data-pagination/.test(deck.html)) {
    console.log("页码")
    await check("页码连续且与页序一致", () => {
      assert.deepStrictEqual(
        report.pages.map(p => p.index),
        report.pages.map((_, i) => i + 1),
        `实际页码：${report.pages.map(p => p.index).join(", ")}`,
      )
    })
  }

  // ---- 6b. 播放器（kit/player）--------------------------------------------

  console.log("播放器（kit/player）")
  await check("slide 模式：接管 / 翻页 / 键盘 / 缩放 / 还原（页内探针）", () => {
    const issues = r.player.issues
    assert.deepStrictEqual(issues, [], issues.join("\n        "))
    assert.strictEqual(r.player.total, s.total, "播放器页数与分页结果不一致")
  })

  await check("element 模式：步进表 / visibility 揭示 / ←→ 翻页（页内探针）", () => {
    const issues = r.playerElement.issues
    assert.deepStrictEqual(issues, [], issues.join("\n        "))
    assert.strictEqual(r.playerElement.total, s.total, "播放器页数与分页结果不一致")
  })

  // ---- 6b2. 图片查看器（kit/lightbox）------------------------------------
  if (r.lightbox && !r.lightbox.skipped) {
    console.log("图片查看器（kit/lightbox）")
    await check("点图打开 / 缩放钳制 / 拖动位移 / 双指放大 / Esc 关闭（页内探针）", () => {
      assert.deepStrictEqual(r.lightbox.issues, [], (r.lightbox.issues || []).join("\n        "))
    })
  }

  // ---- 6c. 截图基线（像素回归）--------------------------------------------

  console.log("截图基线")
  if (process.env.MD2SLIDES_SKIP_SHOTS === "1") {
    console.log("  skip  MD2SLIDES_SKIP_SHOTS=1（CI 字体与基线机器不同，像素基线只在本机跑）")
  } else if (r.shot.compared) {
    await check("截图与基线一致（像素回归，阈值 1%）", () => {
      const issues = r.shot.issues
      assert.deepStrictEqual(issues, [], issues.join("\n        "))
    })
  } else {
    console.log("  skip  无基线（npm run shot:update 建立后开始比对）")
  }

  // ---- 6d. 夹具专用断言 ----------------------------------------------------
  // oversize：超高内容兜底（2026-10-25 拍板——图片裸页缩放铺满、段落缩字顺排，
  // 不允许溢出；警告必须真实发生，否则上面的"无溢出"可能只是巧合）。
  if (deck.name === "oversize") {
    console.log("超高内容兜底（oversize 专用）")
    await check("超高图片：裸页缩放适配（警告已发）", () => {
      assert.ok(
        r.console.some(l => l.includes("超高图片已在整页缩放适配")),
        "图片缩放警告没出现；实际 [md2slides] 日志：" +
          r.console.filter(l => l.includes("md2slides")).join(" | "),
      )
    })
    await check("超高段落：缩字号顺排（警告已发）", () => {
      assert.ok(
        r.console.some(l => l.includes("字号已缩至")),
        "段落缩字警告没出现",
      )
    })
  }

  // ---- 7. 浏览器侧干净 ----------------------------------------------------

  console.log("控制台")
  await check("页面没有抛出未捕获异常", () => {
    const errors = r.console.filter(line => line.startsWith("pageerror") || line.startsWith("error"))
    assert.deepStrictEqual(errors, [], errors.join("\n        "))
  })

  console.log("")
  // 翻车时留一份产物：光看断言给出的像素数，很难判断是切错了还是主题写错了。
  if (process.exitCode) console.log(`  ⤷ 分页后的产物：${r.paginatedFile}`)
}

/**
 * 默认跑 `examples/demo.md` 加上 `e2e/fixtures/` 里所有 md。
 * 传路径参数就只跑指定的（调试时省得每次都等全部跑完）。
 */
const defaultInputs = () => [
  path.resolve(__dirname, "../examples/demo.md"),
  ...(fs.existsSync(FIXTURES)
    ? fs.readdirSync(FIXTURES).filter(f => f.endsWith(".md")).sort()
      .map(f => path.join(FIXTURES, f))
    : []),
]

/**
 * `--dump <file>`：不判对错，只把分页后每一页装了哪些块、各占多高打出来。
 * 物理分页的判据是"量到的像素 + 块的类型"，出问题时光有断言文本是查不动的。
 */
const dump = async input => {
  const r = await runDeck({ file: input })
  console.log(`${path.basename(input)}：逻辑 ${r.deck.slideCount} 页 → 物理 ${r.report.summary.total} 页\n`)
  for (const page of r.blocks) {
    console.log(`#${page.page}  可用 ${page.avail}px`)
    for (const k of page.kids) {
      console.log(
        `    ${k.tag}${k.cls ? "." + k.cls : ""}` +
          `${k.core ? `  [${k.core}]` : ""}  h=${k.height}`,
      )
    }
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args[0] === "--dump") {
    for (const input of args.slice(1).length ? args.slice(1) : defaultInputs()) await dump(input)
    return
  }
  console.log("md2slides e2e — 物理分页回归（headless Chromium）\n")
  for (const input of args.length ? args : defaultInputs()) await audit(input)
  console.log(`\n${passed} passed${process.exitCode ? "（有失败）" : ""}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
