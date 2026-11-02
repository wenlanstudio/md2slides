---
title: MD2Slides 功能总览
subtitle: 从 Markdown 到幻灯片，核心内容不拆页
author: quqingtao
date: 2026-11-02
book: MD2Slides 演示
theme: lecture
headingDivider: 2
header: true
footer: true
toc: false
paginate: true
keywords: 核心组, 物理分页, Slide IR, PPTX
---

## 30 秒读懂

先把整条管线走一遍：Markdown 进来，逻辑分页按标题切页，物理分页在浏览器里量真实高度，最后导出 HTML 或 PPTX。

| 阶段 | 做什么 | 产物 |
| --- | --- | --- |
| compose | 解析 Markdown、front-matter、主题；按标题切逻辑页 | HTML + CSS + 文档对象 |
| renderDiagrams | 调宿主渲染图表，换成位图 | 带图的 DOM |
| splitOverflow | 浏览器实测高度，按核心组切页 | 分好页的 DOM |
| extractIr | 抽出每页的块、几何、样式 | Slide IR JSON |
| export | 独立 HTML 或 PPTX | 可交付文件 |

后面每一节都对应这张表里的一段。

目录页默认开启；这份 demo 为了专注自动分页关掉了它，`toc` 的示例见 `e2e/fixtures/toc-many.md`。

## 核心组：一页一个主角

引擎不按固定行数切页，而是按「什么必须在一起」切页。这个单位叫核心组。

| 角色 | 例子 | 规则 |
| --- | --- | --- |
| 引导语 | 下面这张表…… | 紧贴核心前的唯一段落 |
| 核心 | 表格、代码、列表、图片、公式 | 一页最多一个核心组，可含 1~4 个核心 |
| 结束语 | 上表说明…… | 紧贴核心后的唯一段落 |

一页通常只放一个核心组；多个核心只有在对比、参照关系时才允许整组同页。
超过四个核心，或者单个核心高过一页，才进入分割流程。

## 长表格：按行切，表头跟着走

下面这张表会超过一页。引擎不会把一行拆成两半，而是按行切，并在续页重复表头。

这份 demo 刻意不写 `---` 手动分页符——下面的长表格、长代码、长列表，都交给引擎自动切。

| 块类型 | 是核心吗 | 装不下时 | 续页怎么标 | 说明 |
| --- | --- | --- | --- | --- |
| 表格 | 是 | 按行切 | 重复表头 | 列宽冻结，表头内容逐字复制 |
| 代码块 | 是 | 按行切 | 行号连续 | 禁止 1~2 行的碎片 |
| 有序列表 | 是 | 按项切 | 编号续上 | 不从 1 重新开始 |
| 无序列表 | 是 | 按项切 | 项不丢 | 保持原有顺序 |
| 图片 | 是 | 整体缩放 | 不拆 | 超高时缩到装得下 |
| 块级公式 | 是 | 独占一页 | 不拆 | 公式高度也是实测的 |
| 引用 | 可作结束语 | 跟核心走 | 不单独成核 | 紧贴核心后才是结束语 |
| 段落 | 可作引导/结束 | 跟核心走 | 不单独成核 | 夹在两个核心之间归后一个 |
| 多核心对比 | 1~4 个核心 | 整组一页 | 超过才切 | 对比、参照关系才允许 |
| 手动分栏 | 冻结区 | 不切 | 溢出只警告 | 标记必须独占一行 |
| 手动分页 | 冻结区 | 不切 | 优先级最高 | `---` 或 `<!-- slidebreak -->` |
| 页眉页脚 | 家具 | 收敛后注入 | 源码不写 | 封面与扉页豁免 |
| 目录页 | 家具 | 章节过多才续页 | 条目均分 | 超过 14 章整章跳过 |
| 图表 | 是 | 按位图整体处理 | 不拆 | 预通行必须早于实测 |

翻到下一页，表头会再出现一次，标题后面标「（续）」。

## 长代码：按行切，行号不断

代码块也是一个核心。装不下时按行切，行号跨页连续，不会留下 1~2 行的碎片。

```python
# 贪心分页：按块高度装页
def paginate(blocks, page_height, gap=0):
    pages, current, used = [], [], 0
    for block in blocks:
        height = block["height"]
        extra = gap if current else 0
        if current and used + extra + height > page_height:
            pages.append(current)
            current, used = [], 0
            extra = 0
        current.append(block)
        used += extra + height
    if current:
        pages.append(current)
    return pages


def split_oversize(block, page_height):
    # 单个核心高过一页时，按类型切
    kind = block["kind"]
    if kind == "table":
        return split_table_rows(block, page_height)
    if kind == "code":
        return split_code_lines(block, page_height)
    if kind == "list":
        return split_list_items(block, page_height)
    return [block]


def split_table_rows(table, page_height):
    # 按行切，续页重复表头
    pages, current = [], []
    used = table["header"]["height"]
    for row in table["rows"]:
        if current and used + row["height"] > page_height:
            pages.append({"header": table["header"], "rows": current})
            current, used = [], table["header"]["height"]
        current.append(row)
        used += row["height"]
    if current:
        pages.append({"header": table["header"], "rows": current})
    return pages
```

代码里的 `#` 不会变成标题，`---` 也不会变成分页符。

## 长列表：按项切，编号续上

列表按项切，续页继续编号。下面这份清单会超过一页；注意第二页的第一项编号没有回到 1。

1. 核心组是分页的最小语义单位
2. 一页通常只放一个核心组
3. 表格装不下时按行切
4. 续页重复表头
5. 代码装不下时按行切
6. 行号跨页连续
7. 有序列表按项切
8. 续页继续编号
9. 无序列表按项切
10. 列表项不会被丢掉
11. 图片整体缩放
12. 块级公式独占一页
13. 手动分页优先级最高
14. 手动分栏是冻结区
15. 页眉页脚收敛后注入
16. 字体度量影响分页
17. 物理分页必须真浏览器
18. 导出前过 IR 闸门

如果单个列表项本身高过一页，才会切进项内部——这是最后手段。

## 公式：行内与块级

行内公式跟着文字走，比如度量 $V_t$ 是状态 $S_t$ 的函数：$V_t = f(S_t)$。

块级公式是一个核心，独占一页，不会被切成两半：

$$
\sum_{t=1}^{T} V_t \neq V_T
$$

同一个核心组里也可以有多条行内公式，比如方差 $\operatorname{Var}(V_t)$。

公式高度来自浏览器实测，不是按字符数估的。

## 图表：Mermaid 与 ECharts

图表由宿主渲染成位图，core 只负责调度。预通行必须发生在物理分页之前，否则量到的高度是 0。

```mermaid
flowchart LR
  MD[Markdown] --> C[compose]
  C --> L[逻辑分页]
  L --> P[物理分页]
  P --> IR[Slide IR]
  IR --> H[HTML / PPTX]
```

```echarts
{
  "xAxis": { "type": "category", "data": ["1", "2", "3", "4", "5"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [12, 17, 9, 21, 15] }]
}
```

两个图在 IR 里都是 image 块，导出 PPTX 时按位图落盘。PlantUML 和 Graphviz 走同一套
`renderDiagram` 钩子，只是渲染发生在 Node 侧（Java / `dot`）。

## 分栏：并排对比

用 `<!-- begin / split / end -->` 三注释做 2~3 栏，适合左右对比。分栏是冻结区，引擎不切栏内内容。

<!-- begin 40:60 -->

**左栏：什么时候用**

- 两个方案对比
- 图文并排
- 代码 + 解释

<!-- split -->

**右栏：规则**

1. 最多 3 栏
2. 占比必须是正整数，和为 100
3. 标记必须从行首独占一行

<!-- end -->

栏内装不下只会给警告，不会擅自改写。

## 元信息与主题

题名、作者、页眉页脚、目录、主题都写在 front-matter 里，正文不手写封面。

```yaml
---
title: MD2Slides 功能总览
subtitle: 从 Markdown 到幻灯片，核心内容不拆页
author: quqingtao
date: 2026-11-02
book: MD2Slides 演示
theme: lecture
headingDivider: 2
header: true
footer: true
toc: false
paginate: true
keywords: 核心组, 物理分页, Slide IR, PPTX
---
```

页眉、页脚和页码都由这份 front-matter 生成；本 demo 关掉目录页，专注自动分页。

## 产物：HTML、PPTX 与 Slide IR

同一份 Markdown 可以出三种产物，按需要选。

| 产物 | 命令 | 适合 |
| --- | --- | --- |
| HTML 预览 | `node tools/render.js` | 快速看逻辑结构 |
| 独立 HTML | `node tools/export-html.js` | 双击放映、局域网投屏 |
| PPTX | `node tools/export.js` | 交付、二次编辑 |
| Slide IR | `extractIr` | 自己写导出器或消费 |

PPTX 默认图片型、零依赖；加 `--editable` 走 Python sidecar 出可编辑形状。IR v1 已冻结。

## 开始使用

- 仓库：https://github.com/wenlanstudio/md2slides
- 快速开始：README 的「快速开始」
- 库契约：`docs/API.md`
- 写作规范：`USAGE.md`
- 分页原理：`PAGINATION.md`

先跑 `npm ci`，再运行下面这条命令，就能看到这份演示：

```bash
node tools/export-html.js examples/demo.md -o demo.html
```
