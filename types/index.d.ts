// types/index.d.ts — md2slides 公开 API 的类型草案。
// 契约以 docs/API.md 为准；IR 的完整判别联合见 export/pptx/ir.schema.json（draft-07）。
// 0.1 阶段允许类型与实现有非破坏性出入，发现不一致以实现为准并提 issue。

/// <reference lib="dom" />

// ---------- compose ----------

export interface ComposeDefaults {
  headingDivider?: number
  theme?: string
}

export interface Diagnostic {
  rule?: number
  level?: "info" | "warning" | "error"
  line?: number
  message: string
}

export interface DeckMeta {
  title: string | null
  subtitle: string | null
  author: string | null
  date: string | null
  book: string | null
  header: boolean | string
  footer: boolean | string
  keywords: string[]
  /** 章节目录页：true（缺省）开 / false 关 / 数字 = 子项列到该级 */
  toc: boolean | number
}

export interface ComposeOptions {
  /** 建 DOM 用。浏览器宿主传 iframe 的 document；Node 传 jsdom 的（缺省用全局） */
  document?: Document
  defaults?: ComposeDefaults
  /** 是否展开 <!-- begin/split/end --> 三注释分栏，默认 true */
  expandCols?: boolean
  /** 是否把「A；B；C。」分号并列段落转成列表，默认 true（front-matter `semicolons: false` 亦可关） */
  semicolons?: boolean
  /** 代码块是否换行，默认 true */
  codeWrap?: boolean
  /** 主题目录（自定义主题注册点） */
  themesDir?: string
  /** 读文件实现（浏览器宿主注入）；Node 缺省用 fs */
  readFile?: (file: string) => string | null
  /** 是否在 compose 时就染一次代码高亮，默认 true */
  highlight?: boolean
  /** 是否按需拼 KaTeX CSS，默认 true */
  math?: boolean
  /** KaTeX 字体目录地址，必须 http(s)://（浏览器拒绝 XHR 到 file://） */
  katexFontsUrl?: string
}

export interface ComposeResult {
  /** 序列化产物。renderDiagrams 改 DOM 后此快照过期，从 doc 重新序列化 */
  html: string
  css: string
  doc: Document
  slideWidth: number
  slideHeight: number
  slideCount: number
  theme: string | null
  /** 展开的分栏组数 */
  columns: number
  /** 转成列表的分号段落数 */
  semicolons: number
  columnDiags: Diagnostic[]
  coverDiags: Diagnostic[]
  meta: DeckMeta
  highlighted: number
  keywords: number
}

export function compose(md: string, opts?: ComposeOptions): ComposeResult

// ---------- renderDiagrams ----------

export interface DiagramBlock {
  pre: HTMLElement
  code: HTMLElement
  lang: string
  type: "mermaid" | "graphviz" | "plantuml" | "echarts" | string
  source: string
}

export interface DiagramResult {
  /** 位图二选一（SVG 请宿主先栅格成 PNG） */
  dataUrl?: string
  png?: Buffer | Uint8Array
  width?: number
  height?: number
}

export interface RenderDiagramsOptions {
  /** 宿主钩子：出图。缺钩子 / 返回空 / 抛错 → DiagramError 硬失败，不出占位 */
  renderDiagram?: (block: DiagramBlock) => DiagramResult | Promise<DiagramResult>
  /** 这一遍只处理这些类型（分环境多遍） */
  only?: string[]
  /** 是否等帧让异步图铺开，默认 true */
  settle?: boolean
  frames?: number
}

export interface RenderDiagramsResult {
  rendered: number
  types: string[]
  pending: string[]
}

export function renderDiagrams(doc: Document, opts?: RenderDiagramsOptions): Promise<RenderDiagramsResult>

/** 兜底闸门：所有预通行跑完后仍有未渲染围栏即抛 DiagramError */
export function assertDiagramsRendered(doc: Document): { pending: number }

export class DiagramError extends Error {
  name: "DiagramError"
  type?: string
  source?: string
}

// ---------- splitOverflow / highlightCode ----------

export interface SplitOverflowOptions {
  slideWidth?: number
  slideHeight?: number
  /** compose 的 meta：页眉页脚（家具）的输入 */
  meta?: DeckMeta
  /** 页高预算系数，默认 1 */
  margin?: number
  /** 内部单轮最大遍数，默认 4 */
  maxPasses?: number
  /** 续页标记文本，缺省不标 */
  contMarker?: string
  /** 续页是否重复标题，默认 true */
  repeatHeading?: boolean
  /** 页眉面包屑分隔符，默认 " > " */
  headingPathSeparator?: string
  /** 章节目录页开关，优先级高于 meta.toc：false 关 / 数字 = 子项列到该级 */
  toc?: boolean | number
  /** 目录页标题文本，默认 "目录"（多页时续页自动加"（续）"后缀） */
  tocTitle?: string
}

/** 物理分页。返回本轮新增页数；反复调用直到返回 0（需要真实布局引擎） */
export function splitOverflow(doc: Document, opts?: SplitOverflowOptions): number

/** 代码染色（幂等）。splitOverflow 切块丢 span，分页收敛后必须重染一次 */
export function highlightCode(doc: Document): number

// ---------- extractIr / checkIr ----------

export interface MediaSink {
  add(src: string, kind: string): string | null
  warnings?: string[]
}

export interface ExtractIrOptions {
  slideWidth?: number
  slideHeight?: number
  theme?: string
  cssHash?: string
  meta?: DeckMeta
  /** 图片落盘钩子。没有它 image 块 src 为 null，闸门报「图片未落盘」 */
  media?: MediaSink
  /** 元素 → PNG data URL 的兜底栅格钩子（公式 / 活组件） */
  rasterize?: (el: Element) => Promise<string | null>
  /** 宿主插件 UI 的选择器，命中即跳过不进 IR（core 默认空） */
  skipSelector?: string
  /** 测量前等待钩子（活图表铺开画布） */
  settle?: () => Promise<unknown> | unknown
  /** 抽每页前翻页钩子（隐藏页 canvas 是 0×0） */
  beforeSlide?: (index: number) => Promise<unknown> | unknown
  /** 内联 SVG 栅格倍率 */
  diagramScale?: number
  /** 相对路径图片的基准目录 */
  baseDir?: string
}

export interface Run {
  text: string
  br?: boolean
  style?: RunStyle
}

export interface RunStyle {
  color?: string
  bold?: boolean
  italic?: boolean
  font?: string
}

export interface BlockStyle {
  fontSizePt: number
  font?: string
  color?: string
  bold?: boolean
  italic?: boolean
  align?: "left" | "center" | "right" | "justify"
  lineSpacingPt?: number
  spaceBeforeIn?: number
  spaceAfterIn?: number
  paddingLeftIn?: number
  paddingRightIn?: number
  paddingTopIn?: number
  paddingBottomIn?: number
}

export interface Geo {
  x: number
  y: number
  w: number
  h: number
}

export interface ListItem {
  level: number
  runs: Run[]
  style: BlockStyle
  lines?: number
  indentIn?: number
  gapBeforeIn?: number
  srcRange?: [number, number]
}

/** IR v1 块（宽松联合：type 判别，字段按 type 出现，详见 ir.schema.json） */
export interface IrBlock {
  type: "heading" | "paragraph" | "list" | "code" | "table" | "image" | "math" | "custom" | "unknown"
  geo?: Geo
  style?: BlockStyle
  runs?: Run[]
  level?: number
  lines?: number
  singleLine?: boolean
  ordered?: boolean
  items?: ListItem[]
  gapAfterIn?: number
  colWidths?: number[]
  rows?: Array<{
    header?: boolean
    heightIn?: number
    cells: Array<{ runs: Run[]; style?: BlockStyle; w?: number; header?: boolean }>
  }>
  role?: string
  container?: string
  /** 该块来自 md 的行区间（1 基含端点）；封面/家具等引擎生成的块没有 */
  srcRange?: [number, number]
  col?: number
  raster?: string
  html?: string
  text?: string
  tag?: string
  cls?: string
}

export interface IrSlide {
  index: number
  pagination?: number
  layout: string
  background?: { color?: string; image?: string }
  blocks: IrBlock[]
}

export interface SlideIr {
  version: number
  canvas: { widthIn: number; heightIn: number; pxWidth: number; pxHeight: number }
  theme: { name: string | null; cssHash: string | null }
  meta?: { title?: string | null; subtitle?: string | null; author?: string | null; date?: string | null } | null
  slides: IrSlide[]
  media?: { warnings?: string[] }
}

/** DOM → Slide IR（需要真实布局引擎） */
export function extractIr(doc: Document, opts?: ExtractIrOptions): Promise<SlideIr>

// ---------- 播放器（kit 层） ----------

export interface DeckPlayer {
  readonly index: number
  readonly total: number
  /** 当前页已游走/揭示步数（纯翻页形态恒 0） */
  readonly step: number
  /** 当前页步进总数（纯翻页形态恒 0） */
  readonly steps: number
  readonly mode: "page" | "element"
  /** steppers 钩子的异常收集（宿主可读，不进控制台） */
  readonly stepIssues: string[]
  readonly stage: HTMLElement
  next(): void
  prev(): void
  /** 翻到第 k 页（1 基，自动钳到 [1, total]） */
  go(k: number): void
  /** 下一步（element 模式；slide 模式恒 false） */
  stepFwd(): boolean
  /** 上一步（element 模式；slide 模式恒 false） */
  stepBack(): boolean
  /**
   * 触发当前步（element / page+browse，步进到位才命中）或当前页第一个（page 纯翻页）
   * `[data-md2s-activatable]` 的 click，返回是否命中。Enter 键同款语义；
   * 无可命中目标时 Enter 原样放行。
   */
  activate(): boolean
  /** 运行时切形态：步进状态全清，当前页按新形态重放（browse 开关保持创建时的值） */
  setMode(mode: "page" | "element"): void
  /**
   * 步进表失效重建：宿主装饰页 DOM（如注入 `[data-md2s-activatable]` ▶）后调用——
   * 懒构建的步进表不含装饰后新增的步元素，不重建则按钮翻不到。slide 模式空操作。
   */
  refreshSteps(): void
  /** 重算缩放适配容器（容器尺寸变化时调；有 ResizeObserver 时自动） */
  fit(): number
  /** 解绑监听、把页搬回 root、撤掉 stage */
  destroy(): void
}

/**
 * 框架无关的幻灯片播放器：一页一屏、缩放适配容器、键盘翻页、页码状态。
 * UI（按钮/页码条/全屏）归宿主；onChange({index,total}) 1 基，创建时也发一次。
 * 会把页面 DOM 搬进自己建的 stage（同一文档内移动）；destroy 时原序搬回。
 */
export function createDeckPlayer(
  root: HTMLElement,
  opts?: {
    doc?: Document
    slideWidth?: number
    slideHeight?: number
    /** "page"=整页全显（默认）；"element"=渐进揭示；"slide"=旧键（page+browse:false） */
    mode?: "page" | "element" | "slide"
    /**
     * 仅 page 形态有意义：true（默认）逐元素游走——全显 + 高亮步进（翻页笔走到 ▶ 按
     * Enter 运行）；false 纯整页翻。
     */
    browse?: boolean
    /** 图表切分钩子；没命中 = 图表整块一步 */
    steppers?: ChartStepper[]
    onChange?: (state: { index: number; total: number; step: number; steps: number; mode: string }) => void
    keys?: boolean
    keyTarget?: EventTarget
    startIndex?: number
    /** 触屏手势导航，默认 true；false = 完全不接手势层 */
    touch?: boolean
    /** 手势挂哪（默认 root） */
    touchTarget?: EventTarget
    /** 触发滑动的位移门槛（CSS px），默认 40 */
    touchDistance?: number
    /** 超过这个耗时（ms）就不算「划」，默认 800 */
    touchTimeout?: number
    /** 也接鼠标拖拽（默认 false：只收 touch / pen） */
    touchMouse?: boolean
    /** 横向拖动时内容跟手移动（默认 true） */
    touchFeedback?: boolean
    /**
     * 容器 touch-action，默认 pinch-zoom（单指平移归手势层、双指缩放归浏览器）；
     * none = 平移缩放都归我们（放映区不可双指缩放）
     */
    touchAction?: string
    /** 起点命中就不起手：选择器（closest）或谓词；默认已跳过输入框 / contenteditable */
    touchIgnore?: string | ((el: Element) => boolean)
    /**
     * 触屏轻点导航：默认 "step"（点右半 = ↓ 前进——先步进、步尽翻页；纯翻页形态里就是
     * 翻页），"page" = 恒定整页翻、不动步进，false = 关掉（手势仍可用）。
     */
    tapNav?: boolean | "step" | "page"
    /** 左右分界（0~1，默认 0.5 = 左右各半；压线算前进） */
    tapZone?: number
    /**
     * 点中就不导航的选择器或谓词。默认 `TAP_IGNORE`：按钮 / 链接 / 表单控件 / 图片 /
     * `[data-md2s-activatable]`（▶ 运行代码、竞答发放）等「点了有自己的事要办」的东西。
     * 判据取自按下时的 target（指针捕获会改写抬手 target）。
     */
    tapIgnore?: string | ((el: Element) => boolean)
    /** 轻点允许的最大位移（CSS px），默认 min(12, touchDistance * 0.3) */
    tapSlop?: number
    /** 轻点允许的最长按压（ms），默认 500；更长算长按 / 选词，不导航 */
    tapTimeout?: number
  },
): DeckPlayer

/** 轻点导航的默认禁区选择器（宿主可用它做基准再追加自己的） */
export const TAP_IGNORE: string

// ---------- 步进（element 模式） ----------

/** 图表切分钩子：core 调度、宿主执行（与 renderDiagram 同构）。命中且 count>0 → 每单元一步 */
export interface ChartStepper {
  match(el: Element): boolean
  create(el: Element): { count: number; show(k: number): void; hide(k: number): void }
}

/** IR 验收闸门：逐页文本等价 + 几何不越界 + 图片落盘。issues 非空即拒 */
export function checkIr(
  doc: Document,
  ir: SlideIr,
  opts?: { skipSelector?: string },
): { issues: string[]; stats: { slides: number; blocks: number; byType: Record<string, number> } }

// ---------- 页容器契约 ----------

/** 文档序的全部页（section[data-slide]），播放器翻页遍历它 */
export function sectionsOf(doc: Document): Element[]

/** 页容器选择器唯一出处 */
export const SLIDE_SELECTOR: string

/** 摊开所有页并钉到画布尺寸；与 endMeasure 成对调用 */
export function beginMeasure(doc: Document, width?: number, height?: number): void
export function endMeasure(doc: Document): void

// ---------- 常量 ----------

export const DECK_DEFAULTS: Required<ComposeDefaults>
/** IR 契约版本（当前 1；v3 落地时消费者按 ir.version 分流） */
export const IR_VERSION: number
/** 续页标记样式：宿主必须拼进 deck CSS */
export const CONT_CSS: string
/** 续页标记 class 名 */
export const CONT_CLASS: string
/** 章节目录页的兜底样式：同 CONT_CSS 性质（主题里的那份优先） */
export const TOC_CSS: string
