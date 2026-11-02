# MD2Slides 公开 API（npm: @quqingyuan/md2slides，0.1 · P-1 库化）

> 本文档是 md2slides 作为**独立库**的对外契约：入口签名、运行环境矩阵、宿主钩子与版本承诺。
> 内部架构见 `README.md`，演进蓝图见 [`docs/design/IR_v3.md`](./design/IR_v3.md)，
> 一个宿主的完整调用序列（纸面消费者）见 [`docs/design/integration-marktext.md`](./design/integration-marktext.md)。
> 本文与代码不一致时，先改本文再改代码。

---

## 0. 契约的范围与承诺

- 受 semver 保护的只有 `require("@quqingyuan/md2slides")` 转发的出口（见 `index.js`）。
- 子路径 `require("@quqingyuan/md2slides/core/xxx.js")`（须带 `.js` 后缀）与
  `@quqingyuan/md2slides/export/…`
  **可以用，但没有兼容承诺**——内部模块随时按 IR_v3 重构（`overflow.js` → `plan/` 等）。
- IR（`extractIr` 产物）按 `version` 字段独立演进：当前冻结 **v1**
  （书面定义 `export/pptx/ir.schema.json`，draft-07）。IR v3 落地时消费者按 `version`
  分流，v1 至少再兼容一个主版本。
- 0.x 阶段：次版本 = 新增 / 不破坏；破坏性变更升次版本并在 `CHANGELOG.md` 标注
  （1.0 起严格 semver）。

---

## 1. 一分钟接入

形态 A 宿主（自带浏览器或 Electron renderer）把一份 md 变成分好页的幻灯片：

```js
const md2slides = require("@quqingyuan/md2slides")

// ① 解析 + 逻辑分页 + 主题。Node 传 jsdom 的 document；浏览器/iframe 传 iframe 的 document
const deck = md2slides.compose(mdText, { document: iframeDoc })
injectStyle(iframeDoc, deck.css + md2slides.CONT_CSS)   // CONT_CSS 由宿主自拼（见 §2.3）
injectHtml(iframeDoc, deck.html)

// ② 图表预通行：core 只调度，出图的是宿主。必须发生在实测分页之前
await md2slides.renderDiagrams(iframeDoc, { renderDiagram: hostRenderDiagram })
md2slides.assertDiagramsRendered(iframeDoc)             // 分环境多遍时最后兜底

// ③ 物理分页：真实布局引擎里跑，settle 到没有新增页为止
for (let i = 0; i < 6; i++) {
  if (!md2slides.splitOverflow(iframeDoc, {
    slideWidth: deck.slideWidth, slideHeight: deck.slideHeight, meta: deck.meta,
  })) break
}

// ④ 分页切了代码块会丢高亮 span → 重染一次（幂等，可反复跑）
md2slides.highlightCode(iframeDoc)

// ⑤ 要导出可编辑 PPTX 才需要：抽 IR + 过闸门
const ir = await md2slides.extractIr(iframeDoc, {
  slideWidth: deck.slideWidth, slideHeight: deck.slideHeight,
  theme: deck.theme, meta: deck.meta, media: mediaSink, rasterize: hostRasterize,
})
const { issues } = md2slides.checkIr(iframeDoc, ir)     // issues 非空即拒，不出片
```

不写 PPTX 的宿主（预览 / 放映）到 ④ 为止。

---

## 2. 入口明细

### 2.1 `compose(md, opts?) → ComposeResult`

md 文本 → HTML 片段 + CSS + 文档对象。逻辑分页（按标题层级切 `<section data-slide>`）、
front-matter（八键）、封面生成、关键词高亮、主题都在这里。**不改写 md 源码**；
没有布局依赖，Node（jsdom）与浏览器都能跑。

| opts | 类型 / 默认 | 说明 |
|---|---|---|
| `document` | `Document` | 建 DOM 用。浏览器宿主传 iframe 的 document；Node 传 `new JSDOM("").window.document`；缺省用全局 `document`（Node 下没有全局，必传） |
| `defaults` | `{ headingDivider: 3, theme: "lecture" }` | front-matter 缺省值（`DECK_DEFAULTS`） |
| `expandCols` | `boolean = true` | 是否展开 `<!-- begin/split/end -->` 三注释分栏 |
| `semicolons` | `boolean = true` | 是否把「A；B；C。」分号并列段落转成列表（`ComposeResult.semicolons` 返回命中数；front-matter `semicolons: false` 亦可关） |
| `codeWrap` | `boolean = true` | 代码块是否换行（false 则只能整体缩小） |
| `themesDir` | `string` | 主题目录（自定义主题注册点） |
| `readFile` | `(file) => string\|null` | 读文件实现。浏览器宿主注入（IPC / 预取），Node 缺省用 `fs` |
| `highlight` | `boolean = true` | 是否在 compose 时就染一次代码高亮 |
| `math` | `boolean = true` | 是否按需拼 KaTeX CSS |
| `katexFontsUrl` | `string` | KaTeX 字体目录地址。**必须 http(s)://**——浏览器拒绝 XHR 到 `file://`，量出的公式高度是 fallback 字体的（README 已知坑） |

返回（`ComposeResult`）：

| 字段 | 说明 |
|---|---|
| `html` / `css` | 序列化产物。⚠ `html` 是 compose 完成那一刻的快照——之后 `renderDiagrams` 改了 DOM，宿主要自己从 `doc` 重新序列化（见 §3 时序 3） |
| `doc` | 文档对象（就是传入的那个 document 加工后的样子），后续所有步骤的操作对象 |
| `slideWidth` / `slideHeight` | 画布尺寸（px，来自主题；默认 1920×1080）。**直接喂给 `splitOverflow` / `extractIr`** |
| `slideCount` / `theme` / `columns` | 逻辑页数 / 主题名 / 展开的分栏组数 |
| `meta` | 八键文档元数据（title/subtitle/author/date/book/header/footer/keywords），透传给 `splitOverflow`（家具）与 `extractIr`（文件属性） |
| `columnDiags` / `coverDiags` | 分栏语法诊断（带源码行号）与封面诊断 |
| `semicolons` | 转成列表的分号段落数 |
| `highlighted` / `keywords` | 染色块数 / 命中关键词数 |

### 2.2 `renderDiagrams(doc, opts?) → Promise<{ rendered, types, pending }>`

图表预通行：认出图表围栏（mermaid / graphviz / plantuml / echarts），调宿主钩子出位图，
替换成 `<img>`（只缩不放）。**不接受缺图降级**：缺钩子 / 返回空 / 渲染抛错 → 抛
`DiagramError` 中止。

| opts | 说明 |
|---|---|
| `renderDiagram(block)` | 宿主钩子。`block = { pre, code, lang, type, source }`；返回 `{ dataUrl \| png, width?, height? }`，**必须给位图**（SVG 由宿主先栅格成 PNG）；也可返回 `{ defer: true } = 这一遍不接，块原样留给下一遍`（块级版 `only`——同类型不同块归宿不同时用，如带编辑器的宿主：有 panel 的 mermaid 父侧收割，没 panel 的 defer 给页面侧） |
| `only` | `string[]`：这一遍只处理这些类型（分环境多遍：graphviz 在 Node、mermaid 在页面） |
| `settle` / `frames` | 是否等帧让异步图铺开（默认 true / 2 帧） |

返回值的 `pending` = 被 defer 遗留的类型（去重）——调用方据此决定下一遍要谁接手、
要不要注入对应运行时（宿主按它条件内联 mermaid / echarts 库）。

配套：`assertDiagramsRendered(doc)`——所有预通行跑完后调一次，仍有未渲染围栏即抛
`DiagramError`。

### 2.3 `splitOverflow(doc, opts?) → number`

物理分页：浏览器实测每块高度，溢出则按 README 分割策略切页（整块搬运 > 切块，
核心组保护，孤行控制，每页最多一个核心组），收敛后注入页眉页脚并打页码。
返回本轮新增页数；**反复调用直到返回 0**（settle，见 §1 ③）。

| opts | 默认 | 说明 |
|---|---|---|
| `slideWidth` / `slideHeight` | — | 画布尺寸，传 `compose` 的返回值 |
| `meta` | — | `compose` 的 `meta`，页眉页脚（家具）的输入，`meta.toc` 同时驱动章节目录页 |
| `margin` | `1` | 页高预算系数 |
| `maxPasses` | `4` | 内部单轮最大遍数 |
| `contMarker` | 不标 | 续页标记文本（如 `"（续）"`） |
| `repeatHeading` | `true` | 续页是否重复标题 |
| `headingPathSeparator` | `" > "` | 页眉面包屑分隔符 |
| `toc` | `meta.toc` | 章节目录页开关，优先级高于 `meta.toc`：`false` 关 / 数字 = 子项列到该级 |
| `tocTitle` | `"目录"` | 目录页标题文本；条目一页放不下时自动分多页，续页题名加"（续）" |

**宿主必须把 `CONT_CSS` 拼进 deck CSS**——续页标记的样式不在主题里，缺了就是裸文本。
（`CONT_CLASS` 是标记的 class 名，播放器要跳过它们时用。）**`TOC_CSS` 同理**：章节目录页
的兜底样式（引擎生成物的下限，主题里的那份优先，一律 `:where()` 零特异性）。目录页本身
由 `splitOverflow` 在收敛时自行插入，宿主无需调它。

### 2.4 `highlightCode(doc) → number`

代码染色（highlight.js 切 span）。幂等、读 `textContent`、可反复跑。
`splitOverflow` 按行切代码块会丢 span，**分页收敛后必须重染一次**。

### 2.5 `extractIr(doc, opts?) → Promise<IR>`

DOM → Slide IR（v1）：几何 = 实测矩形（英寸，画布归一化 13.333×7.5），样式 = 逐元素
computed style，内容 = runs。只回答「有什么、在哪、什么样式」，不含 PPTX 概念。

每个内容块带 `srcRange: [起始行, 结束行]`（1 基、含端点）——它来自 md 的哪几行，
供宿主做「点击幻灯片跳源码行」与增量重排；切页后的续块（半个代码块、半张表、
半个列表）行号已按切点收缩；封面/家具等引擎生成的块没有。列表条目级也有
`items[].srcRange`。

| opts | 说明 |
|---|---|
| `slideWidth` / `slideHeight` | 传 `compose` 的返回值 |
| `theme` / `cssHash` | 主题名与指纹（进 IR meta） |
| `meta` | `compose` 的 `meta`（文件属性三键 + subtitle） |
| `media` | 图片落盘钩子 `{ add(src, kind) → 文件名 }`。**没有它 image 块的 src 是 null**，闸门会报「图片未落盘」 |
| `rasterize` | 元素 → PNG data URL 的兜底栅格钩子（公式 / 活组件走它） |
| `skipSelector` | 宿主插件 UI 的选择器（如编辑器的 `"[data-plugin-activatable]"`），命中即跳过不进 IR。core 默认空——core 不知道编辑器的存在 |
| `settle` / `beforeSlide(i)` | 测量前等待钩子（活图表铺开画布）/ 抽每页前翻页钩子（隐藏页 canvas 是 0×0） |
| `diagramScale` | 内联 SVG 栅格倍率 |
| `baseDir` | 相对路径图片的基准目录 |

### 2.6 `checkIr(doc, ir, opts?) → { issues, stats }`

IR 验收闸门：逐页文本等价（去空白比较）+ 几何不越界 + 图片落盘检查。
`issues` 非空即拒——内容准确性在抽取这步锁死，不留给下游。
`opts.skipSelector` 与 `extractIr` 同款（两边必须一致，否则闸门会把宿主 UI 当丢字报）。

### 2.7 播放器：`createDeckPlayer(root, opts?)`

框架无关的一页一屏视图（`kit/` 层）：缩放适配容器、翻页、逐元素步进、页码/步号状态。
职责只有「怎么看」——翻页按钮、页码 UI、全屏、步进高亮的样式都是宿主的事，player 给
`onChange({index, total, step, steps, mode})`（1 基，创建时也发一次）与
`index` / `total` / `step` / `steps` / `mode` / `next` / `prev` / `go` /
`stepFwd` / `stepBack` / `activate` / `setMode` / `fit` / `destroy`。

**两种放映形态 + 一个开关**（2026-10-26 用户设计评审：显示形态与翻页粒度正交；
`setMode` 运行时切，切换清零步进状态，当前页按新形态重放）：

**三种输入（2026-10-30 起）：键盘 + 触屏手势 + 触屏轻点，共用同一张语义表**——每个手势 /
每次轻点都只翻译成一个键盘方向键（`navKey()` 是唯一的导航立法地），不存在两套各漂各的
翻页逻辑。

| 手势（指头往哪去） | page+browse（默认） | page（browse:false） | element |
|---|---|---|---|
| 左滑 | 下一页（同 →） | 下一页 | 下一页 |
| 右滑 | 上一页（同 ←） | 上一页 | 上一页 |
| 上滑 | **下一步**（步尽溢出翻页，同 ↓） | 下一页 | **下一步**（揭示；步尽翻页） |
| 下滑 | **上一步**（首步回上一页到步尽，同 ↑） | 上一页 | **上一步** |
| **点右半屏** | **下一步**（步尽溢出翻页，同 ↓） | 下一页 | **下一步**（步尽翻页） |
| **点左半屏** | **上一步**（首步回上一页到步尽，同 ↑） | 上一页 | **上一步** |

轻点（2026-10-30 追加，触屏没键盘、没翻页笔时的常规手段）：抬手时位移 ≤ `tapSlop`
（默认 12px，且不超过 `touchDistance` 的 30%）、用时 ≤ `tapTimeout`（默认 500ms，
更长算长按 / 选词）才算「点」。分界 `tapZone` 默认 0.5（左右各半，压线算前进——别让
点正中没反应）。**点在「有自己的事要办」的东西上一律不导航**：按钮 / 链接 / 表单控件 /
图片（点图是开查看器）/ `data-md2s-activatable`（▶ 运行代码、竞答「发放」）/ 实现类名
`TAP_IGNORE`（player 导出该选择器，宿主可传 `tapIgnore` 覆盖）。判据取自**按下时**的
target——指针捕获会改写抬手时的 target，用它判就永远判不出按钮。

- `tapNav: "step"`（默认）/ `true`：走 ↓↑ 语义，先步进、步尽才翻页（点一下继续讲）。
- `tapNav: "page"`：恒定整页翻，不动步进（讲师只想换页时）。
- `tapNav: false`：关掉轻点导航（手势仍可用）。

手势层 `kit/swipe.js` 只识别「单指方向」与「单指轻点」，不掺业务：触发门槛默认
40px / 800ms（`touchDistance` / `touchTimeout` 可调），主轴不到副轴 1.2 倍的斜划不触发，
第二根手指落下即作废（那是双指缩放，不是翻页），起点落在输入框 / contenteditable /
`touchIgnore` 里不起手。默认横向拖动有跟手位移（`touchFeedback: false` 关），到首尾页
再往外拖是 0.25 阻尼的橡皮筋。指针捕获**等确认在拖了才捕获**（越过 `tapSlop`）——
按下即捕获会把随后补发的 click 目标改写成容器，指头底下那个按钮就永远点不动。

宿主要关掉：创建时 `touch: false`（整个手势层不接）。
容器 `touch-action` 默认 `pinch-zoom`——**单指平移归手势层、双指缩放仍归浏览器**；
想要 chromium 彻底不插手就传 `touchAction: "none"`（代价放映区不能双指缩放）。

| 键 | page+browse（**默认**，整页全显 + 逐元素游走） | page（browse:false，纯整页翻） | element（渐进揭示） |
|---|---|---|---|
| ↓ / 空格 / **PgDn** | **下一步**（高亮移动，内容全显；步尽翻页） | 翻页 | **下一步**（揭示；步尽翻页） |
| ↑ / **PgUp** | **上一步**（第一步回上一页恢复到步尽） | 翻页 | **上一步**（同左） |
| ← → | 恒为翻页（快速跳页） | 翻页 | 恒为翻页（快速跳页） |
| Enter | 触发**当前步**的可激活元素（步进到位才命中） | 触发页内第一个可激活元素 | 触发**当前步**的可激活元素 |
| Home / End | 首末页 | 首末页 | 首末页 |

- `show: "page"`（默认）整页全显。`page: true`（默认 browse）：步进只动高亮
  （`md2s-step-current`，`md2s-browse` 上的默认黄红色描边 + 黄里透黄暖光辉（柔光晕）、按缩放反向放大所以投影下
  也明显，主题可覆盖），**不隐藏任何
  内容**；翻页笔走到 ▶ 上按 Enter 运行。`page: false`：纯整页翻。
- `show: "element"` 渐进揭示：未揭示元素 `visibility: hidden`，逐元素上/下一步。
- 翻页笔：主流笔的"下一页"键发 **PageDown**——两种形态里它都并进步进
  （2026-10-26 修订；此前"恒为翻页"让笔无法逐元素讲）。
- 遗留：`mode: "slide"` 是旧键别名（= page + browse:false），仍被接受。

**可激活元素（Enter 契约）**：宿主给页内元素标 `data-md2s-activatable`（click 监听与
样式都归宿主——放映中跑代码块的通用接入点）。`Enter` / `activate()` 触发 click：
element 与 page+browse 命中**当前步**上的第一个（未步进到位 = 不命中），page 纯翻页
命中当前页的第一个；没有可命中目标时 Enter **原样放行**（不 preventDefault，不吞键）。
player 只管派发 click——▶ 按钮长什么样、点了跑什么，是宿主（或宿主插件，如代码
执行引擎）的事。

**步进粒度**（封闭表，`kit/steps.js` 立法）：标题（任意级）/ 家具 / 封面 = 恒显锚点不算步；
顶层块各一步；列表每项一步（嵌套列表跟随父项）；**表格先整张表一步、之后每数据行一步**
（2026-10-30 修订：早先是"表头跟首行同一步"，一步同时点亮表头与首行两个框，紧贴又交叉，
看着像描边画重了）；
分栏递归每栏（栏内列表也逐步）；活图表经 `steppers` 钩子切分（`{match, create→{count,show,hide}}`，
core 调度宿主执行，与 `renderDiagram` 同构），没钩子 = 整块一步；**可激活元素各成一步**，
附在所属块最后一步之后（翻页笔逐元素翻到 ▶ 上，高亮由宿主/主题给 `md2s-step-current`
加样式）。宿主装饰页 DOM 后调 `refreshSteps()` 重建步进表（装饰前建的表不含新步）。

**揭示机制（版面冻结铁律，仅 element 形态）**：未揭示元素 `visibility: hidden`——
占位不显示，页面从进来那一刻就是最终版面（display:none 会让垂直居中随步进重排、
测量漂移）。累积显示：讲过的留在屏上；当前步标 `md2s-step-current`、讲过的标
`md2s-step-past`（element 形态两者默认无样式，宿主/主题自行加高亮或变灰；page 浏览
形态下 `md2s-browse` 给了当前步默认黄红色描边 + 黄里透黄暖光辉（柔光晕）、按缩放反向放大所以投影下也明显）。
翻回的页保持已揭示/已游走状态。

行为细节：页 DOM 会被搬进 player 自建的 stage（同一文档内移动，属性监听不丢，
`destroy` 原序搬回）；可见性归 player 管（非当前页 `display:none`），缩放靠
`--md2s-scale` CSS 变量 + ResizeObserver 自动适配；容器无尺寸时缩放保底 1。
`stepIssues` 收集 steppers 钩子的异常（不进控制台）。

#### 2.7.1 图片查看器：`mountLightbox(doc, opts?) → Lightbox`

放映态点击幻灯片里的图片 → 全屏查看器（缩放 / 拖动 / 切图）。`kit/` 层、浏览器通用、
零第三方依赖；宿主各自的放映器（marktext deck 页面 / 独立 HTML 导出件）各传自己的 `currentSlide`
即可复用同一份。

- **打开**：事件委托认 `IMG`（图片本身一个属性都不加），点一下就以当前页第一张图打开、
  `alt` 文字当图注。当前页图片由 `opts.currentSlide`（默认 `.md2s-current` /
  `section[data-slide].active`）**每次打开现收**，故换页不用手动 refresh。
- **交互**：滚轮 / `Ctrl+wheel`（触控板 pinch 发这类事件）以**指针为锚**缩放（锚点公式保证
  "滚哪儿缩哪儿"）；双击 `fit ↔ 1:1` 切换、双击点保持；鼠标拖动 / 单指拖动平移，超出视口
  边缘钳住、图小于视口锁死居中；双指 pinch 缩放 + 双指平移。`←/→` 当前页多图切换（底部
  `n/m`），`Esc` / 点背景 / ✕ 关闭。工具栏：`‹ › − ＋ 适应 1:1 ✕`。
- **输入隔离（设计核心）**：打开时在浮层 + `window` 的 **capture** 阶段拦截
  `keydown`/`pointerdown` 并 `stopPropagation`——既挡住 player 的键盘翻页，也挡住
  `kit/swipe.js` 的触屏手势（手势挂在 root 上），**不给 player 加 pause 开关**。Esc 在
  window capture 先吃，关的是查看器而非整个放映；与 exec 结果面板 / 竞答浮层经
  `md2s-overlay-dismiss` 事件友好让位。
- **零 DOM 侵入 ⇒ IR / PPTX 零影响**：图片仍是裸 `<img>`（落 `<p>` 内），IR 的 `skipSelector`
  不命中、两种 PPTX 导出照常；已用 e2e 像素回归确认版面不变。
- **公开 API**：`openAt(node) / close() / refresh() / destroy()`；属性 `isOpen` / `count`
  / `index` / `scale`；回调 `opts.onOpen` / `opts.onClose`。`opts.maxScale`（默认 8）、
  `opts.selector`（默认 `img`）、`opts.ignore`（额外排除选择器）、`opts.view`（所属 window）。

### 2.8 页容器契约：`sectionsOf` / `SLIDE_SELECTOR` / `beginMeasure` / `endMeasure`

- `sectionsOf(doc)`：文档序的全部页（`Element[]`），播放器翻页就遍历它；
- `SLIDE_SELECTOR`：页容器选择器的唯一出处（`section[data-slide]`），别处硬编码即漂移；
- `beginMeasure(doc, w, h)` / `endMeasure(doc)`：**成对调用**。摊开所有页并钉到画布
  尺寸，让任何 `getBoundingClientRect` 都在设计坐标系里。宿主自己要量页（截图、对齐
  检查）时用；`splitOverflow` / `extractIr` / `checkIr` 内部已自带。

---

## 3. 运行环境矩阵

| 入口 | Node + jsdom | 浏览器 / Electron renderer | 说明 |
|---|---|---|---|
| `compose` | ✅ 必传 `opts.document` | ✅ | 不碰布局，只做解析与 DOM 组装 |
| `renderDiagrams` | ✅（Node 侧渲染器一遍） | ✅（页面侧渲染器一遍） | 分环境多遍是常态，`assertDiagramsRendered` 兜底 |
| `splitOverflow` | ❌ | ✅ | jsdom 没有布局引擎，量出来全是 0 |
| `highlightCode` | ✅ | ✅ | |
| `extractIr` / `checkIr` | ❌ | ✅ | 同上 |
| `sectionsOf` / measure 对 | ✅ | ✅ | |
| `createDeckPlayer` | ⚠️ 只能建与翻（缩放无布局可算，保底 1） | ✅ 完整（ResizeObserver 自动适配） |

时序铁律（违反即产出错误结果，不是风格建议）：

1. **图表先于测量**：`renderDiagrams` 必须在 `splitOverflow` 之前——晚了量到的是 0 尺寸块，
   分页与 IR 几何全错。
2. **`splitOverflow` 后重染**：`highlightCode` 必须在分页收敛之后跑一次。
3. **`deck.html` 是快照**：`renderDiagrams` 改了 DOM 之后，`deck.html` 已过期，宿主从
   `deck.doc` 自己序列化（`e2e/runner.js` 就是这么干的）。
4. **家具在分页内**：页眉页脚由 `splitOverflow` 收敛后注入，宿主不要自己画。
5. **字体走 http(s)**：iframe 页面里 KaTeX 字体必须可取（`file://` 会被浏览器拒绝 XHR）。

---

## 4. 宿主钩子契约汇总

| 钩子 | 挂点 | 签名 | 失败语义 |
|---|---|---|---|
| `renderDiagram` | `renderDiagrams` opts | `(block) → { dataUrl\|png, width?, height? }` 或 `{ defer: true }` | 抛 `DiagramError` 硬失败，不出占位 |
| `media.add` | `extractIr` opts | `(src, kind) → 文件名 \| null` | 返回 null → 闸门报「图片未落盘」 |
| `rasterize` | `extractIr` opts | `(el) → Promise<dataURL>` | 失败退回 `custom` 块登记 |
| `readFile` | `compose` opts | `(file) → string \| null` | null → 主题加载失败按缺省主题 |

---

## 5. 不在 API 内（边界声明）

- **图表渲染引擎**（mermaid / echarts / plantuml / graphviz）：宿主职责，core 永不引入
  （README「架构决策」铁律）。参考实现：`host/thin/`（graphviz / plantuml）、
  `e2e/mermaidHost.js`、`e2e/echartsHost.js`。**`host/` 不随 npm 包分发**，宿主参考实现
  在仓库里。
- **PPTX sidecar**（python-pptx）：导出通道，进程外独立存在，幻灯片视图不依赖它。
- **源码行映射**：✅ 已内置（`srcRange`，见 §2.5）；增量重排（section 级脏标记）在
  IR_v3 P1（`docs/design/IR_v3.md`）。
