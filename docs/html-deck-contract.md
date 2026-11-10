# 文览「映」· HTML 放映稿契约 v1

> **Wenlan HTML Deck Contract / v1**
> 状态：**条款已裁决（2026-11-10），实现尚未按本契约改造**
> 裁决：R1 版本声明保留硬要求；**R8 改为「禁止自动播放动画，但允许绑定步进的动画」**；
> 下一步先落地校验与拒绝。
> 适用范围：任何希望在 md2slides 播放器（`kit/player.js`）中放映的**外部 HTML 文稿**，
> 以及任何实现该契约的宿主（文览「映/览」叶、Typora 宿主、导出工具、离线查看器）。
>
> 本契约是**引擎级**协议，不是某个宿主的特性说明。宿主实现见
> `wenlan/docs/design/html-slide.md`。

---

## 0. 为什么要有契约

md2slides 的播放管线是「**文稿提供内容与版式，宿主独占播放行为**」：
`compose()` 产出 `section[data-slide]`，`createDeckPlayer()` 接管翻页、缩放、步进、
键盘/触屏/翻页笔、可见性。播放器把每一页 `appendChild` 进自己的 `.md2s-stage`，
并用 `--md2s-scale` 把固定画布缩放到窗口。

外部 HTML 想接进这条管线，只有两种可能：

1. **遵守管线**：文稿只交出「页 + 版式」，播放行为交给宿主；
2. **自带播放器**：文稿自己管翻页/缩放/动画。

**第 2 种在架构上不成立**：两套播放器的可见性规则、坐标系、焦点与键盘监听必然互相覆盖；
且宿主出于安全用 `innerHTML` 注入，`<script>` 根本不执行。任何"让它俩共存"的兼容层
都是掩盖问题，不是解决问题。

因此本契约采取明确立场：

> **契约是硬的。不合规的文稿，宿主应精确指出违反哪一条、在哪里、怎么改，然后拒绝放映；
> 不猜测、不自动包装、不降级为单页、不做"尽力而为"的兼容。**

这一条是全部原则的地基。允许降级的契约，等于没有契约——三个月后就会攒出一层谁也
不敢删的启发式代码，且作者永远学不到正确写法。

---

## 1. 设计原则

| # | 原则 | 陈述 | 理由 |
|---|---|---|---|
| **P1** | **单一职责** | 文稿 = 内容 + 版式；翻页 / 缩放 / 步进 / 可见性 / 输入设备归宿主独占 | 两套播放器必然争抢 `display`、坐标系与键盘 |
| **P2** | **声明式** | 文稿是纯 HTML + CSS 的静态描述，**没有行为** | 宿主 `innerHTML` 注入不执行脚本；允许脚本只会制造"以为能跑"的假象，且是注入面 |
| **P2′** | **时机归宿主** | 文稿可以声明「演什么」，**不能声明「何时演」**；动画触发时机属于播放行为，由宿主按步进/翻页驱动 | 自启动画与翻页、步进、截图导出不同步；把时机交给文稿等于让文稿半个播放器（违反 P1） |
| **P3** | **唯一权威标记** | `section[data-slide]` 是唯一分页契约，`#deck` 是唯一根 | `class="slide"` / `is-active` / 自定义 `data-*` 另立分页 → 出现两套真源 |
| **P4** | **单一画布** | 全篇一个固定设计画布，所有页同尺寸；缩放只发生一次（宿主） | 页内二次 `scale()` 与 `--md2s-scale` 相乘，几何 / 步进高亮 / PPTX 导出全错 |
| **P5** | **自包含** | 无外链、无 CDN、无网络依赖；资源内联或相对同目录 | 离线可放映、可归档、可搬运；宿主资源白名单只放行文稿所在目录 |
| **P6** | **静态确定性** | 同一文稿在**同一播放进度**下渲染结果一致；不带自动播放、计时器、随机数、视口依赖 | 自主动画 / 计时器会与翻页、步进、截图导出不同步 |
| **P7** | **可验证、不妥协** | 机器可校验；违规即结构化拒绝 | 见 §0 |
| **P8** | **版本化、可扩展** | 显式声明契约版本；扩展靠新增**可选**属性，不改既有语义 | 让契约能长期演进，宿主可多版本共存 |

---

## 2. 宿主摄取模型（Ingestion Model）

这是"通用"的关键：明确定义宿主**读什么、丢什么**，而不是把整篇 HTML 一股脑塞进 DOM。

```
字符串(完整 HTML 文件)
   │
   ├─① DOMParser 解析为独立文档（外壳 <!DOCTYPE>/<html>/<head>/<body> 不承载语义）
   ├─② 校验（§4）—— 有任何 MUST 违反 ⇒ 拒绝，不进入 ③
   ├─③ 提取有效载荷：
   │      · 唯一 <div id="deck"> 子树
   │      · 文档中全部 <style> 节点（head 内或 deck 内均可，按原顺序）
   ├─④ 丢弃其余一切（<title>/<meta>/<link>/其他容器/注释）
   ├─⑤ importNode 注入宿主 iframe 的 #deck → rewriteImages → waitForDeckImages
   │                                     → deckCore.run({ skipBuild:true })
   └─⑥ 播放进度驱动：宿主按 §4.1 在「页进入 / 步成为当前」时切换 .md2s-anim-play
```

要点：

- **文稿必须是完整、可独立打开的 HTML 文档**，`#deck` 是其中**唯一**有效载荷。
  这样文稿本身在浏览器里双击也能看（静态全页堆叠），便于作者调试。
- 宿主**不**把 `<html>/<head>/<body>` 当结构用，也**不**保留 `#deck` 之外的容器。
  作者不应依赖这些外壳承载任何语义（`<base>`、`<title>` 影响布局、`<meta viewport>` 等一律无效）。
- `<meta name="wenlan-deck:*">` 是**唯一**例外：宿主在 ① 之前从字符串里解析配置（§5），
  因为 `<meta>` 被注入后不再具备文档级语义。
- 提取后，每一页都是宿主 `#deck` 的直接子元素 —— **文稿结构 == 放映结构**，一一对应。

---

## 3. 形式化结构

```ebnf
deck-document = doctype?, html-open?, head?, body-open?, deck, body-close?, html-close? ;
deck          = <div id="deck" data-wenlan-deck="1">, style*, section+, </div> ;
section       = <section data-slide [可选属性]>, content, </section> ;
content       = 任意静态 HTML/CSS（无行为、无外链、无二次缩放，见 §4） ;
```

- `section+`：**至少 1 页**，0 页是违规（不是"自动包一页"的理由）。
- `style*`：0..n 个 `<style>` 块，允许放在 `<head>` 或 `#deck` 内。
- 所有 `section` 必须是 `#deck` 的**直接子元素**（不允许嵌套分页）。

### 最小合规样例

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="wenlan-deck:canvas" content="1920x1080">
<style>
  section[data-slide] { padding: 96px 120px; font: 42px/1.6 system-ui, sans-serif; }
  h1 { font-size: 88px; margin: 0 0 48px; }
</style>
</head>
<body>
<div id="deck" data-wenlan-deck="1">
  <section data-slide data-md2s-title="封面">
    <h1>标题</h1>
    <p>副标题</p>
  </section>
  <section data-slide data-md2s-title="要点">
    <h1>三个要点</h1>
    <ul><li>一</li><li>二</li><li>三</li></ul>
  </section>
</div>
</body>
</html>
```

注意样例里**没有**给 `section` 写 `width/height`：画布尺寸由宿主按 §5 统一钉死，
作者只负责页内布局。也**没有**任何翻页按钮、脚本、`is-active` 类。

---

## 4. 规则表（可机器校验）

级别：**MUST** 违反即拒绝；**SHOULD** 警告但可放映；**MUST NOT** 同 MUST。

| ID | 级别 | 规则 | 检测方式 |
|---|---|---|---|
| **R1** | MUST | 存在且仅存在一个 `<div id="deck">`，并带 `data-wenlan-deck="1"` | `querySelectorAll('#deck').length === 1` + 属性值 |
| **R2** | MUST | `#deck` 下有 ≥1 个 `section[data-slide]`，且**全部**为其直接子元素 | 子节点过滤 + 全文档 `section[data-slide]` 计数比对 |
| **R3** | MUST NOT | 出现 `<script>` / `on*` 事件属性 / `javascript:` URL / `<iframe>` / `<object>` / `<embed>` | DOM 扫描 + 属性正则 |
| **R4** | MUST NOT | 出现自带播放器机制：`#stage`、`.is-active`、以 `class="slide"` 充当分页、`hashchange`/键盘导航残留、`<style>` 里给 `section[data-slide]` 写 `display:none`/`visibility` 规则 | 选择器/类名/属性/CSS 规则扫描 |
| **R5** | MUST NOT | 外链资源：`<link rel=stylesheet\|preload\|...>`、`@import`、`url(http…)`、`<script src>`、`<img src=http…>` | DOM 属性 + CSS 文本扫描 |
| **R6** | MUST | 全篇一个画布尺寸（§5）；页上不得写与之冲突的 `width`/`height` 内联样式 | 读 `<meta>` + 比对各页内联尺寸 |
| **R7** | MUST NOT | 页内二次缩放：`transform: scale(…)`、`zoom`、`vw`/`vh` 作为布局单位、`@media` 改布局 | CSS 文本 + 内联样式扫描 |
| **R8** | MUST NOT | **自动播放动画**：`animation` / `transition` 声明必须挂在宿主保留类 `.md2s-anim-play` 之下，且其元素带 `data-md2s-anim`（见 §4.1）；无限循环 `infinite` 一律禁止 | CSS 规则扫描 + 属性配对检查 |
| **R9** | MUST | 静态确定性：不依赖时间、随机数、网络、视口、系统主题的布局差异；**同一播放进度**下渲染一致 | CSS/属性扫描（同 R3/R5/R7/R8 覆盖） |
| **R10** | MUST | 作者私有 `data-*` 使用 `data-x-` / `data-author-` 前缀；**不得占用**保留字 `data-slide`、`data-pagination`、`data-md2s-*` | 属性名前缀检查 |
| **R11** | MUST | 图片/字体等资源为 `data:` URI 或**相对文稿所在目录**的路径 | `src`/`url()` 协议与路径检查 |
| **R12** | SHOULD | 每页提供 `data-md2s-title`（可选 `data-md2s-note`）用于大纲与演讲者备注；删除页上冗余的内联 `width/height` | 属性/内联样式检查 |

**保留字表**（宿主/引擎专用，作者不得另作他用）：
`data-slide`、`data-pagination`、`data-md2s-*`、类名 `md2s-*`、ID `deck`。

**可选契约属性**（v1 已定义，宿主可解释）：
`data-md2s-title`（页标题/大纲）、`data-md2s-note`（备注）、
`data-md2s-activatable`（该元素在当前步可按 Enter 触发 click —— 复用 `kit/player.js` 契约）、
`data-md2s-anim`（动画宿主触发标记，见 §4.1）。

> 步进**默认由 DOM 自动派生**（`kit/steps.js`：h1–h6/家具/封面为锚，每个顶层块 1 步，
> `ul/ol` 每 `li` 1 步，`table` = 整表 + 每行，`.cols>.col` 递归）。作者无需也不应
> 自建步进标记；需要交互时用 `data-md2s-activatable`。

### 4.1 绑定步进的动画（R8 的唯一合法形式）

> **裁决（2026-11-10）**：一刀切禁止动画过于僵硬——"逐幕推进"确实是讲义的有效表达。
> 但**动画的触发时机是播放行为，必须归宿主**（P1 / P2′）。故允许动画，前提是它
> **不能自己启动**，只能由宿主在「进入该页 / 该步成为当前」时触发。

**作者侧（声明"演什么"）**——三个约束，缺一不可：

1. 需要动画的元素带 `data-md2s-anim`（值任意，作分组名；同值元素同时触发）。
2. `@keyframes` 与 `animation` 声明必须写在**带 `.md2s-anim-play` 的选择器**下：

   ```css
   @keyframes fly { from { transform: translateX(0) } to { transform: translateX(400px) } }
   .pkt[data-md2s-anim].md2s-anim-play { animation: fly 1.15s ease-out both; }
   ```

   无 `.md2s-anim-play` 类时元素处于**未播放的静态终态**（`from` 帧），浏览器直接打开
   文稿也能看到完整版式——这正是 P6 的静态确定性。
3. **禁止** `animation-iteration-count: infinite`、`animation-direction: alternate` 配无限循环；
   禁止 `transition` 作为入场效果（`transition` 依赖属性变化，宿主无法声明式触发）。

**宿主侧（决定"何时演"）**——`kit/player.js` 在步进/翻页时切换保留类：

| 时机 | 宿主动作 |
|---|---|
| 页进入（成为当前页） | 给该页内 `[data-md2s-anim]` 元素加 `.md2s-anim-play`，触发动画 |
| 步成为当前步 | 给当前步所属元素（及 `step.extra`）内 `[data-md2s-anim]` 加类 |
| 离开该页 / 该步不再是当前 | 移除 `.md2s-anim-play`（复位到静态终态，便于回看时重播） |

- 同一元素重复触发由宿主负责复位（移除类 → 强制重排 → 重新加类），作者不写重置逻辑。
- **纯翻页形态**（`browse:false` / 旧 `slide` 键）只在页进入时触发；逐元素形态按步触发。
- **导出（IR / PPTX / 逐页栅格）恒取静态终态**：宿主导出前不推进播放进度，
  或统一移除 `.md2s-anim-play`，保证导出结果与"未播放"一致、可复现。

**为什么这样切分**：文稿是自包含、可独立打开的静态文档；放映进度是宿主状态。
把 `animation-play-state`/触发类交还作者，等于让文稿自己决定何时演 → 与播放器争抢
时机（P1），且浏览器里双击打开与放映里看到的不一致（P6）。

---

## 5. 画布与坐标系

- 默认画布 **1920 × 1080**（与 md2slides `compose()` 默认值一致）。
- 非默认尺寸**必须**在 `<head>` 声明：
  `<meta name="wenlan-deck:canvas" content="WIDTHxHEIGHT">`（`x` 或 `×` 均可）。
- 宿主在注入前从字符串解析该 meta，按 `W/H` 设置 `.md2s-stage` 尺寸并统一
  `section.style.width/height`；`fit()` 只做**一次**缩放（窗口 → 画布）。
- **作者不得在页内再建一套坐标系**（R7）。若原稿是 1280×720 设计，正确做法是按
  1920×1080 **重新排版**（把所有尺寸 ×1.5），而不是套一层 `transform:scale(1.5)`。
  后者会让播放器量到的几何、步进高亮框、IR/PPTX 导出全部按错误的坐标算。

---

## 6. 校验失败语义（不妥协的落地）

宿主在 ② 阶段跑 `validateHtmlDeck(source) → { ok, issues[] }`：

```ts
type Issue = {
  rule: string        // "R3" …
  severity: "error" | "warn"
  where: string       // "第 12 个 section" / "<script> at line 486" / "CSS .slide.is-active"
  message: string     // 人话：违反了什么
  fix: string         // 怎么改（可执行的具体动作）
}
```

- **有任何 `error` ⇒ 不放映**。宿主把全部 issues 汇总成 `md2s:error` 回传，
  工具条显示「文稿不符合 HTML 放映稿契约 v1」+ 逐条 `R# / where / message / fix`。
- **不注入、不包装、不降级、不猜测**。
- `warn`（SHOULD）随 `md2s:warn` 提示，但照常放映。
- 拒绝时给出**可复制的最小骨架**（§3 样例）与契约文档链接，让作者一次改对。

错误码建议：`E_NO_ROOT` / `E_NO_VERSION` / `E_UNSUPPORTED_VERSION` / `E_NO_SLIDES` /
`E_NESTED_SLIDES` / `E_SCRIPT` / `E_PLAYER_RESIDUE` / `E_EXTERNAL` /
`E_CANVAS_CONFLICT` / `E_NESTED_SCALE` / `E_AUTO_ANIM`（未挂 `.md2s-anim-play` 或
缺 `data-md2s-anim`）/ `E_NS_COLLISION`。

---

## 7. 安全边界（契约之外，宿主保证）

- 文稿在**跨源 iframe** 中渲染，宿主服务只放行文稿所在目录（`/f?p=` 白名单）。
- `<script>` 即使被注入也不执行（`innerHTML` 语义），契约仍**显式禁止**（R3），
  以免作者误以为可用。
- 不做 HTML 清洗后"尽力放映"：清洗会改变作者意图，与 P7 冲突。

---

## 8. 版本与演进

- `data-wenlan-deck="1"` 是**必需**的版本声明。无声明 = 不合规（不是"按 v1 猜"）。
- v2 若引入新能力（例如显式步进、章节元数据），以**新增可选属性**方式扩展；
  v1 文稿在 v2 宿主中必须照常放映。
- 宿主按版本号选择校验器；未知大版本明确报"契约版本不受支持"，不按最新版猜。

---

## 9. 对 `yarn-slides/` 三份文稿的裁决

三份是同一份 Hadoop YARN 讲义的三次迭代，恰好构成"不规范 → 半规范 → 接近规范"的样本。

| 文件 | 实质 | 违反条款 | 裁决 |
|---|---|---|---|
| `index.html` | 自带播放器的独立网页：`#stage` 1280×720、`.slide.is-active`、末尾 `<script>` 含 `go()`/`tick()`/`requestAnimationFrame`/hash 直达/audit 自检 | **R1**(根是 `#stage` 非 `#deck`)、**R2**(0 个 `data-slide`，19 个是 `class="slide"`)、**R3**(script)、**R4**(#stage/is-active/可见性规则)、**R7**(1280×720 舞台 scale) | **拒绝** |
| `deck.html` | 混合体：补了 19 个 `data-slide` + `#deck`，但整套旧播放器 CSS 原样保留；每页在 1920×1080 里再套一层 `1280×720 transform:scale(1.5)` | **R1**(无版本声明)、**R4**(`#stage`/`.slide{display:none}`/`.is-active` 残留)、**R7**(二次缩放)、**R8**(`.slide.is-active .anim` 自动入场，未挂 `.md2s-anim-play`)、**R10**(`data-chapter/title/note` 占私有名) | **拒绝**（"看起来能放"但几何/步进/导出必错） |
| `animation-deck.html` | 干净版：14 页 `section[data-slide]`、`#deck`、内联 1920×1080、无脚本无 `#stage` | **R1**(无版本声明)、**R8**(`.pkt{animation:yarnFly 1.15s both}` 自动播放)、**R10**(`data-frame` 等私有名)、**R12**(页内联 `width/height` 冗余) | **小改后合规**（动画按 §4.1 改挂 `.md2s-anim-play` 即可保留，无需删掉） |

### 迁移路径（按优先级）

1. **`index.html` 不是"改属性"能救的**：它自带一整套播放器，须按 §3 骨架**重新导出**——
   19 个 `.slide` → `section[data-slide]`，删掉 `<script>` 与 `#stage`/`.is-active` 全部 CSS，
   把 1280×720 版式按 1920×1080 重排（尺寸 ×1.5）。
2. **`deck.html`**：删 `#stage` 与整套 `.slide*` 规则；把页内 `scale(1.5)` 包装层去掉、
   内容按 1920×1080 重排；`.slide.is-active .anim` 入场动画按 §4.1 改挂
   `.md2s-anim-play` + `data-md2s-anim`；私有属性加 `data-x-` 前缀。
3. **`animation-deck.html`**：加 `data-wenlan-deck="1"` + canvas meta；
   `data-frame` → `data-x-frame`；`.pkt` 动画**不必删**——改成
   `.pkt[data-md2s-anim].md2s-anim-play{ animation: yarnFly 1.15s both }` 并给 `.pkt`
   加 `data-md2s-anim`（逐幕"一幕一页"由宿主在页进入时触发，与翻页同步）；
   删页上冗余内联尺寸，改由宿主钉死。

> 结论：**没有一份需要宿主写兼容代码**。三份都能靠"作者按契约改文稿"解决——
> 这正是立契约而非打补丁的价值。

---

## 10. 作者自检清单

- [ ] 有且仅有一个 `<div id="deck" data-wenlan-deck="1">`
- [ ] 每页是它的直接子元素 `<section data-slide>`，至少 1 页
- [ ] 全篇无 `<script>` / `on*` / `<link>` / `@import` / `http` 资源
- [ ] 全篇无 `#stage` / `is-active` / 自定义分页与可见性控制
- [ ] 全篇无 `transform:scale()` / `zoom` / `vw` / `vh` / 布局用 `@media`
- [ ] 动画（如有）全部挂在 `.md2s-anim-play` 下，元素带 `data-md2s-anim`，无 `infinite` 循环（§4.1）
- [ ] 未加 `.md2s-anim-play` 时浏览器直接打开文稿，每页仍是完整静态终态
- [ ] 画布：默认 1920×1080，或用 `<meta name="wenlan-deck:canvas">` 声明；页上不写死尺寸
- [ ] 私有属性用 `data-x-` 前缀；保留字未被占用
- [ ] 图片为 `data:` 或相对同目录路径
- [ ] 用浏览器直接打开该 HTML，静态看每一页版式正确

---

## 11. 实现状态（2026-11-10 已落地 ①–④）

用户裁决：**先落地校验与拒绝**。①–④ 已完成并回归通过；⑤⑥ 待办。

| 项 | 状态 | 落点 |
|---|---|---|
| ① 校验器 + 单测 | ✅ | `core/htmlDeck/validate.js`（R1–R12、`formatIssues`、同类违规聚合）；`test/unit/html-deck-validate.test.js` 23 例 |
| ② 宿主校验/结构化拒绝/删兜底/§2 摄取模型 | ✅ | `host/marktext/deck-full-entry.js::buildHtml`（DOMParser → `validateHtmlDeck` → 有 error 即 `md2s:error{stage:"validate",issues[]}` 并 return；只提取 `#deck` 子树 + 全部 `<style>` 后 `importNode`）；`wenlan/.../deckPane.vue` 结构化诊断列表 |
| ③ 播放器接 §4.1 播放进度触发 | ✅ | `kit/player.js`（`syncAnims` 按页进入/步成为当前切换 `.md2s-anim-play`，移除→重排→重加类可重播；`freezeAnims/unfreezeAnims` 供导出）；`host/browser/deck-core.js` 的 `showAllSlides` 与 `exportImages` 冻结；`test/unit/html-deck-anim.test.js` 7 例 |
| ④ 文档 | ✅ | 本文档 + `wenlan/docs/design/html-slide.md` |
| ⑤ 按 §9 迁移 `yarn-slides` 三份文稿 | ⬜ 待办（属用户素材，未改动） |
| ⑥ 真机 e2e 护栏 | ⬜ 待办（现有 e2e 已跑通，但无 HTML 契约专用 e2e） |

已删除的妥协实现：0 页自动包单页、渲染进程正则抠 `md2slides-canvas`、
给裸 section 兜底白底。保留 `kit/steps.js` 的 `if (!section) return []`
（引擎级防御，0 页时播放器不应崩）。

回归：md2slides 单测 53 pass / 1 skip、smoke 113、e2e 375；
wenlan `pnpm typecheck` ✅、全量单测 **1295 pass / 36 skip / 0 failed** ✅、
eslint 0 errors；`pack:marktext` + `sync-md2slides.mjs` 已重打同步。

> R1 保留硬要求（无 `data-wenlan-deck="1"` 即拒绝），不按 v1 猜测；
> R8 允许绑定步进的动画，但**触发时机仍归宿主**，文稿不得自启动画。
>
> **重要**：⑤ 未做 ⇒ 现有 `yarn-slides` 三份文稿现在点「映」会被**明确拒绝**并
> 列出逐条诊断（这是预期行为，不是 bug）。按 §9 改文稿即可，宿主不写兼容代码。

---

*本契约的立场：**规范先于兼容**。任何"让不规范的稿子也能凑合放"的提议，
请先回到 §0 讨论，而不是往宿主里加分支。*
