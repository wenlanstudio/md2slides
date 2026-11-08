# md2slides front-matter 配置（本仓库权威参考）

> 依据源码逐项核实（2026-11-04）：`core/parse/frontMatter.js`（解析与 `deckMeta`）、
> `core/compose.js`（消费点）。键有增删先改代码，再同步本文件。
> 跨引擎总册（fence 标注 / 壳配置 / 优先级总表）：`../../AUTHORING-SPEC.md`（生态根目录）。

## 0. 解析规则（frontMatter.js，唯一实现）

- 只认**文档最顶部**的 `---` 围栏块：`/^[ \t]*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/`。
- 标量解析，不引 js-yaml：数字、布尔、去引号字符串。`date: 2026-10-24` 是字符串不是日期对象。
- 无 front-matter 的文档由 compose 注入默认（`headingDivider: 3` + `theme: lecture`）；
  **有则作者的话全算数**，未声明的键不补默认值。
- 未知键被忽略，不报错。

## 1. 元数据键（`deckMeta`，11 键）

去向：封面页 + PPTX 文件属性（title→标题、subtitle→主题、author→作者）。

| 键 | 值 | 去向 | 缺省 |
|---|---|---|---|
| `title` | 文本 | 封面题名；PPTX 文件属性·标题 | `null`（无 title 则无封面页） |
| `subtitle` | 文本 | 封面副标题；PPTX 文件属性·主题 | `null` |
| `author` | 文本 | 封面作者；PPTX 文件属性·作者 | `null` |
| `date` | 文本/数字 | 封面日期；字符串原样进 IR，sidecar（Python）`strptime` | `null` |
| `datetime` | 文本 | `date` 的别名（marp 兼容）；两边都写 `date` 优先 | — |
| `book` | 文本 | 书籍/课程名 → 页眉左侧内容源 | `null` |
| `header` | `true` / `false` / `"文本"` | 页眉三态：开 / 关 / 自定义文本 | `true` |
| `footer` | 同上 | 页脚三态 | `true` |
| `keywords` | `A, B` 或 `[A, B]` | 正文命中即高亮（分隔符 `,` `，` `;` `；` `、`，大小写不敏感去重）；只驱动渲染，不进 PPTX 属性 | `[]` |
| `show` | `page` / `element` | 放映形态：整页全显 / 渐进揭示 | 壳 config → 引擎缺省 `page` |
| `page` | `true` / `false` | 仅 `show: page` 有意义：逐元素游走（默认）/ 纯整页翻 | `null`（回退壳 config） |

## 2. 渲染键（`frontMatterPairs` → compose 消费）

| 键 | 值 | 说明 | 缺省 |
|---|---|---|---|
| `headingDivider` | 1–6 | 第 N 级标题起切页（钳到 1–6） | `3` |
| `theme` | 主题名 | `core/themes/` 下 `@theme` 声明匹配；不存在回退 lecture 并留警告 | `lecture` |
| `paginate` | `true` | 打页码（严格 `=== true` 才生效） | 不打 |
| `semicolons` | `false` | 分号转列表**关闭**（默认开；只有显式 `false` 生效） | `true` |
| `toc` | `true` / `false` / 数字 1–6 | 章节目录页：true = 每章前一页目录、当前章高亮；数字 = 子项列到该级；章节数 < 2 时不插 | `true` |

> `page` 与 `paginate` 是两个键：`page` 管放映翻页粒度，`paginate` 管页脚打不打页码。

> `doc-type`（USAGE 旧文提及）：**未实现**，代码无消费点，写了无效果。

## 3. 不是 front-matter 的东西（别写错位置）

- 抢答题：正文里 `<!--quiz {"answer":"B","limit":30}-->` 标记，见 `core/quiz/parse.js` 与 USAGE §3.7。
- 分栏：正文里 `<!-- begin/split/end -->` 注释。
- 块级标注（mdcode2run 的 `demo` / `file=` 等）：fence info-string，见生态根目录 AUTHORING-SPEC §二。

## 4. 优先级

```
放映形态   front-matter show/page > 壳 config.json SHOW/PAGE > 引擎缺省
主题/分页  front-matter headingDivider/theme/paginate/semicolons/toc > DECK_DEFAULTS
```

宿主可经 `compose(md, { defaults })` 注入文档级默认（仅对无 front-matter 的文档生效）。
