# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本语义与冻结范围见
[`docs/API.md`](./docs/API.md) §0。0.1.0 之前的引擎开发史见 git log。

> Typora 宿主壳已因合规评估从主仓库移出（代码、设计文档与专属测试单独备份）；下文历史
> 记录中的 Typora 条目保留原貌，仅作历史参考，不代表当前支持。

## [0.1.0] — 2026-11-02

首次公开发布：项目名 MD2Slides、仓库 quqingyuan/md2slides、npm 包
`@quqingyuan/md2slides` 三层统一。npm 上的裸名 `md2slides` 已被他人占用，故以个人
作用域名发布（`npm publish --access public`）。下文历史记录中的 `require("md2slides")` /
`md2slides/core/…` 是当时的包名。功能演进见下各节。

- 默认主题 `python-mini-pptx` 更名为 `lecture`：名字描述用途（讲义），不再沿用 Python
  实现出身；下文历史记录中的旧名是当时的写法。

## [Unreleased] — marktext 集成 M1（md2slides 侧）：deck-full 页面形态 + 共享 server + 资产包

> 设计与裁决见 `docs/design/integration-marktext.md` §5（srcdoc 初案因 CSP script-src 否决，
> 终案 = main 进程本地服务 + 服务上的 deck 页面 + postMessage 桥）。

### Added

- **`host/marktext/deck-full-entry.js`（→ dist/deck-full.js）+ `deck.html`**：marktext 形态的
  整链 deck 页面——compose 也在页面里跑（宿主渲染进程全沙箱，父侧 Node 路不存在）。桥协议
  postMessage：`md2s:boot`（页面就绪握手）→ `md2s:build{md, mdDir, runOpts}` →
  `md2s:ready/change/error`；graphviz/plantuml 经 `md2s:rpc` 托宿主离屏出图（marktext 侧用
  muya 同款 viz WASM / fetchPlantuml）。资产预热：fetch `/assets.json` 清单 → 内存映射 →
  同步查表喂 compose 的 readFile（含给 fs stub 补 readdirSync——loadTheme 扫目录不走钩子）；
  图片改道 `${服务}/f?p=`（deck.js 同款）；mermaid/echarts 按文档内容动态加载（纯文本文档
  不为 5.5MB 运行时买单）；**rebuild 原地**：防抖后重发 build 消息，不重载页面、无闪烁。
- **`tools/pack-marktext.js`（`npm run pack:marktext`）**：fork 的 vendored 资产包
  `out/marktext/`（deck.html / dist/deck-full.js / themes / katex+fonts / mermaid / echarts /
  server.js / assets.json）。
- **`host/server/`（共享本地服务）**：从 host/typora/server.js 上移，新增 `assets` 静态根
  （`{prefix, dir}` 登记制 + 穿越拦截 + MIME），marktext 用它挂资产包与 deck 页面；Typora
  变纯转发，行为零变动。
- host-test 两用例：server assets 根（MIME/穿越）；**deck-full 真浏览器全链路**（boot 握手 →
  预热 → compose 含公式 → dot rpc 托渲染 + mermaid 页面真渲 → 分页 → 播放器 → 原地重建）。

### Changed

- **`host/browser/deck-core.js`（新）**：deck-entry 的引擎内脏抽出，Typora（deck-page）与
  marktext（deck-full）共用同一实现；`run(opts)` 新增 `renderDiagramHost`（宿主托渲染路由：
  BROWSER_TYPES 之外先问宿主，不传则与旧行为逐字节一致）与旧播放器拆除（原地重建路径的
  监听不许累积）。`host/typora/deck-entry.js` 变薄挂线，`window.deck` 契约零变动。
- build-host 第三 target：deck-full 的 sourceRoots 含 **lib**——markdown-it / katex / hljs /
  html-to-image 作为源码模块直入 bundle（1.8MB / 34 模块），免去 UMD 全局名与壳加载顺序的
  猜谜；deck-page 形态不受影响。check-deps 默认范围收编 `host/server`、`host/marktext`。

### 回归

- check 66 文件 / smoke 113 / host **33**（+2）/ e2e **369** 全绿。

> 裁决与排期见 `docs/design/integration-marktext.md` §4（2026-10-30 方案已认可）。
> M0 = 踏脚石：不碰 core、不碰 marktext，marktext 集成要用、Typora 立刻受益的两件。

### Changed

- **导出后端抽成宿主无关模块 `host/pptx/`**（marktext M1 共用同一份）：原
  `host/typora/export.js` 的双通道（图片型逐页栅格 + 可编辑型 IR/sidecar）、
  `ExportError` 错误码（NO_DECK / IR_GATE / PYTHON_MISSING / SIDECAR_FAILED /
  TARGET_BUSY）、原子写、Python 探测全部上移；入口改工厂
  `createExporter({ libDir })`——宿主专属的只有**资产布局**（pptxgenjs 与
  sidecar 必须真实落在宿主自己的 lib 目录），构造时验明，缺资产当场抛，
  不留到用户点导出才发现。`host/typora/export.js` 变薄适配器绑
  `__dirname/lib`，公开面与 shell.js 调用点零改动。
- `install.js` 拷贝清单加共享模块（`host/pptx` → 插件 `pptx/`）；
  `check-deps` 默认范围加 `host/pptx`（随壳作为源码分发，require 图必须守）。

### Added

- **方言语料 `e2e/fixtures/dialect/`**（marktext ↔ md2slides 共享测试输入，
  契约见其 README）：`cols.md`（等宽 / 30:70 / 25:25:50 / 围栏字面）、
  `frontmatter.md`（八键）、`slidebreak.md`（裸 `---`）。`tools/smoke.js` 新增
  「方言语料」段（6 项）：三组分栏零诊断、真标记全消费而围栏内字面、八键全解析、
  compose 出封面 + 章节、`---` 切页且分页符不进页。muya 侧（marktext fork 的
  columns 测试）M1 接线时消费同一批文件——哪边改了解析行为，自己家先红。

### 回归

- `tools/host-test.js` 28 → 31 项：createExporter 构造校验 / NO_DECK 分支 /
  适配器与共享后端同源（ExportError 同引用，宿主 instanceof 不分叉）。
  check 63 文件、smoke 113 项全绿。

## [Unreleased] — 触屏轻点翻页（点右半前进 / 点左半后退）

### Added

- **放映器支持触屏轻点导航**：点屏幕右半 = 前进、左半 = 后退。与 ↓/↑ 完全同义——
  `page+browse` 与 `element` 形态下**先步进、步尽才翻页**（讲课点一下继续讲比一按跳整页
  自然），`slide` 纯翻页形态本来就只有翻页。`kit/player.js` 新增 `tapNav`
  （`"step"` 默认 / `"page"` 恒定整页翻 / `false` 关）、`tapZone`（默认 0.5，压线算前进）、
  `tapIgnore`（禁用区分界）、`tapSlop`（12px）、`tapTimeout`（500ms）。
- **禁区**：点在按钮 / 链接 / 表单控件 / 图片（点图是开查看器）/ `[data-md2s-activatable]`
  （▶ 运行代码、竞答「发放」）上一律不导航——判据取**按下时**的 target。默认禁区选择器
  以 `TAP_IGNORE` 从 `kit/player` 与 `index.js` 导出，宿主可传 `tapIgnore` 覆盖。
- `kit/swipe.js` 加轻点识别（`onTap` / `tap` / `tapSlop` / `tapTimeout` / `tapIgnore`）：
  与滑动共用一套起手状态机（一次手势只可能报「划」或「点」中的一个，不会都报）。
- 独立 HTML 导出件（`tools/export-html.js` 自带放映器）同步同一语义：点右半下一页、
  点左半上一页，长按与点图 / 点按钮不翻。

### Fixed

- **指针捕获改成「确认在拖了才捕获」**：原先 `pointerdown` 立刻 `setPointerCapture`，而
  捕获会把随后补发的 `click` 目标改写成容器——指头底下的按钮（▶ 运行、竞答发放）点了
  没反应。现在越过 `tapSlop` 才捕获，轻点全程不惊动浏览器；真机回归
  `e2e/tap-real.js` 里「点按钮 click 到位且不翻页」盯住这条。
- 播放器容器加 `-webkit-tap-highlight-color: transparent`：轻点是导航手段，落点灰块是噪点。

### 回归

- `tools/smoke.js` 新增「触屏轻点」用例（jsdom / touch 路线）：右半前进、左半后退、
  步尽溢出翻页、点按钮·图片·可激活元素不翻、长按不算点、`tapNav:"page"` / `false` /
  `touch:false` 三个开关。
- 新增 `e2e/tap-real.js`（`npm run e2e:tap`）：puppeteer 真触摸点屏，覆盖 jsdom 测不到
  的三件事——真实命中测试、捕获时序与 click 目标、浏览器双击缩放会不会吞掉连点。

## [Unreleased] — 表格步进改为「先整表、后逐行」

### Fixed

- **表格第一步两个框贴在一起还互相交叉**：`kit/steps.js` 原先让表头跟首行共用一步
  （`thead` 挂在首行步的 `extra` 上），`applySteps` 给 `el` 与 `extra` 同刷
  `md2s-step-current`，于是浏览态下同一时刻表头一个描边光晕、首行一个描边光晕，
  两个矩形紧贴且交叉重叠——看着像同一处描了两遍边。
- **新粒度：整张表一步 → 每数据行一步**（用户拍板：先 step 整个表格，再 step 进每行）。
  一步恒只有一个框：整表步的框把表头一并包住，之后才轮到行框。
- `element` 渐进揭示态同步受益——整表步进来的是"表框 + 表头"（数据行
  `visibility:hidden` 占位，版面依旧冻结），然后一行一行浮出来；早先是首行跟着表头
  一起抢跑。
- 回归护栏：`tools/smoke.js` 步数断言 7 → 8，并新增「退到整表步时当前步唯一且命中
  `TABLE`」；`e2e/entry.js` 当前步计数由「非零」收紧为「恒为 1」——再退回首行 + 表头
  双框会被当场抓住。

## [Unreleased] — 放映态图片查看器（kit/lightbox）

### Added

- **新模块 `kit/lightbox.js`：放映时点击图片 → 全屏查看器**。鼠标滚轮 / 触控板双指捏合
  （`Ctrl+wheel`）以指针为锚缩放（步长分开，pinch 给的 delta 小得多）；双击 `fit ↔ 1:1`
  切换、位置保持；鼠标拖动 / 单指拖动平移，超出视口边缘钳住、图片小于视口锁死居中；
  双指 pinch 缩放 + 双指平移。`←/→` 在当前放映页的多张图之间切换，底部 `n/m` 计数，
  `alt` 文字当图注。工具栏按钮：上一张 / 下一张 / − / ＋ / 适应 / 1:1 / ✕。
- **输入隔离是设计核心**：打开时在本浮层 + `window` 的 **capture** 阶段拦截
  `keydown`/`pointerdown` 并 `stopPropagation`——既挡住播放器键盘翻页，也挡住
  `kit/swipe.js` 的触屏手势（手势挂在 root 上），无需给 player 加 pause 开关。Esc 在
  window capture 先吃，退出的是查看器而不是整个放映（与 exec 结果面板 / 竞答浮层同样
  走 `md2s-overlay-dismiss` 事件友好让位）。
- **零 DOM 侵入**：靠事件委托认 `IMG`，图片本身一个属性都不加；当前页图片由
  `opts.currentSlide`（默认 `.md2s-current` / `section[data-slide].active`）现收。
  因此 IR 抽取、两种 PPTX 导出 **零影响**（已用 e2e 像素回归确认版面不变）。
- **宿主接线**：`host/typora/deck-entry.js` 的放映 iframe 内 `mountLightbox`（DOM 挂
  body 不入 `#deck`）；`tools/export-html.js` 生成的独立放映器经 `bundleScript` +
  `installMd2slides` glue 复用同一份 kit（与 quiz 同范式）。`mountLightbox(doc, opts)`
  公开：`openAt / close / refresh / destroy / isOpen / count / index / scale`。
- 回归：`tools/smoke.js` 新增「kit/lightbox（图片查看）」合成 pointer/wheel/key 用例；
  `e2e/entry.js` 新增 `lightboxProbe`（真 Chromium 验打开 / 缩放钳制 / 拖动位移 /
  双指放大 / Esc 不退出放映），`examples/oversize-tall.png` 已落盘供 oversize 夹具用。
- 探针自带确定性测试图（1200×12000 PNG，同源静态服务器托管），不再依赖 deck 内容或图表
  异步栅格时序——图表被栅格成的 `<img class="md2slides-diagram">` 曾让探针 flaky。

### Fixed

- **查看器里的图整体偏右下（角落出画）**：`.md2s-lb-img` 原用 `position:absolute` +
  `left/top:50%` 定位，却缺关键的 `translate(-50%,-50%)` 把自身拉回一半——而 transform
  是 `apply()` 每帧按 `translate(tx,ty) scale(k)` 覆写的（百分比位移还按未被缩放的盒子算，
  k≠1 时怎么补都歪）。改用**父级 flex 居中**（`.md2s-lb` 本就是 `align/justify:center`），
  未变换时的盒子中心天然等于容器中点，与 `zoomAt` / `clampPose` 那套以中心为原点的公式
  对齐；同时给浮层补 `overflow:hidden` 防超大图溢出带出页面滚动条。e2e 新增「fit 态图
  必须居中」护栏断言（回退到旧 CSS 实测报偏移 600.0/6000.0，能抓住回归）。
- **工具条按钮（‹ › − ＋ 适应 1:1）全部不生效，且拖完松手立刻退出预览**：同一个根因——
  拖动用了 `setPointerCapture`，而指针捕获会把后续 pointerup、**以及浏览器补发的兼容性
  mouse / click 事件**的 target 统统改写成捕获元素（浮层 el）。于是 ① 拖完松手那一下补发
  click 的 target 是 el，被判「点了背景」→ 关闭；② 按钮的 click 拿不到 `data-act`（且
  `pointerdown.preventDefault()` 连 click 都不派发），点了等于没点。
  改法：不再用指针捕获，move / up 改为「按下时挂到 window、松手即摘」；工具条 / 图注区域
  在 pointerdown 阶段直接放行给原生 click；「是不是 tap」一律按下→松手的全过程位移判定、
  且用**按下时**的 target 判断是不是背景，不再听 pointerup 与 click 的 target。
- **图片放大铺满后工具条被盖住点上不去**：img 有 `transform` ⇒ 自成层叠上下文，与
  `position:absolute` 的工具条同级比 DOM 序，而它在工具条之后 ⇒ 画在上面（`elementFromPoint`
  在按钮中心命中的是 img）。给 img 钉 `z-index:1`、工具条与图注钉 `z-index:2`。
- **在图上「快点两处」被误判成双击**，图会忽然跳到 1:1 / 适应（旧判定只看时间窗）。现在
  双击还要求两下落点相距 ≤40px。
- 新增 `e2e/lightbox-real.js`（`npm run e2e:lightbox`）：用 puppeteer 的**真鼠标 / 真滚轮**
  （CDP Input 域）验同一批交互。上面前两条 bug 溜过 CI 正是因为 `lightboxProbe` 打的是合成
  事件、target 由自己给定，① ② 都不会重现——这类「真输入才有」的回归以后走这条。

## [Unreleased] — 章节目录页（每章一页目录，当前章高亮）

### Added

- **新模块 `core/paginate/toc.js`**：每个章节起始页之前插一页目录，列出全部章节 +
  当前章的子项，当前章那条及其子项打 `.md2s-toc-current`（主题蓝 + 加粗，其余灰一档）。
  front-matter `toc` 三态：`true`（缺省，默认开）/ `false` 关 / 数字 = 子项列到该级。
- **页码是二阶的，目录页因此分两拍**：`planToc` 先在 renumber 之前插空壳占位，
  页码定案后再由 `fillToc` 填条目（写进去的只是文本、不改版面）。两拍之间靠 Element
  引用传值，续页 `cloneNode(false)` 继承的 `data-toc-chapter` 用「取首次出现」去重。
- **目录项自带源码行号**（抄自所指标题的 `data-src-*`）——目录页是引擎生成物却没有
  编外行号，IR 的 srcRange 校验与「页内不回跳」照常成立，不必为它破例豁免。
- **主题支持**：`base.css` 加目录页结构位（一律 `:where()` 零特异性，主题必赢），
  `python_mini_pptx.css` 加皮肤；同时导出 `TOC_CSS`（同 `CONT_CSS` 性质：宿主拼进
  deck CSS，Typora 壳的 `deck-entry.js` 已注入）。

### Changed

- **`splitOverflow` 收敛后多一拍**：`planToc` → `renumber` → `fillToc` → `injectFurniture`。
- **一页放不下就自动加页**（用户 2026-10-30 拍板：排不下新增幻灯片，条目不砍不重）：
  目录页**参与物理分页**，但走专用切法——`splitTocSection` 按 li 边界切（通用路径会把
  「题名留原页、整个列表搬新页」，切出只有题名的废页；目录页第一块是题名 `<p>` 而非标题）。
  页数经**轮间反馈**固化：每轮 `planToc` 前按章统计 `data-toc` 页数（`tocPages`，只增不减），
  按页数把条目均分重建为正式多页，续页题名「目录（续）」。切割只发生在轮初 pass 循环、
  本拍只填不切——边填边切会把条目填回首页（`fillToc` 按 plan 数据重建整个列表，不认切割
  结果），中间态会条目重复 + 首页仍溢出。撤掉了旧的上限兜底（`maxItems` / 砍子项 / 整页不插），
  章数上限 14 保留。新增 `e2e/fixtures/toc-many.md`（7 章）锁这条链路。
- **目录页按扉页口径进家具**：不给页眉、不给页脚路径（沿用上一章的名字讲下一章是错的），
  保留页码；面包屑取自目录页自己的 `data-toc-path`。多页目录的每一页都按此办理。
- **`kit/steps.js`**：目录页整页一步（不逐条蹦）——目录是导航，不是待审议的内容。
- **IR / IR schema 零改动**：目录页就是普通 `<section>` + `<p>` + `<ol><li>`，
  `coreTypeOf` 与 ir.js 都当普通段落 / 列表收。e2e 的「列表文本守恒」快照据此排除目录页
  （引擎注入物不进"只搬不丢"的比对）。

## [Unreleased] — 可编辑 PPTX：公式导出为 Office 原生公式（OMML）

### Fixed

- **行内公式不再导出成「未渲染的字符串」**。KaTeX 的 `.katex` 子树里有三份文字
  （MathML 的字符、`<annotation>` 里的 LaTeX 源码、katex-html 的排版字符），
  `runsOf` 一摊平就全念出来，PPT 里成了 `VtV_tVt` 这种串。现在整棵子树换成一条
  `math` run，只带 MathML + LaTeX 源码。
- **块级公式不再栅格成图片**（图片还常常裁不全）。现在是 `math` 块 → OMML →
  PowerPoint 里双击可编辑的原生公式。

### Added

- **IR v1 新增 `math` 块与 `math` run**（`display` / `latex` / `mathml`），schema 与
  `types/index.d.ts` 同步；`check.js` 的「逐页文本等价」按 `data-md2s-math` 标记跳过
  公式——公式不以文字形式进 PPTX，两边口径本来就不同，硬比只会误报。
- **新模块 `sidecar/omml.py`**：MathML → OMML。优先用 Office 自带的
  `MML2OMML.XSL`（产物与 Word 逐字一致，栅栏括号 / nary / 矩阵 / 重音全对；
  只在本机 Office 目录里找，不把微软的资产塞进仓库），找不到时走内置兜底转换器
  （常用 MathML 节点全覆盖，认不出的节点退化成文字，绝不写出让 PowerPoint 报
  「文件有问题」的 XML）。
- **`fill_deck` 落 OMML**：块级公式是居中文本框，行内公式是段落里的一个 `<a14:m>`
  子节点（与普通 run 并列）。字号 / 字体写在 `<a:endParaRPr>` 上——OMML 的 `<m:r>`
  自己不带字号，不写它公式会按模板默认字号冒出来。
- **出片自检多一条**：逐页数公式（IR 的 `math` 块 + `math` run ↔ 成品的 `<a14:m>`，
  表格单元格也进去数）。公式没转成 OMML 会当场报出来，而不是等用户在 Office 里
  看见一行 LaTeX 源码。
- **回归夹具 `e2e/fixtures/math.md`**：行内（正文 / 标题 / 列表 / 表格）、块级
  （求和上下限、求根、二项式、积分栅栏、矩阵、`\text{中文}`）各来一遍。

## [Unreleased] — 放映器触屏滑动翻页（kit 层）

### Added

- **新模块 `kit/swipe.js`：触屏单指手势识别**。只做「一根手指 → 一个方向」的翻译，
  不知道幻灯片的存在（宿主可单用）：左右上下四个方向，到达门槛**当场就报**（不等抬手，
  放映划一下立刻翻才跟手），一次手势只报一次。
  - 事件源二选一：Pointer Events 优先（触屏 / 笔；`mouse: true` 才收鼠标），没有就回退
    Touch Events。**不同时装两套**——Chromium 下 pointer 与 touch 成对派发，双监听同一次
    手势会被算两遍（翻两页）。
  - 误触护栏（宁可不翻也不错翻）：低于 `distance`（默认 40px）不触发；慢拖超过
    `timeout`（默认 800ms）不触发，但**位移过 1.6 倍门槛的长划豁免**；主轴不到副轴 1.2 倍
    的斜划不触发；第二根手指落下立即作废（那是双指缩放）；起点落在输入框 /
    contenteditable / `ignore` 选择器里根本不起手。
- **播放器接入手势，与键盘共用同一张语义表**（`kit/player.js`）。新增 `navKey(key)` 作为
  唯一的导航立法地：手势只是把方向翻译成同一个键（`SWIPE_KEY`），键盘与触屏不可能再各漂
  一套——今后加键 / 改语义只动一处。
  | 手势 | page+browse（默认） | page（纯整页翻） | element（渐进揭示） |
  |---|---|---|---|
  | 左滑 | 下一页（同 →） | 下一页 | 下一页 |
  | 右滑 | 上一页（同 ←） | 上一页 | 上一页 |
  | 上滑 | **下一步**，步尽溢出翻页（同 ↓） | 下一页 | **下一步**，步尽翻页 |
  | 下滑 | **上一步**，首步回上一页到步尽（同 ↑） | 上一页 | **上一步** |
- **横向跟手**：拖动时整页跟着指头走，到首尾页再往外拖是 0.25 阻尼的橡皮筋；松手 180ms
  弹回（`touchFeedback: false` 关）。位移写进 stage 的 `--md2s-swipe-x/y`（参与 transform，
  按 1/scale 反向换算，所以缩放状态下视觉位移仍等于指头位移）。
- 容器 `touch-action` 默认 `pinch-zoom`：**单指平移归手势层、双指缩放仍是浏览器的**
  （投影时想放大看清细节不能用不了）。`touchAction: "none"` 可彻底交给手势层。
  宿主开关：`touch: false` 整个不接，`touchTarget` / `touchDistance` / `touchTimeout` /
  `touchMouse` / `touchFeedback` / `touchIgnore` 细调。
- **导出件独立放映器（`tools/export-html.js`）也支持滑动**：左/上滑下一页、右/下滑上一页，
  同样带双指落地撒手、40px 门槛、斜划不触发的护栏。
- 回归：`tools/smoke.js` 新增「触屏手势：左右翻页 / 上下步进，与键盘同一语义」（jsdom 里
  合成 touch 序列，含抖动 / 斜划 / 双指三条护栏与 `touch:false`），`e2e/entry.js` 的页内
  探针新增 PointerEvent 真手势用例（真浏览器才有 PointerEvent）。

## [Unreleased] — 放映控制条导出 PPTX 按钮

### Added

- **放映控制条「导出 PPTX / 导出可编辑 PPTX」按钮**（host/typora/shell.js + 新模块 export.js）：
  退出键旁新增两个按钮，复用直播 iframe 的 deck（`deck.ir()` 抽 IR + 闸门、`deck.exportImages()`
  逐页栅格），不再重渲染、不依赖第二个 Chromium。图片型走 pptxgenjs（零 Python）；可编辑型走
  IR + Python sidecar（需 python-pptx）。导出后端（pptxgenjs 依赖闭包 + sidecar/*.py）随
  build-host 打进插件 lib/，install 一并部署；导出目标默认落在 md 同目录 `<名>.pptx` /
  `<名>.editable.pptx`。

### Fixed

- **主题 `python-mini-pptx`：行内 `<code>` 字号不再压扁标题**。原 `code { font-size: 38px }`
  是固定像素，标题（h2=84px 等）里的行内代码只有标题一半不到（`二、<code>compareTo</code>
  是什么` 里 compareTo 显小）。改为 `font-size: 0.9em`：正文里仍 ≈38px（贴合原"正文-2pt"意图），
  标题里随 h1~h6 同比放大；`pre > code` 已是 `1em` 不受影响。
- **图片型导出不再带 exec 运行/重放按钮**。deck-entry.js 的 `exportImages()` 栅格时
  临时注入 `[data-md2s-activatable]{display:none!important}`，隐藏代码块角落的 `▶/⏩`
  按钮（可编辑型走 IR 抽取，本就不过这些 UI）。
- **放映运行结果面板不再盖住代码（自适应布局 + 变量回显过滤）**（host/typora/exec-bridge.js）。
  - 结果面板从"浮层大盒子"改为**底部停靠条**；运行时给当前 `section.md2s-current`
    加 `padding-bottom = 控制台高度`，section 是 flex column + `justify-content:safe center`，
    内容便在"控制台之上"重新居中——既不盖代码、也不顶部对齐。
  - 内容 + 控制台在整页**放不开**（`sec.scrollHeight - sec.clientHeight > 2`）时
    自动切**左右分栏**（控制台贴右半屏、内容留左半），头栏新增 `⇆` 可手动切换，默认自动。
  - 渲染层过滤 JShell 变量声明回显（`s1 ==> "apple"` 这类），只留真正的程序输出（如 `-1`）；
    纯展示层过滤、不动 mdcode2run 引擎，不丢底层日志。

## [Unreleased] — 放映配置重构（用户设计评审：show × page）

### Changed

- **front-matter `mode` 键撤销，换成正交两键**（`mode` 昨日刚加、未发布，零包袱）：
  `show: page | element`（显示形态：整页全显 / 渐进揭示，默认 page）与
  `page: true | false`（仅 show=page 有意义：true 默认=逐元素游走 / false 纯整页翻）。
  默认组合 = `show: page; page: true`——整页全显、翻页笔逐元素游走、走到 ▶ 按 Enter
  运行，正是课堂最常用形态。决策收进 `resolveGranularity`（shell.js 导出，
  文档级 > config.json SHOW/PAGE > 引擎缺省；MODE 旧键兼容读取）。
- **播放器两形态 + browse 开关**（`kit/player.js`）："slide" 更名为 "page"；
  page+browse 步进只动高亮（`md2s-step-current`，`md2s-browse` 上默认黄红色描边 + 黄里透黄暖光辉（柔光晕），
  描边/光晕按 1/scale 反向放大所以投影下也明显，主题可覆盖），**不隐藏任何内容**；
  element 揭示语义不变（hidden 只在 element 加）。
  键盘三分支：步进形态（element/page+browse）共用 ↓/空格/PgDn 步进 + ↑/PgUp 回退 +
  ←→ 翻页 + Enter 当前步；纯翻页形态方向键全翻页 + Enter 页内第一个。
  `activate()` 在步进形态命中当前步、纯翻页命中页内第一个。
- **`"slide"` 留作旧键别名**（= page + browse:false）：e2e/既有调用方行为不变；
  types/API.md 记录为遗留。
- config.json `MODE` → `SHOW` + `PAGE`；deck-entry 透传 browse。

## [Unreleased] — 逐元素放映三件套：front-matter 粒度键 + 翻页笔步进 + ▶ 独立步

### Added

- **front-matter `mode` 键**（`core/parse/frontMatter.js` deckMeta）：`slide`（默认）/
  `element` 逐元素循序渐进——文档级声明优先于壳 config.json 的 `MODE` 全局缺省
  （shell.js 接线：`deck.meta.mode` 合法值才采纳）。讲义从此可以自带放映粒度。
- **▶ 运行按钮成为独立步**（`kit/steps.js`）：`[data-md2s-activatable]` 元素各成一步，
  附在所属块最后一步之后——element 模式逐元素翻完代码块再翻一下"落到"按钮上
  （`md2s-step-current` 高亮，样式归宿主/主题；exec-bridge 已配青色描边），Enter 运行。
  翻页笔逐元素可达性自此闭环。
- **`refreshSteps()`**（`kit/player.js`，types 同步）：宿主装饰页 DOM 后重建步进表——
  懒构建的表（尤其当前页）不含装饰后新增的步元素。shell.js 在 exec 装饰后调用。

### Changed

- **键盘映射修订（2026-10-26，用户拍板）**：element 模式下 PgDn/PgUp 从"恒为翻页"
  并入步进（与 ↓/空格、↑ 同义，步尽才翻页）——主流翻页笔的"下一页"键发 PageDown，
  此前映射让笔无法逐元素讲；←→ 保留纯跳页。文档四处同步（player.js 文件头 / API.md
  §2.7 键表 / USAGE §3.1 / 生态 FRONT-MATTER.md）。

## [Unreleased] — 主题体系：结构/皮肤分家（用户拍板 B）

### Changed

- **base.css 瘦身为纯结构骨架（零视觉）**：只留引擎运行契约——画布/flex 页容器/
  分页测量的间距口径（margin-top 抹平、首末贴边）、家具结构位、markdown-it 产物的
  :where 兜底。颜色/字体/字号/边框/背景一概不写。根因：base 曾同时扮演"结构契约 +
  视觉基底"，其 `section th/pre/p…`（0,0,2）持续压死主题裸选择器（0,0,1）——表头、
  代码块字体、行内代码三轮失真后彻底分家，主题层从此只有一个人的意志。
- **python_mini_pptx 成为完整自足皮肤**：补入标题基底（weight/line-height）、嵌套
  列表、hr 留白、关键词 mark（与 strong 同款）。主题真意全面生效——h1 104px、
  行内代码 38px、Cascadia Mono 代码块等首次真正上屏（此前被 base 压成 75.6px 等）。
- **删除 python_mini_theme.css**：零代码引用的闲置主题（默认主题一直是 pptx 版）。

### Fixed

- **host-test 夹具校准**：makeMd 的无空格中文长串（"内容"×60）在主题真意字号下
  触发浏览器折行怪癖（一行仅 ~9 字），曾致 134 页病态细切与 2 页 IR 越界（分家轮
  对照实验实锤：同长度带标点文本即正常）。夹具段落改为真实中文形态（带标点）。
  真实讲义无此类内容，非产品 bug；分页器对无空格长串的行为留观（标本上 8 条
  "段落过高"诊断同族，见 ROADMAP）。

## [Unreleased] — P1b：放映执行桥接（mdcode2run 引擎接入）

### Added

- **exec-bridge**（`host/typora/exec-bridge.js`，宿主层——依赖箭头宿主→引擎）：deck
  就绪后装饰 iframe——可跑的代码块注入 ▶（`data-md2s-activatable`，P4-a 契约）与 ⏩
  （仅章会话块），分页切片自动还原成源码整块再定位；点击调 mdcode2run 引擎
  `run/replay`，流式输出 + 结构化结果（表格/图/文本/会话 HUD）落在 iframe 内的结果
  浮层，Enter/Esc/✕ 关闭且不惊动播放器键盘；作业块支持计时 + 树杀终止。引擎四级
  回退解析（`config.EXEC_ENGINE_PATH` → 部署副本 `engine/` → node_modules → 生态
  兄弟目录），全部失败静默降级为无 ▶（不破坏纯呈现场景）。shell.js 接线（deck 就绪
  即装饰，stop 时 dispose 全部常驻会话；引擎按文档路径缓存，跨放映存活）；install.js
  把引擎拷成部署副本（可选件，源缺失跳过）。

## [Unreleased] — 放映执行承接面：可激活元素契约 + 播放器交接

### Added

- **可激活元素契约**（`kit/player.js`，文档 §2.7）：页内元素标 `data-md2s-activatable`
  （click 与样式归宿主），`Enter` / 新增 `activate()` 触发其 click——element 模式命中
  当前步上的第一个、slide 模式当前页的第一个，无可命中目标时 Enter 原样放行不吞键。
  放映中跑代码块的通用接入点（与代码执行引擎 mdcode2run 的桥接面）。Enter 此前在两种
  模式的键盘表里均未占用，本变更无破坏。
- **`deck.run()` 返回值带出活的 `player` 句柄**（`host/typora/deck-entry.js`）：
  run() resolve 即"deck 就绪"（分页收敛、补染、播放器全就位），装饰器从此刻起可动手，
  不另立事件。同源调用方（Typora 壳经 contentWindow）拿到真引用；序列化通道请用
  `getPlayer()`。

## [Unreleased] — P3-c：无框架注入 + 编辑区图表渲染（Typora 壳重建终点）

### Added

- **实锤并绕开"Typora 插件框架"真相**（`docs/design/integration-typora.md`）：旧壳依赖的
  BasePlugin / `this.utils` / settings toml / hotkeyHub 全是 obgnail/typora_plugin 的
  框架，原生 Typora 零引用——干净 Typora 上文件夹插件没有加载入口。obgnail 自己的安装
  方式（改 window.html 插一行 script）成为唯一样板。
- **window.html 幂等 patch**（`install/patch-window.js`）：在 frame.js 的 script 标签后
  插入标记注释包裹的加载行；不备份文件，卸载精确摘除、逐字节还原（幂等性有单测；
  与 obgnail 各行其道）。Typora 升级重写 window.html → 重跑 install 恢复。
- **无框架壳**：`index.js`（window.html 加载的引导：等 File 全局 → 读 config.json →
  `reqnode(shell.js).createShell(env).start()`）+ `shell.js`（壳本体工厂：自管生命周期 /
  config.json 配置 / window keydown 自匹配热键 / 自插 overlay 样式 / `window.md2slides`
  调试面）+ `config.json`（HOTKEY / MODE / CONT_MARKER / EDITOR_LANGS / GRAPHVIZ_DOT /
  PLANTUML_JAR / PLANTUML_JAVA / ECHARTS_THEME）。**已装进本机 Typora**（与 obgnail 共存）。
- **`editrender.js` 编辑区图表渲染器（P3-c1）**：不装任何第三方插件，Typora 编辑区
  直接显示 dot / plantuml / echarts。AOP afterCall 挂原生 `fences.addCodeBlock` /
  `diagrams.updateDiagram` + MutationObserver 兜底 + CodeMirror `change` 防抖；
  dot → `spawn dot -Tsvg`，plantuml → `spawn java -jar plantuml.jar -tsvg -pipe`
  （Java 11+ 挑选同 host/thin），echarts → `<script>` 懒加载 canvas；产出落原生
  `#componenet` 的 `.md-diagram-panel` 模板 + `md-fences-advanced` class（原生 CSS
  藏代码显面板），deck 侧 harvest 直接收——编辑器里看到什么 deck 里放什么。
- **让位（P3-c2）**：围栏里已有别人的渲染产出（obgnail 画了）则跳过不抢；
  hash 闸（lang + 内容）防 observer 高频重画；渲染失败进 `.md-diagram-panel-error`，
  不炸编辑器。

### Changed

- `bridge.js` 重写为**纯原生触点**：`File.filePath` / `document.querySelector("content")`
  滚动 / `#write .md-fences` 枚举 / `updateDiagram` 触发；删掉全部 `this.utils` 与
  obgnail 第三方 parser 分支（`renderPendingDiagrams` 只催原生认得的图）。
- `install/install.js` 重写：校验锚点从 `plugin/global`（obgnail 专属）改为 `window.html`；
  三步 = build-host → 拷壳（加 shell/editrender/config/version）→ patch window.html；
  删 toml 默认段注入（`md2slides.defaults.toml` 删除）。
- `tools/build-host.js`：额外产 `version.json`（壳版本戳，install 带进插件目录）。
- `tools/host-test.js`：18 → 25 项——shell 工厂（start/stop、热键、window.md2slides）、
  prepareDeck 全链路、**入口自举**（假 preload 全局下 eval index.js 整条引导链，
  抓住一个真 bug：漏了 `createShell(env)` 一层）、editrender 五项（真渲染挂面板 /
  hash 闸 / 内容变化重画 / lang 改写拆面板 / 失败 error 面板 / 让位 / echarts canvas）、
  patch-window 幂等与逐字节还原。

## [Unreleased] — P3-b2：mermaid/echarts 浏览器侧兜底（defer 到页面侧预通行）

### Added

- **P3-b2 完成图表三级策略的最后一层**：mermaid / echarts 是浏览器运行时，父侧
  （DOMParser 文档，没有布局）画不了——`deck.js` 的钩子对这类无 panel 的块返回
  `{defer: true}`，块原样进 srcdoc，由 iframe 里的 `deck-entry` 在分页实测**之前**
  做页面侧预通行（`renderDiagrams` only BROWSER_TYPES + `assertDiagramsRendered`），
  用 `host/browser/` 的真渲染器画完照样过闸门——铁律（图表必须真渲染）不破。
- **`host/browser/`（图表渲染渠道归 host 的落点）**：mermaidHost / echartsHost /
  分派器从 e2e 搬来并**共用**——e2e 下的三个同名文件留转发 shim，require 面不变。
  壳与回归同一份渲染器实现，杜绝「预览/导出/回归」三处漂移。
- `deck.js`：按 defer 到的类型把 `mermaid.min.js`（5.5M）/ `echarts.min.js`（1.1M）
  **按需内联**进 srcdoc（排在 hljs / html-to-image 之后、deck-page 之前）——纯文本文档
  的 srcdoc 不为它们变胖；返回值加 `deferredTypes`。

### Changed

- `core/render/diagramHost.js`：`renderDiagrams` 的钩子可返回 `{defer: true}`（块级
  "留给下一遍"），返回值的 `pending` 字段从此有真值（被 defer 的类型，去重）——
  补完文档里一直空着的字段；`only` 语义不变，e2e 两遍式流程不受影响。
- `e2e/bundle.js`：默认打包范围加 `host/browser/`（shim 的 require 要能解析）。
- `tools/build-host.js`：page bundle 的 roots 加 `host/browser`；ASSETS 加两个库
  （install 时进插件 lib/，deck.js 从那儿读来内联）。
- `tools/check-deps.js`：默认检查范围加 `host/browser/`。
- `tools/host-test.js`：15 → 18 项——defer 语义单测（core）、srcdoc 条件内联、
  混合文档三路并发（harvest + 兜底 + defer）、**真浏览器渲染 mermaid/echarts**
  （围栏零残留、位图真尺寸、IR 闸门 + media 收图）、渲染失败 run() 硬失败。

## [Unreleased] — P3-b1：Typora 宿主壳图表接线（harvest + 兜底）

### Added

- **图表三级策略**（用户 2026-10-25 拍板，`host/typora/diagram.js` + `deck.js`）：
  ① Typora（含 obgnail/typora_plugin 等第三方渲染器）画出了 panel → harvest 栅格成 PNG
  塞回 deck；② 没 panel（Typora 画不出）→ md2slides 自带渲染器兜底——graphviz/plantuml
  经 bundle 的 `hostRenderers`（host/thin）在父侧直接跑；③ 都没有 → DiagramError 硬失败
  （铁律不变）。editor/deck 分歧为接受项：Typora 画不出的图编辑器显示代码块、deck 显示
  真图，编辑器侧渲染支持由用户自行解决。
- **配对算法**：compose 图表块与 Typora `.md-fences` 按**文档序对齐 + 逐个 lang 校验**，
  数量/lang 漂移即硬失败（旧壳按 lang 分组消费会跨块错配——同类第 2 张配到第 1 张的 panel）。
- **`bridge.js` 图表触点**：`listDiagramFences`（文档序围栏 + panel 产出）、
  `renderPendingDiagrams`（三类渲染目标分派：第三方 `parser.renderDiagram` / 旧式组件 /
  内置 `updateDiagram(cid)`；懒加载围栏先 `addCodeBlock(cid)`；轮询到出图或超时，
  超时不失败——交兜底）。全部只读 + 触发，**绝不 monkey-patch**（obgnail 的框架也在
  patch Typora 内部对象，两边打补丁必冲突）。
- `node-entry.js` 壳专用出口：`DIAGRAM_TYPES` / `chartBlocksOf` / `rasterizeSvg` /
  `hostRenderers`（只服务宿主壳，不进库的公开 API 面）。

### Changed

- `deck.js`：P3-a 的 `p3aNoDiagrams` 永抛桩 → `makeRenderDiagram` 三级钩子；返回值加
  `diagramCount`。
- `tools/build-host.js`：node bundle 打包范围加 `host/thin`（兜底渲染器）。
- `tools/host-test.js`：9 → 15 项（配对/漂移/harvest 三通道/兜底分派/浏览器类型硬失败/
  bridge 假 env 围栏收集与渲染催动/RECOGNIZED_LANGS 漂移断言）。
- `host/typora/index.js`：开放映前先 `renderPendingDiagrams` 再建 deck（收割的是编辑器
  DOM 产出，没催过就收不到）。

## [Unreleased] — P3-a：Typora 宿主壳（仓库侧，未安装）

### Added

- **`host/typora/` Typora 宿主壳（P3-a 最小可跑版）**：热键进/退放映，compose +
  splitOverflow + kit 播放器全链路，图表与导出按计划砍掉（含图文档硬失败，不接受占位
  降级）。模块划分：`index.js`（壳）/ `bridge.js`（Typora API 触点集中营）/ `deck.js`
  （建 deck）/ `server.js`（本地 http：KaTeX 字体 + 本地图片，ACAO + 目录钉死）/
  `deck-entry.js`（iframe 内分页/补染/播放器/IR）/ `install/`（同步脚本，默认预演）。
- **`tools/build-host.js`**（`npm run build:host`）：基于 `e2e/bundle.js` 的静态模块图
  产两个自包含 bundle——`dist/node-bundle.js`（父侧，转发公开 API）与
  `dist/deck-page.js`（iframe 内，挂 `window.deck`），外加 `lib/` 运行时资产副本
  （markdown-it / katex / hljs / html-to-image / 主题 CSS）。插件目录不 vendored core、
  不软链仓库路径，从结构上杜绝旧壳的副本漂移。
- **`tools/host-test.js`**（`npm run host`）：宿主壳仓库侧测试 9 项——API 面、非仓库
  cwd 下 readFile 改道（防 katexCss/highlightCss/loadTheme 静默退化）、srcdoc 组装与
  图片改写、P3-a 含图硬失败、本地 http（字体/图片/穿越/ACAO）、bridge 假 env、index.js
  插件形状，以及**真浏览器端到端**（puppeteer + srcdoc iframe 跑 deck.run / 键盘 / IR 闸门）。

### Changed

- `e2e/bundle.js`：`buildBundle` / `bundleScript` 支持 `sourceRoots` 选项（默认不变），
  宿主壳把仓库根 `index.js` 纳入打包范围。
- `tools/check-deps.js`：默认检查范围加入 `host/typora/`；壳的 `dist/` `lib/` 生成物
  require 不到是正常的，显式跳过。
- `package.json`：`test` 链加入 `build:host` 与 `host`；新增 `build:host` / `host` 脚本。
- `.gitignore`：忽略 `host/typora/dist/` 与 `host/typora/lib/`（构建产物）。

## [Unreleased] — P0' 清理（marp 遗产出清）

### Removed

- `host/typora/index.js`（149 KB 旧 marp 插件壳，依赖早已断裂）、
  `host/typora/marp-core.min.js`（3.2 MB）、`host/typora/mermaid2dot.js`、
  `host/typora/deckButton.js`（事件源 plugin-marp-ppt-* 来自旧壳，随之失活）。
  Typora 壳按计划在 P3 从 `compose()` 重写，旧文件留在 git 历史里可考；
  `host/typora/diagram.js`（B 形态适配器）保留。
- `core/render/flatten.js`（`marp-pre` 专属，新引擎不产生该结构）、
  `core/split/splitHeadings.js`（已被 sectionize 取代）、
  `core/split/splitTables.js`（DOM 层 `overflow.js::splitTable` 经 e2e 验证兜得住）、
  `lib/js-yaml.js`（无人使用）。`splitSemicolons.js` 保留（TODO §3 倾向接线）。
- `core/section.js` 的 Marpit svg（`svg[data-marpit-svg]`）兼容分支、
  `overflow.js` / `ir.js` 里的 `MARP-H*` 自定义标签识别。

### Changed

- **续页标记类名 `plugin-marp-cont` → `md2s-cont`**，页眉路径标记
  `plugin-marp-heading-path` → `md2s-heading-path`，栅格标记
  `data-marp-ir-raster` → `data-md2s-raster`。直接依赖旧类名选择器的宿主需同步
  （公开 API 的 `CONT_CSS` / `CONT_CLASS` 常量不受影响，跟着常量走的宿主无感）。
- **`extractIr` / `checkIr` 的宿主 UI 豁免选择器改注入**：原写死的
  `[data-plugin-activatable]`（Typora 专属）改为 `opts.skipSelector`（core 默认空），
  `checkIr` 增加可选第三参。**编辑器宿主必须传**，否则插件 UI 会被当成丢字报进闸门。
- 渲染器大文件归位：`lib/mermaid.min.js`、`echarts.min.js`、`plantuml.jar`、
  `pptxgen.bundle.js` → `host/lib/`（宿主层 artifact，不进 npm 包）；`lib/` 只剩
  core 运行时依赖（markdown-it / plugins / katex / highlight / html-to-image）。
- `core/render/style.js` 只剩 `codeCss`（`withStyleBlock` / `withThemeMeta` 是
  marp 管线专属，无消费者，随壳删除）。
- `DEFAULT_FRONTMATTER` 去掉 `marp: true`（marp 的开关，自建引擎不读）。

### Added

- **源码行号**：每个内容块带 `srcRange: [起始行, 结束行]`（1 基含端点，围栏代码含
  ``` 两行），从 markdown 渲染层注入（`data-src-start/end`），随 DOM 穿过逻辑分页、
  物理分页（切分后的续块行号按切点收缩；图表换图、公式栅格都随块携带）、进 IR。
  列表条目级 `items[].srcRange` 同步提供。消费方：编辑器宿主的「点击幻灯片跳源码
  行」与将来的增量重排。schema / types / API.md 同步；IR 快照已验证纯增量
  （剔除 srcRange 后与旧基线逐字节一致）并刷新。e2e 新增行号闸门（+4 断言）。

### Added

- **播放器 `createDeckPlayer(root, opts)`**（`kit/player.js`，kit 层首个模块）：框架无关的
  一页一屏视图——缩放适配容器（ResizeObserver 自动 + `fit()` 手动）、键盘翻页（编辑框
  聚焦不抢键）、`onChange` 页码状态。职责边界：player 只管「怎么看」，翻页按钮 / 页码 UI /
  全屏归宿主；页 DOM 搬进自建 stage，`destroy` 原序还原。e2e 新增页内探针（接管 / 翻页 /
  键盘 / 钳住 / 还原，趁浏览器活着跑——page detach 后 evaluate 不可能）+ smoke 行为断言。

### Added

- **播放器逐元素步进**：`createDeckPlayer` 新增 `mode: "slide" | "element"`（全局配置，
  运行时 `setMode` 切换）。element 模式：↑↓ 逐步揭示、步尽溢出成翻页，←→ / PgUp PgDn
  恒为翻页，空格随 ↓。步进表由新模块 `kit/steps.js` 立法（粒度封闭表：列表逐项 /
  表格表头跟首行再逐行 / 分栏递归到栏内列表 / 其余整块一步；判块词汇 `isFixed`
  收编 overflow.js 唯一份）。揭示用 `visibility: hidden`（占位不显示）——版面冻结，
  垂直居中不随步进重排；累积显示，当前步 `md2s-step-current` / 已揭示
  `md2s-step-past` 默认无样式，开放给宿主/主题。图表扇区：`steppers` 钩子
  （`{match, create→{count,show,hide}}`，core 调度宿主执行，与 renderDiagram 同构），
  无钩子整块一步。步进是放映时行为，**IR 不动**（快照零漂移验证）；步进表可序列化
  （kind/srcRange/k），为将来「导出带动画的 PPTX」（IR v3 的 slide.steps）留了口。
  验证：smoke 88（+3 element 行为断言）、e2e 170（双模式页内探针）全绿。

### Added

- **一键导出 PPTX：`node tools/export.js deck.md -o deck.pptx`**（面向不想敲命令的
  普通用户；也是 Typora 导出面板自定义命令 / marktext 菜单项的挂载点）。
  图片型默认：整页真屏栅格 + pptxgenjs 铺满（devDependency `pptxgenjs`，零 Python，
  与放映逐像素一致）；`--editable` 走 IR + Python sidecar。进度输出、人话错误
  （`ExportError`：PYTHON_MISSING / IR_GATE / TARGET_BUSY / SIDECAR_FAILED）、
  临时文件原子写。管线层：e2e/runner 抽出 `injectRuntime` / `settleDeck` 共享段，
  导出与回归同一条管线——预览什么样，导出就什么样。
  双通道手动验证（demo 9 页：图片型 771KB / 可编辑型 44KB，dump_pptx 几何零问题）；
  图片通道的自动回归进 TODO。

### Added

- **续页表头内容比对**：`splitTable` 给续页表打 `md2s-table-cont` 标记，e2e 新增闸门
  「续页表头内容与首页一致（逐字）」——此前只验 thead 存在，克隆错内容不报。
- **成品形状重叠检测**：dump_pptx.py 逐页两两比对形状矩形（交叠 > 0.02 in² 且超过
  较小形状 2% 即报），e2e 新增闸门——「微软 Office 里叠字」一类破版的亡羊补牢。

### Removed

- **页码死代码链**（`chrome.pageNumber`，恒为 null 从未生效）：ir.js `pageNumberOf`
  （读主题 `section::after` 伪元素——两个主题从未设过 content）、schema 的 `chrome`
  字段、design_token 的 `pageNumber` token 与 `sldnum_box`、fill_deck 的
  `_add_page_number`（slidenum 域写框）。真页码由 furniture 以真实文本块走
  IR paragraph 通道，已是唯一正解。IR 基线已刷新（全部快照剔除该字段）；
  读取 `chrome.pageNumber` 的消费者（如有）受影响——该字段自发布以来恒为 null。

### Added

- **分号转列表接线**（`core/split/splitSemicolons.js`，2026-10-25 拍板）：「A；B；C。」
  分号并列段落自动转成无序列表，并列短语得以按项切分/按项步进。默认开；
  front-matter `semicolons: false` 或 compose `opts.semicolons: false` 关闭。
  护栏（不满足保持段落）：全角分号、短语无句读逗号且 ≤15 字、末段句号收尾、
  中间短语无句末标点、围栏/标题/列表跳过、引导冒号拆出单独成段。
  `ComposeResult.semicolons` 返回命中段落数。夹具 e2e/fixtures/semicolons.md
  （12 项长清单按项分页 + 护栏样例），smoke +3、新夹具 43 项全过。

### Docs

- 文档瘦身，只留核心：README 重写为薄手册（快速开始 / 库使用 / 分页原理 / 架构铁律 /
  已知坑），TODO 只留未完成项，PAGINATION.md（分页原理，人话版）升为根目录核心文档。
  IR_v3 蓝图与 marktext 集成设计移入 `docs/design/`；被删内容的完整原文见 git 历史
  v0.1.0 标签之前。代码注释里失准的「README 第 N 行」引用改为规则自述或指向
  PAGINATION.md 章节。

### 验证

- `npm run check`（31 文件）+ `npm run smoke`（81 项）+ `npm run e2e`（158 项）全绿；
  **IR 快照五份 deep-equal 零漂移**——纯清理未改变任何分页与几何行为。

## [0.1.0] - 2026-10-24

首个带**公开 API 面**的基线（此前为引擎仓库，无对外入口）。

### Added

- `index.js` 公开 API 面：`compose` / `renderDiagrams` / `splitOverflow` /
  `highlightCode` / `extractIr` 五入口 + `checkIr` 验收闸门 + 页容器契约辅助
  （`sectionsOf` / `SLIDE_SELECTOR` / `beginMeasure` / `endMeasure`）+ 契约常量
  （`DiagramError` / `IR_VERSION` / `CONT_CSS` / `CONT_CLASS` / `DECK_DEFAULTS`）。
- `docs/API.md`：入口签名、运行环境矩阵、时序铁律、宿主钩子契约、版本与兼容承诺
  （**IR v1 契约自此冻结**，v3 落地时按 `version` 分流）。
- `docs/integration-marktext.md`：纸面消费者——marktext 幻灯片视图的完整调用序列，
  作为 API 面的验收用例（含已识别缺口与归属）。
- `types/index.d.ts` TypeScript 类型草案。
- IR 快照回归：`e2e/snapshots/*.ir.json` 入库 + `tools/ir-snapshot.js`
  （`npm run snapshot` 比对 / `npm run snapshot:update` 刷新基线）。IR v1 已是确定性的
  （同输入同环境两遍 deep-equal），逐字段 diff 即回归，不用等 IR_v3 P2 的 freeze 哈希链；
  基线是生成机器的字体度量下的产物，换环境先 `--update` 重建。
- CI（`.github/workflows/ci.yml`）：offline（check + smoke）与 e2e（物理分页 + IR +
  PPTX + 快照比对）两道；e2e 因 CI 字体度量与开发机不同暂设 `continue-on-error`，
  钉字体后转硬性。
- `LICENSE`（MIT）、本更新日志。

### Changed

- `package.json`：去掉 `private`；补 `main` / `exports` / `types` / `files` / `license`
  与 `snapshot` / `snapshot:update` 两个 script。npm 包 `files` 剔除宿主专属大文件
  （mermaid / echarts / plantuml.jar / pptxgen——归位动作见 TODO P0'）。

### Fixed

- `.gitignore` 例外放行 `examples/demo.md`：它是 e2e 的默认回归输入，此前随
  `/examples/` 整体被忽略——新克隆（含 CI）上 `npm run e2e` 会直接找不到文件。

### 语义

- 0.x 阶段：次版本 = 新增 / 不破坏；破坏性变更升次版本并在本文标注。
- 子路径 require（`md2slides/core/…`，带 `.js` 后缀）可用但**无兼容承诺**。
