# IR v3 落地方案：表立法、量执法、freeze 终审

> 输入：《IR v3：十轮对话的裁决沉淀》（八条公理 + 四条新契约）
> 基线：本仓库现状（compose → overflow 实测分页 → ir.js 抽取 v1 → sidecar 出片）
> 性质：**不是加字段，是换责任位置**——几何从「ir.js 事后实测」挪到「布局表事前实例化」；
> IR 从「DOM 抽取产物」变成「规划器判决书」。主题 CSS、computed-style 抽取、sidecar、e2e 全部保留。

---

## 0. 结论先行

v3 相对现状的差异可以压成一张表：

| 维度 | 现状（v1） | v3 目标 |
|---|---|---|
| 几何真值 | ir.js 逐块 `getBoundingClientRect`，layout 是启发式猜测（`layoutOf` 按面积占比猜 two-col/table/code…） | 几何唯一定义于**布局表**，IR 携带本次实例化**终值 frame** |
| IR 身份 | DOM 的事后抽取产物 | 规划器的**判决书**（strategy + cells + 回写四口） |
| 渲染路径 | sidecar 直接摆绝对坐标块 | 渲染器只查表：布局 → 槽位 → kind，外加一个防御 error |
| 语义 | role/优先级散在逻辑里，无存档 | 语义收口在规划层，role/diag 只进 IR 供审计，**渲染路径禁读** |
| 容器语法 | `<!-- begin/split/end -->` 三注释（2026-10-24 落地，marktext 同族） | 已归一，七+一条降级规则与 marktext 一致 |
| 四栏 | README 写死「核心 1~4 的枚举布局」 | `minSlotWidth` 派生不变量，禁令随画布重新推导 |
| 预览 | Typora 壳走 marp svg 结构（待重写） | Tier 0 响应式流动 / Tier 1 冻结逐像素，同 DOM 双态 |

**不推倒的任何东西**：主题 CSS（槽内样式继续归它）、computed-style 逐元素实测（内容真值继续归它）、
Python sidecar 与模板通道（换坐标基准即可）、e2e 全套断言（从「验数字」升级到「验判决」）。

---

## 1. 现状盘点：v3 契约逐条对代码

| v3 契约 | 现状落点 | 差距 | 动作 |
|---|---|---|---|
| A1 几何入 IR（布局表实例化终值） | `core/render/theme.js` 画布 1920×1080；ir.js 逐块实测英寸 | 无布局表、无 frame 概念；layout 是猜的 | 新建 `core/plan/layouts.json` + 收敛循环 |
| A2 语义收口规划层 | `overflow.js::coreTypeOf` 就地判断核心/引导/结束 | 语义与分页耦合，无审计出口 | 语义前移进 BlockStore，IR 存 role/diag |
| A3 实测是选择器 | `splitSection`/`splitTable`/`splitCodeBlock` 直接改 DOM | 策略无 id、降级无记录 | 策略封闭集 + demoteFrom |
| A4 源码可流动、版面冻结 | 源码零改写已做到；预览/放映同一条 CSS | 无双态机制 | `md2s-preview` / `md2s-frozen` 双态 |
| A5 栏数声明值 + 几何定理 | 无显式栏数概念（靠 split 数推）；四栏无概念 | 无限定、无派生 | 词法层校验 + 定理派生布局集 |
| A6 同输入同 IR | 无 engine 字段；无快照回归 | 不可回归 | meta 三元组 + snapshot |
| A7 渲染器三种查表分支 | sidecar 按 type 摆块（`fill_deck.py`） | 分支里混着布局判断 | `core/render/fill.js` 参考实现 + 审计 |
| A8 回写四口封闭 | 高度/宽度散落各处，无回写概念 | 字段来源不可答 | 回写四口代码落点 + 审计 |

---

## 2. 我补的七条裁决（文档留白处，按项目现状收口）

### R1 块级几何去留：版面真值 vs 内容真值

v3 A8 说「其余一切高度 → planner 私有，freeze 前丢弃」。但本仓库的 sidecar **没有文本测量能力**
（python-pptx 量不了字），现行可编辑通道全靠 ir.js 逐块实测坐标保真；e2e 的「形状在画布内」断言也读块级 geo。
一刀切丢弃 = sidecar 退化成帧内布局引擎，保真度倒退。

**裁决**：把「高度」拆成两类，A8 只禁过程量：

| 类 | 内容 | 存放 | 真值源 |
|---|---|---|---|
| 版面几何 | slot 的 frame（x/y/w/h） | `deck.layouts[].slots[].frame` | **布局表**（A1） |
| 内容几何 | 块内行高、列宽、块在槽内的局部偏移 | `block.body`（与 computed style 同源实测） | 浏览器实测，属内容真值 |
| 过程量 | 测量轮次、页级预算、优先级分数、降级历史 | 不进 IR | planner 私有，freeze 前丢弃 |

配套规则：块级坐标改为**槽内局部坐标**（相对 `cell.slot` 的 frame 原点），freeze B 类校验
`frame ⊇ 块矩形`（含 ε）。这样版面真值只有一份（布局表），块坐标是它的实测实例化，不会双轨漂移。
sidecar 只加一次坐标换算（absolute = frame + local），`fill_deck.py` 主体不动。

### R2 栏数词汇由定理派生，布局表是数据不是枚举

`ManualBody.cols` 保持 `2 | 3`（手写声明收口，`4 ⇒ error` 不猜）；**自动布局集**由
`deriveLayouts(slideSize, invariants)` 从 `layouts.json` 派生。用本项目真实数字演示
（主题 `section` padding 84/72、gap 24，内容宽 = 画布 −168）：

| 画布 | 内容宽 | cols2 | cols3 | cols4 | grid2x2 每格 |
|---|---|---|---|---|---|
| 1280×720 | 1112 | 544 ✓ | 354 ✓ | **260 ✗ 违例** | 544 ✓ |
| 1920×1080（现行） | 1752 | 864 ✓ | 568 ✓ | **420 ✓ 合法** | 864 ✓ |

即：现行 1920 画布下 `cols4` 本来就应该合法，1280 主题下自动被禁——禁令随画布重新推导，
不需要任何人维护「四栏黑名单」。当前策略表四核仍走 grid2x2（四核并列信息密度低于 2×2），
`cols4` 进入布局集但暂无策略选用，留作画布/主题扩展位。

### R3 策略封闭集 ← README 决策树，一一映射

README「优先级决策树」升格为封闭策略词汇（`strategy` 字段 = 测试 oracle）：

| strategy id | 含义 | 现状来源 | demoteFrom |
|---|---|---|---|
| `manual` | 用户接管（slidebreak / 容器） | 决策树第 1 级；容器整冻结 | 不进降级链 |
| `lead-tail` | 引导/结束横贯，1~4 核整组 | 核心组整组布局 | `core-split` |
| `core-split` | 核 1/2/3/4+ → full/cols2/cols3/grid2x2 | 核心组分割 / 核心分割 | `greedy-flow` |
| `greedy-flow` | 文档流贪心装箱 | `splitSection` 主路径 | `degraded` |
| `derive` | 锚定 + 切片衍生（主核心不动，次核心按行/项切） | README 衍生型双核心 spec | `core-split` |
| `hybrid` | manual 块与 auto 块同页 | 现无显式策略（容器与正文混排） | — |
| `degraded` | 降级产物，附 `demoteFrom` | 现无记录 | — |

降级链：`cols3 → cols2 → full → fontScale → SLIDE_OVERFLOW error`（诚实交付）。
manual 块不进链：只报 `MANUAL_OVERFLOW` warn，改不改是用户与编辑器的事（README 原判）。

### R4 autofit / `fit.fontScale` 是降级链最后一环

现行 `overflow.js` 溢出只有切分一条路。v3 布局表声明 `autofit: ["body"]`（授权槽），
降级到 `full` 仍溢 → 在授权槽内步进 `fontScale ∈ [0.5, 1]`（B 类校验边界）→ 仍不行才
`SLIDE_OVERFLOW`。**优先级铁律不变：先切后缩**，autofit 只救济「切不动」的块（孤段、manual 尾部）。

### R5 UNSUPPORTED_HTML 分级收紧，不一次性翻脸

现 ir.js 对未知元素给 `unknown` block（宽松）。v3 要 error，但存量 examples/ 20 个文档没扫过。
**裁决：P0 先 warn（Diag），P2 转 error**；界线是**块级位置**出现已知容器结构
（`section` / 分栏展开产物）之外的标签；段落内联 HTML（`<br>` 等）不动。
宿主插件 UI 继续走 `SKIP_SELECTOR` 豁免名单（由 host 注册，core 默认空）。

### R6 Tier 0 / Tier 1 同 DOM 双态，A4 的物理机制

同一份 DOM 挂两个 class，CSS 负责切换，**零 JS 分支**：

```css
.md2s-preview  .cols { display:flex; gap:var(--md2s-gap) }    /* Tier 0：源码流动 */
.md2s-preview  .cols > .col { flex:var(--md2s-grow,1) }       /* 响应式，结构保真即可 */
.md2s-frozen   [data-slot] { position:absolute;                /* Tier 1：查表冻结 */
                               left:var(--frame-x); top:var(--frame-y);
                               width:var(--frame-w); height:var(--frame-h) }
```

（`.cols` 是 `cols.js` 的展开产物；纯编辑器场景里宿主另有透镜——marktext 的
`columnsLayout` 选项就是同一思想：同一状态，flat/columns 两种模式，CSS 类切换。）

Tier 0 不查布局表、不 freeze——编辑器中分栏内容爱怎么流怎么流（A4）；
Tier 1（放映 / 图片型 PPTX）从 IR 的 frame 注入 CSS 变量，逐像素；
Tier 2（引擎实测）就是测量仪器本身。三宿主锁同一 `layouts.json` + 同一渲染核心 semver。

### R7 回写四口的代码落点（A8 的可执行答案）

| 回写口 | 落点 | 现状 | 动作 |
|---|---|---|---|
| `media.intrinsic` | `export/pptx/media.js` | 只存文件名 | 落盘时读 naturalWidth/Height 回写 |
| `frozen.columnWidths` | ir.js `tableOf::colWidths` | 已有，未标「冻结」 | 挂到 `deck.frozen.columnWidths`，B 类校验跨片一致 |
| `fit.fontScale` | 无 | 无 | 新（R4） |
| `diags` | 散落的 console.warn | 无结构化出口 | 新，页级 `Diag[]` |

「哪些字段来自测量」在 schema 上有封闭答案 = 这四个路径，审计脚本可静态验证（见 §12）。

---

## 3. 目标架构

```
core/
  parse/           （不变）frontMatter · markdown(html:true) · sectionize
  split/cols.js    → 容器语法归一器（begin/split/end，已落地）
  plan/            ← 全新：IR v3 的立法与执法层
    layouts.json    布局表 + invariants + forms（单源，见 §5）
    theorem.js      minSlotWidth 派生不变量；deriveLayouts(canvas)
    blockStore.js   md AST → 扁平 Block（id/kind/src/role/frozen/body）
    strategy.js     封闭策略集 + 降级链状态机
    measure.js      浏览器测量适配器：flex 收敛 → frame；内容实测 → block.body
    planner.js      立法 → 实例化 → 执法 → 救济（产出 Slide 计划，非 DOM）
    ir.js           assemble：计划 + 回写四口 → IR v3 判决书
    freeze.js       A/B 类终审 + 哈希链（纯函数，node 可跑，进 smoke）
    preview.js      forms → Tier 0 响应式 CSS（与 layouts.json 同源派生）
  render/fill.js   ← 全新：填入循环参考实现（三查表一防御，见 §11）
export/pptx/       sidecar 适配 v3（version 分流，v1 兼容一版）
```

管线时序：

```
md ─ frontMatter ─ markdown-it(html:true) ─ sectionize ─▶ BlockStore（扁平块库）
                                                              │
三注释 ──lexer 归一──▶ ManualBody（七+一条降级规则）┘
                                                              ▼
                                    planner：策略立法 → 布局表实例化 → 实测执法（浏览器）
                                                              │ 回写四口
                                                              ▼
                                    IR v3（判决书）◄── freeze 终审（A 结构 / B 物理）
                                                              ▼
                    Tier 0 编辑器预览（流动） │ Tier 1 渲染器（冻结） │ Tier 2 实测仪器
```

**与图表铁律的关系**：`RENDERERS[kind]` 只「摆」块；图表块一律是 `image`/`custom`
（宿主 `renderDiagram` 产出的位图，`core/render/diagramHost.js` 契约不变），
填入循环没有任何图表引擎调用——v3 不碰铁律。

---

## 4. 契约一：容器语法归一（lexer，已落地 2026-10-24）

**分栏符定为 `<!-- begin / split / end -->` 三注释**（`core/split/cols.js`，替代早期的
`:::cols` 糖）。与 marktext（`packages/muya/src/utils/columns/syntax.ts`）**同族同规则**：
两侧 lint 一致，用户混用两个编辑器行为不分叉；marktext 已用生产验证了这套正则与降级规则，
不重新发明。`:::cols` 与两标记式（`<!-- cols 2 --> + <!-- colbreak -->`）**已移除**，不再有二义性。

```markdown
<!-- begin 30:70 -->     开组，可带占比（正整数，和为 100）；省略则等宽
<!-- split -->           栏分隔（可多个）
<!-- end -->             闭合
```

lexer 规则（行级扫描，标记必须从行首开始独占一行，≤3 空格缩进）：

| # | 规则 | 行为 |
|---|---|---|
| 1 | 孤立 split/end | 忽略，warning |
| 2 | begin 无 end（EOF 前） | 该组不分栏、内容原位保留，warning |
| 3 | 嵌套 begin | 内层忽略，warning |
| 4 | split 多于 2（超 3 栏） | 整组线性排列，warning |
| 5 | 占比非法 / 个数与栏数不符 | 按等宽渲染，info——**宽度绝不从畸形占比猜** |
| 6 | 注释未闭合（无 `-->`） | 该标记无效，warning |
| 7 | 标记不在顶层（缩进/引用/表格/行内） | inert，info |
| 9 | begin 后没有 split | 至少 2 栏才成组，不展开，warning（本项目扩展，marktext 建 1 栏组） |

产出：`BlockStore` 里一个 `kind:"manual"` 块，`body: { form:"cols", cols: split数+1, columns: BlockId[][] }`——
栏内子块**复用扁平块库**（不嵌套存），整容器 `frozen: true`。marktext 的教训直接佐证 R6：
它 Phase 2 用 DOM 后处理冒充分栏结构，撤销栈/保存/编辑三连废，Phase 3 才块树化——
Tier 0 预览绝不能对 DOM 做后处理 regroup，必须双态 CSS 同源切换。

---

## 5. 契约二：布局表与四栏定理

`core/plan/layouts.json`（唯一布局真相；`flex` 词汇只活在表里）：

```json
{
  "slideSize": [1280, 720],
  "padding": [84, 72],
  "gap": 24,
  "layouts": {
    "full":    { "slots": { "body": {} }, "autofit": ["body"] },
    "cols2":   { "slots": { "lead": {}, "col1": { "grow": 1 }, "col2": { "grow": 1 }, "tail": {} } },
    "cols3":   { "slots": { "lead": {}, "col1": { "grow": 1 }, "col2": { "grow": 1 },
                            "col3": { "grow": 1 }, "tail": {} } },
    "grid2x2": { "slots": { "lead": {}, "g1": {}, "g2": {}, "g3": {}, "g4": {}, "tail": {} } },
    "manual-cols-2": { "slots": { "m1": { "grow": 1 }, "m2": { "grow": 1 } } },
    "manual-cols-3": { "slots": { "m1": {}, "m2": {}, "m3": {} } },
    "manual-grid":   { "slots": { "g1": {}, "g2": {}, "g3": {}, "g4": {} } }
  },
  "invariants": { "minSlotWidth": 340 }
}
```

`theorem.js` 派生（伪码）：

```
deriveLayouts(canvas):
  content = canvas - 2*padding
  for each candidate layout with n slots-per-row and r rows:
      perSlot = (content - (n-1)*gap) / n
      keep layout iff perSlot >= invariants.minSlotWidth
  # 1280 → {full, cols2, cols3, grid2x2, manual-*}；1920 → 追加 cols4
  # 表的 slideSize 与画布不符 ⇒ baseTableHash 失效 ⇒ IR 重算（A1 链指纹）
```

测量循环收敛：表声明 `grow`/`gap` 约束 → 浏览器里按 flex 排一轮 → 读回每个 slot 的
`getBoundingClientRect` → 写进 `ResolvedLayout.frame`（终值）。`grow:[2,1]` 的非等分双栏
收敛后就是两个具体 Frame，**渲染器读数不读约束**。

---

## 6. 契约三：词典三方闭合（机制）

三方（Tier 0 预览形态集 / IR 布局集 / 自动布局表）**不手抄三份清单**，全部从
`layouts.json` 单源派生，靠同一个 sha256（`meta.baseTableHash`）闭环：

```
layouts.json ──┬─▶ preview.js  → Tier 0 CSS 形态集（cols2/cols3/grid2x2 + manual 三种）
               ├─▶ ir.js       → IR layouts 键集（实例化终值）
               └─▶ strategy.js → 自动布局表可选集（按定理过滤）
```

不存在「预览演示得出、引擎冻结不了」的形态；也不存在「引擎冻结了、预览不会画」的形态。
`baseTableHash` 同时进 sidecar 模板缓存键——换表 ⇒ 缓存失效 ⇒ 重算，链上无暗缓存。

---

## 7. 契约四：预览可流动 / 版面必须冻结

| Tier | 宿主 | 几何来源 | 切分 | 验收 |
|---|---|---|---|---|
| 0 | 常规编辑器（marktext/Typora 预览） | 响应式 CSS（R6 双态之 preview） | 不切，流动 | 结构保真：容器嵌套、栏序一致 |
| 1 | 自家渲染器（deck 放映 / 图片型 PPTX） | IR frame 注入 CSS 变量（frozen 态） | 已冻，不切 | manual 块逐像素 ≡ Tier 2 |
| 2 | 引擎实测（e2e 测量仪器） | 布局表 flex 收敛 | planner 切 | snapshot 可回归 |

保真审计（A4 的硬验收）：manual 容器在 Tier 1 与 Tier 2 下**逐像素 diff ≤ ε**
（同表、同渲染核心、冻结不切分）。这条直接征用 TODO §2 未做的「截图对比」基线工作，一举两用。

---

## 8. 规划器：策略、降级、回写

**Diag 封闭码表**（`slide.diags`，存结论不存过程）：

| code | 级别 | 触发 |
|---|---|---|
| `UNSUPPORTED_HTML` | error→warn(P0) | 块级白名单外标签 |
| `COL_GROUP_INVALID` | warn | 分栏组非法（rule 1/2/3/6/9：孤立/无 end/嵌套/未闭合/无 split），原样保留 |
| `COL_DEGRADED` | warn | 分栏组降级（rule 4 超 3 栏线性 / rule 5 占比非法等宽） |
| `MANUAL_NESTED` | error | manual 嵌 manual（lexer 层 rule 3 的 IR 侧映射） |
| `SLIDE_OVERFLOW` | error | 降级链走穿仍溢（诚实交付） |
| `MANUAL_OVERFLOW` | warn | manual 块溢出，**不改写** |
| `DEGRADED` | warn | 降级产物，附 `demoteFrom` |
| `FIT_APPLIED` | warn | autofit 救济生效，附 `fontScale` |
| `CONT_SPILLED` | warn | 续页产生（含 hints：lineStart/numberedStart/repeatHead） |
| `ORPHAN_PARAGRAPH` / `LEAD_KEYWORD_CONFLICT` | warn | README 孤段控制 / 关键词冲突降级 |

> 词法层诊断（cols.js 的 rule 1–7+9，已落地）与 IR 层 Diag 是同一事件的两个存档点：
> 前者带源码行号给作者看，后者进 IR 给审计用。

**续接 hints 显式给**（渲染器零计算）：`lineStart`（代码行号续接）、`numberedStart`
（列表续编号）、`repeatHead`（表格重复表头）——全部由 planner 算定，随 `place.part` 下发，
与现行 `overflow.js::appendContinuationMarker` 的语义一一对应，只是从「改 DOM」变成「写 IR」。

---

## 9. IR v3 Schema 定稿

在给定 schema 基础上，按本项目现状补全省略号与判别联合（完整版随 P2 落地为
`core/plan/ir.schema.json`，draft-07，与 v1 并存一版）：

```ts
interface Deck {
  meta: {
    slideSize: [1280, 720]
    baseTableHash: string        // layouts.json sha256；换表/换画布 ⇒ IR 失效重算
    engine: string               // "md2slides-plan@1"：无时间戳，snapshot 友好（A6）
    theme?: { name: string; cssHash: string }
  }
  layouts: Record<LayoutId, ResolvedLayout>     // 实例化终值（A1）
  blocks:  Record<BlockId, Block>               // 内容真值，扁平存，cells 引用
  slides:  Slide[]
  media:   Record<MediaId, { src: string; intrinsic?: [w, h] }>   // 回写口①
  frozen:  { columnWidths?: Record<BlockId, number[]> }           // 回写口②
}
interface Slide {
  id: SlideId
  layout: LayoutId          // 查表键①
  strategy: StrategyId      // 审计 + 测试 oracle（A3）
  title?: BlockId
  cells: Cell[]             // 数组序 = 阅读顺序
  diags: Diag[]             // 回写口④，页级
}
interface Cell { slot: SlotId; place: Placement }
interface Placement {
  block: BlockId
  part?: { unit: "rows"|"items"; range:[number,number]; seq:[i,n]; group: GroupId;
           hints: { lineStart?:number; numberedStart?:number; repeatHead?:boolean } }
  fit?: { fontScale: number }        // 回写口③，仅 autofit 授权槽
}
type BlockKind = "heading"|"paragraph"|"list"|"table"|"code"|"image"|"quote"|"manual"
interface Block {
  id: BlockId; kind: BlockKind; src: [number, number]
  role?: "lead"|"tail"|"core"|"orphan"|"anchor"   // 语义存档；渲染路径禁读（A2）
  frozen?: boolean                                // 手动冻结，不切分
  body: BlockBody           // 判别联合：内容真值（实测样式 + 内容几何，R1）
}
interface BlockBody {
  heading:   { level:number; runs:Run[] }
  paragraph: { runs:Run[] }
  list:      { ordered:boolean; items:ListItem[] }
  table:     { colWidths:number[]; rows:Row[] }     // 列宽另冻结一份（回写口②）
  code:      { lines:Run[][]; lang?:string }
  image:     { media:MediaId }
  quote:     { runs:Run[] }
  manual:    { form:"cols"|"grid"; cols:2|3; columns:BlockId[][] }  // 整容器冻结
}
interface Frame { x:number; y:number; w:number; h:number }
```

**v1 → v3 迁移映射**（sidecar 同时吃得下，version 分流）：

| v1 字段 | v3 去处 |
|---|---|
| `slides[].blocks[]`（绝对 geo） | 拆成 `cells[].place.block` + 槽内局部坐标（R1） |
| `slides[].layout`（启发式） | `layout` 改为查表键 + `strategy` 审计字段 |
| `slides[].background` | 主题槽样式（母版），v3 由 theme.cssHash 覆盖 |
| `chrome.pageNumber` | 母版占位符（不变） |
| `canvas` | `meta.slideSize` + 布局表 |
| `type:"unknown"` | 消失：UNSUPPORTED_HTML（R5） |
| `type:"custom"` | `image`/宿主 raster 钩子产物（不变） |

---

## 10. freeze 终审（A/B 不变量）

纯函数模块 `core/plan/freeze.js`，node 可跑，进 `npm run smoke`：

**A 类（结构良构）**：slot ∈ 布局表；block 存在；`part.range` 界内且 hints 与之一致；
`kind × RENDERERS` 注册匹配；manual 无嵌套；`cols ∈ {2,3}`；`layout` 键 ∈ 本次派生布局集。

**B 类（物理放行）**：块矩形 ⊆ frame（含 ε，R1）；`fontScale ∈ [0.5,1]`；
列宽跨片一致（回写口②）；同 slot 内 cells 不重叠。

**确定性（A6）**：`meta = { slideSize, baseTableHash, engine, theme.cssHash }` 四元组即链指纹；
e2e 加「同输入跑两遍，IR JSON deep-equal」断言 + fixtures 的 `*.ir.json` 快照进 git，diff 即回归。

---

## 11. 填入循环（v3 执行层参考实现）

`core/render/fill.js`——渲染器的全部逻辑，三个查表分支 + 一个防御 error（A7）：

```js
function fillSlide(deck, slide, RENDERERS) {
  const layout = deck.layouts[slide.layout]
  if (!layout) throw new IrError("UNKNOWN_LAYOUT:" + slide.layout)      // 防御 error
  for (const cell of slide.cells) {                                     // 数组序 = 阅读序
    const slot = layout.slots[cell.slot]
    if (!slot) throw new IrError("UNKNOWN_SLOT:" + cell.slot)           // ② 查槽位
    const block = deck.blocks[cell.place.block]
    if (!block) throw new IrError("UNKNOWN_BLOCK:" + cell.place.block)
    const render = RENDERERS[block.kind]
    if (typeof render !== "function") throw new IrError("NO_RENDERER:" + block.kind) // ③ 查 kind
    render(block, slot.frame, cell.place.part, cell.place.part?.hints, cell.place.fit)
  }
}
```

`role`、`strategy`、`diags`、优先级、测量轮次、降级历史——一个都不出现。它们是庭审，不是判决。

---

## 12. 五审计落地（写进 CI 的终检）

| # | 审计 | 落地方式 |
|---|---|---|
| 1 | 填入审计 | e2e 用 spy `RENDERERS` 记录全部调用，断言参数形状恒为 `(block, frame, part, hints, fit)`；`core/render/` 内新增第四种分支即红 |
| 2 | 零语义审计 | `tools/audit-no-role.js`：grep `\.role` 于 `core/render/` + host 渲染路径，0 命中（role 只许出现在 `core/plan/` 与 freeze） |
| 3 | 回写口审计 | 单测：任意 fixture IR 的「测量来源字段」必须 ⊆ `{media.intrinsic, frozen.columnWidths, fit.fontScale, diags}`（白名单静态表） |
| 4 | 保真审计 | e2e 截图：manual 容器 Tier 1（frozen DOM）≡ Tier 2（量测 DOM）逐像素 diff ≤ ε |
| 5 | 漂移审计 | `tools/audit-drift.js`：`host/thin`、`host/typora`、`e2e` 三处声明的渲染核心 semver + `layouts.json` sha256 一致，不一致 CI 红 |

---

## 13. 分期计划（每期可独立验收、可回退）

| 期 | 内容 | 落点 | 验收 |
|---|---|---|---|
| **P0** | 布局表单源化：`layouts.json` + `theorem.js`（四栏派生）+ 容器语法归一 + `UNSUPPORTED_HTML` warn + BlockStore 雏形 | `core/plan/`、`core/split/cols.js` | smoke 新增：同输入同 BlockStore；1280/1920 派生布局集符合 §5 表 |
| **P0'**（已落地 2026-10-24） | **分栏符统一为 `<!-- begin/split/end -->` 三注释**：cols.js 重写（marktext 同族七+一条规则），`:::cols` 糖与两标记式移除，examples 迁移，USAGE/README 同步 | `core/split/cols.js`、`compose.js`、`tools/smoke.js` | smoke 18 项新断言全绿（47 项）；存量文档 1 处迁移展开正确、零残留 |
| **P1** | 规划器：策略封闭集 + 降级链状态机 + autofit/fit + Diag 结构化。`overflow.js` 从「改 DOM」重构为「产出带 strategy 的 Slide 计划」（DOM 操作留作 Tier 2 测量适配器的实现细节） | `core/plan/planner.js`、`strategy.js`、`measure.js` | e2e 断言：strategy ∈ 封闭集；降级链合法（demoteFrom 闭合）；新 fixtures：strategy.md / fit.md / cols.md |
| **P2** | IR v3 装配 + freeze + 哈希链 + snapshot 回归；sidecar 适配（version 分流，v1 兼容一版） | `core/plan/ir.js`、`freeze.js`、`export/pptx/` | freeze A/B 全绿；同输入两遍 IR deep-equal；旧 demo/overflow 出片结果不变（v1→v3 适配器兜底） |
| **P3** | 三宿主：Tier 0 预览 CSS（双态）、Tier 1 查表渲染（`render/fill.js`）、五审计脚本化；**TODO §1 重写 typora 壳排在这里**（壳的预览层直接吃双态机制） | `core/render/fill.js`、`core/plan/preview.js`、`host/typora/` | 五审计全绿；Typora 能放映；manual Tier 1 ≡ Tier 2 逐像素 |

**回退保障**：P0–P2 全程不碰 DOM 输出与 sidecar 输入格式（v1 并行一版）；
P3 的 Tier 1 渲染可先与主题 CSS 直排并行存在，按页切换验收。

---

## 14. 风险与待拍板

| # | 事项 | 我的建议 |
|---|---|---|
| 1 | 块 geo 槽内局部化会动 sidecar 坐标基准（ir 装配 + `fill_deck.py` + `check.js`） | 做。换算只发生在装配处一次；否则 frame 与块坐标双轨，A1 名存实亡 |
| 2 | `UNSUPPORTED_HTML` 收紧可能打到存量文档（examples/ 20 个未扫） | P0 先扫一遍出清单，warn 起步；P2 转 error |
| 3 | autofit/fontScale 与现行「宁可切不缩」哲学 | 接受：降级链已把它排在切分之后，只救济切不动的块 |
| 4 | Tier 1 查表渲染 = 主题 CSS 权力降级（只管槽内样式，布局权归表） | 这是全程最大的一次权力转移，P3 单独验收，可与 CSS 直排并行一版 |
| 5 | 1920 画布下 cols4 合法但无策略选用 | 留扩展位。定理自动管宽紧，不需要黑名单 |

**一句话收束**：表立法（layouts.json），量执法（measure 收敛 + 回写四口），
降级救济（封闭策略链），freeze 终审（A/B + 哈希链）；编辑器负责流动的预览，
渲染器负责冻结的版面——而这份方案落到这个仓库，改动最重的不是 IR，是
`overflow.js` 从「直接改 DOM 的切分器」长成「产出判决书的规划器」。
