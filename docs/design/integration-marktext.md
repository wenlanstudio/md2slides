# 纸面消费者：marktext 幻灯片视图（历史档案 · 已由 fork 接管）

> **本文已归档（2026-11-01）**：marktext 集成已落地并经数轮演进，现行设计唯一
> 依据是 **marktext fork 的 `docs/design/view-model.md`**（文示二支 × 四叶选择；
> 本文的"slides 视图"已演化为示支两叶 = 页览 / 放映）。本文保留原貌，只作 API
> 设计方法论（纸面消费者验收 API 面）与调用序列的历史记录——文中"缺口表"、
> 排期与裁决均已过时，勿按本文开工。
>
> 用途（历史）：**P-1 API 面的验收用例**。把一个真实宿主（marktext 的 slides 视图）从
> 建面板到导出的完整调用序列写在纸上——每一步都必须能对到 `require("md2slides")`
> 的真实出口；哪一步对不上，就是 API 设计缺陷，改 API 而不是改宿主。
>
> 注：本文写于 npm 包名定为 `@wenlanstudio/md2slides` 之前；文中 `require("md2slides")` 现对应
> `require("@wenlanstudio/md2slides")`。

---

## 0. 形态裁决（已定，不再讨论）

| 裁决 | 内容 |
|---|---|
| 借进程不借 DOM | slides 视图 = Electron renderer 里的一个 iframe，跑 md2slides 自己的渲染（compose + splitOverflow）。**不在 muya 的活 DOM 上做任何测量或切分** |
| muya = Tier 0 | 编辑侧预览就是 muya 自己的渲染（含 `columnsLayout` 分栏透镜）；md2slides 不为 marktext 提供 Tier 0 |
| 图表复用宿主产物 | `renderDiagram` 钩子读 muya 已渲染的 mermaid / echarts 产出转位图（B 形态，模式同 `host/typora/diagram.js`），不在 iframe 里重渲 |
| 方言不分叉 | 分栏 `<!-- begin/split/end -->` 两引擎同族同规则（`core/split/cols.js` ↔ muya `utils/columns/syntax.ts`）；后续用共享测试语料锁住 |
| 逻辑页归 muya，物理页归 iframe | marktext 若做自家 slides/slide 编辑视图，只做 **Tier 0 逻辑页**（标题 / `---` 切页，可编辑，无物理分页）；物理分页 / 放映 / 导出一律归 md2slides iframe。两视图页码可不同——editor/deck 分歧与 Typora 同判（已接受）。**严禁在 muya 活 DOM 上做任何测量或切分**（2026-10-30 补，对应 fork TODO1「视图切换避免重绘」设想的边界裁决） |

---

## 1. 调用序列（每步标注 现成/缺口）

```js
// marktext renderer process：slides 视图面板（Vue 组件挂载时）
const md2slides = require("md2slides")

// ── 1. 建 iframe【宿主活】────────────────────────────────────────────
const iframe = panel.appendChild(document.createElement("iframe"))
const doc = iframe.contentDocument

// ── 2. 解析 + 逻辑分页 + 主题【现成：compose】────────────────────────
const deck = md2slides.compose(mdText, {
  document: doc,
  readFile: marktextThemeReader,        // IPC 读主题 / 预置主题注册表【宿主活】
})

// ── 3. 注入样式【现成：css + CONT_CSS 常量】──────────────────────────
addStyle(doc, deck.css + md2slides.CONT_CSS)   // CONT_CSS 必须宿主自拼（API.md §2.3）
doc.body.innerHTML = `<div class="md2slides-deck">${deck.html}</div>`

// ── 4. 图表预通行【钩子现成：renderDiagrams；桥是缺口】──────────────
await md2slides.renderDiagrams(doc, { renderDiagram: muyaDiagramBridge })
md2slides.assertDiagramsRendered(doc)
// muyaDiagramBridge(block)：从 muya 编辑器里找同名图表块 → 读它已渲染的
// svg/canvas → 位图。模式照抄 host/typora/diagram.js。【marktext 侧缺口】

// ── 5. 物理分页 + 重染【现成：splitOverflow / highlightCode】─────────
for (let i = 0; i < 6; i++) {
  if (!md2slides.splitOverflow(doc, {
    slideWidth: deck.slideWidth, slideHeight: deck.slideHeight,
    meta: deck.meta, contMarker: "（续）",
  })) break
}
md2slides.highlightCode(doc)

// ── 6. 放映【现成：createDeckPlayer（缩放/键盘/触屏/步进/lightbox）】──
const player = md2slides.createDeckPlayer(rootEl, {
  onChange: ({ index, total }) => setPageIndicator(index, total),  // UI 归宿主
})
// 触屏轻点翻页（点右半前进/左半后退）、逐元素步进、图片查看器全内置。

// ── 7. 点击页 → 跳源码行【现成：data-src-start/end 已落全块】────────
// 点击命中的块带 data-src-start/end，host 调 muya 的 scrollToLine / cursor 定位。

// ── 8. 编辑联动【现成但全量；增量 = IR_v3 P1】────────────────────────
watch(mdTextChanged, debounce(() => rebuild(), 300))   // rebuild = 2~5 重跑
// 全量重排对中等文档可接受；spike 数据决定 P1 planner 是否必须 section 级脏标记。

// ── 9. 导出可编辑 PPTX（可选功能）【现成：extractIr + checkIr + sidecar】
const ir = await md2slides.extractIr(doc, {
  slideWidth: deck.slideWidth, slideHeight: deck.slideHeight,
  theme: deck.theme, meta: deck.meta,
  media: fileMediaSink,                  // IPC 落盘 media/【宿主活】
  rasterize: htmlToImageRasterize,       // 公式 / 活组件栅格【宿主活】
})
const { issues } = md2slides.checkIr(doc, ir)
if (issues.length) return report(issues)         // 内容闸门：非空即拒
spawnPythonSidecar(ir)                           // export/pptx/sidecar/，进程外
```

---

## 2. 由本文推出的 API 面验收清单

- [x] 序列里引用的每个函数 / 常量都从 `require("md2slides")` 拿得到
- [x] `compose` 返回的 `slideWidth/slideHeight/meta` 直接可喂 `splitOverflow` / `extractIr`，
      无需宿主二次加工
- [x] `CONT_CSS` / `CONT_CLASS` 公开（宿主必须自拼样式；播放器跳过标记）
- [x] `DiagramError` 可 `instanceof`（宿主区分「图渲染失败」与「管线 bug」）
- [x] `sectionsOf` / `SLIDE_SELECTOR` 公开（播放器不硬编码选择器）
- [x] `checkIr` 公开（导出闸门不经过 sidecar 也能先拒）

## 3. 已识别缺口与归属（2026-10-30 重审）

| 缺口 | 归属 | 现状 |
|---|---|---|
| ~~播放器（缩放 / 键盘 / 页码）~~ | `kit/` | ✅ **关闭**：`createDeckPlayer` + swipe + lightbox + 表格步进 + 触屏轻点，真机回归齐 |
| ~~源码行映射 `data-src-*`~~ | 原 IR_v3 P1 | ✅ **关闭**：parse 写入、overflow 维护续页、toc 复用、IR srcRange 校验 |
| 增量分排 | IR_v3 P1 planner | ❌ 未做，**非阻塞**：全量 rebuild + 300ms 防抖起步；M1 spike 数据决定深度（§4 M3） |
| muya 图表桥（已渲染产物 → 位图） | marktext 侧宿主（模式同 `host/typora/diagram.js` 配对 + harvest） | ❌ M1 主体工程 |
| 共享方言测试语料 | 本仓库 `e2e/fixtures/dialect/`（cols / front-matter / slidebreak），muya columns 测试同批消费 | ❌ M0 |
| 主题读取（IPC / 注册表） | marktext 侧（`compose.readFile` 钩子，API.md 已公开） | ❌ M1 |
| `exportPptx` 宿主 API | 宿主层（Typora 按钮 / marktext 菜单共用） | ❌ M0（即 TODO §4 P3-d，ROADMAP 首条） |

## 4. 集成裁决与排期（2026-10-30，方案已认可）

**裁决**：core 不重构；host/ 只增不改（新增 marktext 桥接件，Typora 壳零改动）；
分发走 pnpm workspace `file:` 依赖或 vendor 构建产物（比 Typora 的自包含
bundle + window.html patch 干净——自家 fork 可进构建链，零注入 hack）。

**宿主现状**：fork 已在本地 `md-ecosystem/marktext`（0.22.0-dev，Electron 42 +
Vue 3 + TS strict + pnpm workspace）；muya 分栏已是块树一等公民（`columns` /
`column` 块节点，Phase 1–4 完成，栏内可编辑 / 撤销 / 保存）；`MAIN_VIEW_META`
已声明 slides/slide 与 slides/present（`implemented: false`，翻牌即接）。

| 阶段 | 内容 | 仓 |
|---|---|---|
| **M0 踏脚石** ✅（2026-10-30 完成） | ① `exportPptx` 宿主 API：~~新写~~ 实测发现 Typora 按钮（a9a740e）后端已在 `host/typora/export.js`——真实工作 = 抽成宿主无关模块 `host/pptx/`（工厂 `createExporter({ libDir })` 绑宿主资产布局，构造时验明 pptxgenjs/sidecar；双通道 + ExportError 五错误码 + 原子写全在上层），Typora 变薄适配器（shell.js 零改动），marktext M1 绑自己的 lib 目录即得同款导出。② `e2e/fixtures/dialect/`（cols / front-matter / slidebreak 三组 .md + README 契约），smoke「方言语料」段 6 项检查；muya 侧消费 M1 接线 | md2slides |
| **M1 宿主壳（主体）** | slides/present 视图组件（iframe）按 §1 序列接线；muya 图表桥（按文档序配对同名图表块 → 读已渲染 svg/canvas 转位图；mermaid/echarts `{defer:true}` 走 iframe 页面侧，复用 `host/browser` 同一份）；`compose.readFile` 经 IPC 读主题；文本变化 300ms 防抖全量 rebuild；放映 `createDeckPlayer` | marktext（fork） |
| **M2 导出与菜单** | marktext 菜单项挂 M0 的 `exportPptx`；投屏广播（CAST）纯 web 侧能力，顺带可用 | marktext（fork） |
| **M3 决策点** | ① IR_v3 P1/P2 增量分排：由 M1 真实文档的 rebuild 时延数据裁决，不预排期；② muya 自家 slides/slide 编辑视图（fork TODO1 方向）：独立裁决，且只做 Tier 0 逻辑页（§0 第五条裁决） | 两仓 |

## 5. M1 实施裁决（2026-10-30，代码侦察后定稿）

> 三条**代码级事实**推翻了 §0/§1 的两处实现假设（裁决本身不动摇，落地形态修正）。

### 5.1 事实基准

| 事实 | 证据 | 推论 |
|---|---|---|
| renderer 全沙箱：`nodeIntegration:false` + `sandbox:true` + `contextIsolation:true` | fork `packages/desktop/src/main/config.ts:12-20` | Typora「父侧 Node 跑 compose」不成立；Node 能力只有 preload `fileUtils`（**异步** IPC fs 面）与既有 IPC |
| CSP `script-src 'self'`（无 unsafe-inline）+ `font-src 'self' data:` | fork `src/renderer/index.html` meta | **srcdoc 内联脚本直接被拦**（初稿方案因此否决，见 §5.2 二修）；且继承 CSP 的文档取 http 字体也被拦。出路只有一条：deck 页面从本地服务加载，自成一篇无 CSP 的文档。`frame-src http:` 放行 iframe 取服务；`wasm-unsafe-eval` 允许 viz WASM |
| 切 slides 视图 **销毁 muya**（editor.vue 被 v-if 摘除） | fork `editorWithTabs/index.vue:18-30`（wysiwygLens=null） | 「读 muya 活 DOM 收割图表」的 B 形态不成立——放映期间没有活 DOM |

### 5.2 形态修正（对 §0 的落地修正；2026-10-30 二修：deck 页面从本地服务加载）

1. **图表桥：活 DOM 收割 → 离屏同款渲染器出图**。「复用宿主产物」的精神保留——用 muya
   **同款渲染器栈**离屏出图，与编辑器同库同版本（一致性反而更强），且不依赖编辑器存活：
   - mermaid / echarts → 页面侧自己画（运行时按需从服务加载，见 deck-full 的 ensureDiagramLibs）；
   - graphviz(dot) → renderer 动态 `import @viz-js/viz`（muya 同款 WASM 依赖）→ svg → PNG
     （序列化/栅格抄 fork 现成的 `util/diagramExport.ts`）；
   - plantuml → fork 既有 `window.diagram.fetchPlantuml` IPC（main 进程 net.fetch 远程 server）。
2. **deck 页面从宿主本地服务加载（srcdoc 方案已否决）**。初稿曾定"srcdoc + 字体/图片
   data: URL + 零 main 改动"，复查发现 **CSP `script-src 'self'`（无 unsafe-inline）会拦下
   srcdoc 里的内联脚本**——做出来就是白屏。放宽整个编辑器的 CSP 给"恶意课件"开门，不值。
   终案：marktext **main 进程**起宿主本地服务（复用 md2slides `host/server`，Typora 同款、
   久经考验；renderer 起不了任何服务是沙箱铁律），deck 页面 = `<iframe src=http://127.0.0.1:…/deck.html>`——
   服务出来的文档**不受编辑器 CSP 约束**，脚本/字体/图片全部自然放行；frame-src http: 已放行。
3. **compose 进 iframe（deck-full）**。Typora 父侧 compose 的两大理由（父侧有 Node、收割要
   读父侧 DOM）在 marktext 都不成立；且 compose 的 `readFile` 钩子是**同步**签名，异步 IPC
   喂不了。deck-page 同族新入口 **deck-full**（compose + 图表 + 分页 + 染色 + 播放器 + IR
   全在页面内）：资产预热（fetch `/assets.json` 清单 → 内存映射表 → 同步查表喂 readFile，
   含给 fs stub 补 `readdirSync`——loadTheme 扫目录不走 readFile 钩子）；markdown-it /
   katex / hljs / html-to-image 作为**源码模块直接进 bundle**（该 target 的 sourceRoots 含
   lib，免去 UMD 全局与壳加载顺序的猜谜）；mermaid/echarts 体积大，按文档内容动态加载。
   好处：父组件（Vue/TS）**零 md2slides 代码依赖**（vendored 静态资产 + postMessage）；
   防抖重建**不重载页面**——build 消息原地重跑 compose 换 `#deck`，无闪烁。

### 5.3 桥协议（postMessage；页面 = 宿主服务上的 /deck.html，与父组件跨源）

```
页面 → 父  {type:'md2s:boot'}                        页面就绪（收到它才许发首帧 build）
父 → 页面  {type:'md2s:build', md, mdDir, runOpts{mode,browse,startIndex}}
页面 → 父  {type:'md2s:ready', pages,index,total,steps,diagrams,images,
                         slideWidth,slideHeight,meta,theme}
           | {type:'md2s:change', index, total, step, steps, mode}
           | {type:'md2s:error', stage:'build', message}
           | {type:'md2s:esc'}                                              ← 焦点在 deck 内的 Esc 转发
           | {type:'md2s:rpc', id, kind:'diagram', diagramType, source}   ← graphviz/plantuml 托渲染
父 → 页面  {type:'md2s:rpc-result', id, ok, dataUrl|error}
```

图片：compose 后页面把本地相对路径改写成 `${服务}/f?p=<绝对路径>`（deck.js 同款改道，
allowRoots = md 所在目录白名单）；字体：`katexFontsUrl = ${服务}/fonts/`（真实字体文件，
无 CSP 约束——data: URL 方案随 srcdoc 一起作废）。

`window.deck`（run / ir / exportImages / getPlayer）契约保持不变；deck-full 与 deck-page
**共享同一实现** `host/browser/deck-core.js`（deck-entry 变薄挂线，Typora 产物行为零变动，
host-test 原有用例全绿）。真机链路有 host-test 真浏览器用例盯：boot 握手 → 资产预热 →
compose（含公式）→ dot 经 rpc 托渲染 + mermaid 页面侧真渲 → 分页 → 播放器 → 原地重建。

### 5.4 两侧交付清单

| 仓 | 件 | 状态 |
|---|---|---|
| md2slides | ① `host/marktext/deck-full-entry.js` + `deck.html`（build 协议 / 资产预热 / 图片改道 / rpc 托渲染）② `host/browser/deck-core.js`（deck-entry 内脏抽出，run 增 renderDiagramHost 路由与旧播放器拆除）③ build-host 第三 target（sourceRoots 含 lib）+ `tools/pack-marktext.js` 资产包（deck.html / dist / themes / katex+fonts / mermaid / echarts / server.js / assets.json → `out/marktext/`，`npm run pack:marktext`）④ `host/server` 抽共享（Typora 转发，新增 assets 静态根）⑤ check-deps 收编三新目录 | ✅ 2026-10-30（host 33/33、e2e 369 全绿） |
| marktext（fork） | ① main：本地服务 IPC（vendored server.js，起停 + allowRoots）② renderer：`slidesPresent.vue`（iframe→服务 / postMessage 桥 + 图表 rpc 应答（viz 离屏、fetchPlantuml）/ 300ms 防抖 rebuild / 放映 UI + Esc）③ `editorView.ts` present 翻 `implemented:true`（滑块自动隐藏，已核实）④ `editorWithTabs/index.vue` 按 subView 分流 ⑤ 资产同步脚本（out/marktext → resources/md2slides，gitignore） | ✅ 2026-10-31 **真机验收通过**（commit 4bf57e2d + f2307708 修 require 解构） |

M2（导出）✅ 2026-10-31（md2slides `31b0d08` + fork `6411c943`）：导出拆**取数/出片**
两半——取数在 renderer（deck-full 新协议 `md2s:export`→`export-result`，页面自己跑
exportImages()/ir()，editable 闸门话术就地展示不进出片），出片在 main（`host/pptx` 新增
`exportFromData`，Typora 的 exportEditable 内部同源复用；fork IPC `mt::md2slides::export`
require vendored pptx.js）。放映工具条双导出按钮；ready 消息带 `ms`（构建耗时），
M3 增量分排的实测数据从此开始攒。
