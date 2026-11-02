# 可编辑 PPTX 子项目 · 架构与流程

`export/pptx/` 把「整篇 Markdown 的 deck」变成**可编辑的 PPTX**。思路是**模板 + 内容**：
样式归母版（PowerPoint 原生对象），内容归 IR（从已渲染的 DOM 实测得来）。

---

## 一、管线总览

一条 deck，两条通道，差异只在后半段：图片型追求像素，可编辑型追求结构。

```dot
digraph pipeline {
  rankdir=TB
  graph [fontname="Microsoft YaHei", fontsize=11, bgcolor="white", pad=0.4, nodesep=0.4, ranksep=0.55]
  node [fontname="Microsoft YaHei", fontsize=11, shape=box, style="rounded,filled",
        fillcolor="#eef3fa", color="#2e75b6", fontcolor="#23303f", margin="0.14,0.08"]
  edge [fontname="Microsoft YaHei", fontsize=10, color="#5b6b7c", arrowsize=0.8]

  md    [label="整篇 Markdown（01-Hive部署.md）"]
  build [label="compose + 图表预通行 + 代码高亮"]
  split [label="分页 / 跨页\loverflow.js（实测高度）"]
  dom   [label="deck DOM\lsection[data-slide]", fillcolor="#e6ecf5"]

  subgraph cluster_img {
    label="图片型通道"
    style="rounded,dotted"
    color="#8a97a5"
    fontcolor="#5b6b7c"
    raster [label="html-to-image 整页栅格\l+ PptxGenJS 铺满"]
    ppt1   [label="「<名>.pptx」\l逐像素保真 · 文字不可编辑",
            shape=note, fillcolor="#f2f4f7", color="#7a8b99"]
  }

  subgraph cluster_edit {
    label="可编辑通道（模板 + 内容）"
    style="rounded,dotted"
    color="#2e75b6"
    fontcolor="#2e75b6"
    ir    [label="pptx/ir.js 抽取\l实测几何 + computed 样式"]
    gate  [label="check.js 闸门\l文本逐字一致？几何不越界？",
           shape=diamond, style="filled", fillcolor="#fff4e0", color="#e0a33c"]
    warn  [label="控制台报错 + 提示", shape=note, fillcolor="#fdf1ef", color="#b3401f", fontcolor="#b3401f"]
    irj   [label="ir.json + media/\l（契约层）", fillcolor="#e8f2ea", color="#2e7d52"]
    tk    [label="design_token.py\lIR → DesignToken（五项）"]
    tp    [label="build_template.py\ltoken → template.pptx"]
    fl    [label="fill_deck.py\l模板 + IR → deck.pptx"]
    vf    [label="verify：成品文本 == IR 文本",
           shape=diamond, style="filled", fillcolor="#fff4e0", color="#e0a33c"]
    ppt2  [label="「<名>.editable.pptx」\l可编辑 · 可换配色 · 可加动画",
           shape=note, fillcolor="#eef7f0", color="#2e7d52"]
  }

  md -> build -> split -> dom
  dom -> raster
  raster -> ppt1
  dom -> ir
  ir -> gate
  gate -> warn [label="不通过", fontcolor="#b3401f", color="#b3401f"]
  gate -> irj  [label="通过", fontcolor="#2e7d52", color="#2e7d52"]
  irj -> tk -> tp -> fl -> vf -> ppt2
}
```

---

## 二、一键出片的调用时序

出片跨了**进程边界**：Electron 渲染进程负责抽取与校验，母版、版式、填充都在 Python 子进程里完成。

```mermaid
sequenceDiagram
    actor U as 用户
    participant P as index.js（渲染进程）
    participant D as deck DOM（iframe）
    participant I as pptx/ir.js
    participant M as pptx/media.js
    participant C as pptx/check.js
    participant S as Python sidecar

    U->>P: 点「导出可编辑 PPTX」
    P->>D: showSlide(i) 逐页 + 等 3 帧（活图表才有画布）
    P->>I: extractIr(doc)
    I->>D: 实测几何 + 读 computed 样式
    I->>M: 图片落盘（data URL / file:// / 绝对路径 / 相对路径）
    M-->>I: media/ 文件名
    I-->>P: Slide IR
    P->>C: checkIr(doc, ir)
    C-->>P: issues / stats
    P->>S: spawn python build_pptx.py --ir --out --report
    S->>S: design_token → build_template → fill_deck → verify
    S-->>P: build-report.json（issues / pending / notes）
    P-->>U: 提示成功或报出待查项
```

---

## 三、Slide IR 的结构

IR 是这条通道的**唯一契约**：一份数据结构，两侧都只对它负责
（书面、可机器校验的定义在 `ir.schema.json`）。

```dot
digraph ir {
  rankdir=LR
  graph [fontname="Microsoft YaHei", fontsize=11, bgcolor="white", pad=0.4, nodesep=0.3, ranksep=0.7]
  node [fontname="Microsoft YaHei", fontsize=11, shape=box, style="rounded,filled",
        fillcolor="#eef3fa", color="#2e75b6", fontcolor="#23303f", margin="0.14,0.08"]
  edge [fontname="Microsoft YaHei", fontsize=10, color="#5b6b7c", arrowsize=0.8]

  deck  [label="Deck\lversion · canvas · theme"]
  slide [label="Slide\lindex · layout · background\lnotes"]
  block [label="Block（抽象）\lgeo（英寸） · style（实测）", fillcolor="#e6ecf5"]

  deck  -> slide [label="1 : 127"]
  slide -> block [label="1 : *"]

  block -> heading
  block -> paragraph
  block -> list
  block -> code
  block -> table
  block -> image
  block -> math
  block -> custom

  heading   [label="Heading\llevel · runs"]
  paragraph [label="Paragraph\lruns · role"]
  list      [label="List\lordered · items(level, runs)"]
  code      [label="Code\llines 逐行 runs（高亮为实测色）"]
  table     [label="Table\lcolWidths · rows(cells, heightIn)"]
  image     [label="Image\lsrc（media 相对路径）"]
  math      [label="Math\ldisplay · latex · mathml\l→ OMML 原生公式（可编辑）",
             fillcolor="#e8f2ea", color="#2e7d52"]
  custom    [label="Custom（待栅格）\lraster · html · text",
             fillcolor="#fff4e0", color="#e0a33c"]
}
```

几何与样式的取值口径（决定"同源一致"能否成立）：

| 项 | 取值方式 |
| --- | --- |
| 位置 / 尺寸 | `getBoundingClientRect()` 实测（`beginMeasure` 钉画布后 scale=1），换成英寸 |
| 字号 / 颜色 / 对齐 / 行距 | 该元素自己的 `getComputedStyle`（不经全局 token） |
| run 级样式 | 只记录与所属块**不同**的字段；代码高亮因此是实测色 |
| 图片 | 落盘成 `media/`，IR 只留文件名 |

---

## 四、选哪条通道

一致性目标是**同源 token**，不是逐像素一致——那是两条互斥的路，先按目的选。

```dot
digraph choose {
  rankdir=TB
  graph [fontname="Microsoft YaHei", fontsize=11, bgcolor="white", pad=0.4, nodesep=0.4, ranksep=0.6]
  node [fontname="Microsoft YaHei", fontsize=11, shape=box, style="rounded,filled",
        fillcolor="#eef3fa", color="#2e75b6", fontcolor="#23303f", margin="0.14,0.08"]
  edge [fontname="Microsoft YaHei", fontsize=10, color="#5b6b7c", arrowsize=0.8]

  q [label="导出 PPTX 的目的？", shape=diamond, style="filled", fillcolor="#fff4e0", color="#e0a33c"]
  a [label="「导出 PPTX」图片型\l逐像素保真，文字不可编辑"]
  b [label="「导出可编辑 PPTX」模板型\l母版原生，可编辑可换配色"]
  c [label="改 Markdown 后重新导出\l零成本 · 100% 一致 · 不分叉",
     fillcolor="#eef7f0", color="#2e7d52"]
  d [label="「导出 IR」\l只看中间产物 ir.json + media/", shape=note, fillcolor="#f2f4f7", color="#7a8b99"]

  q -> a [label="要 1:1 复刻放映效果"]
  q -> b [label="交给人改字 / 加动画 / 合进别的 deck"]
  q -> c [label="只是自己改几处文字"]
  q -> d [label="排查抽取问题"]
}
```

---

## 五、文件职责

| 文件 | 职责 |
| --- | --- |
| `pptx/ir.js` | DOM → Slide IR：实测几何、逐元素样式、块分类 |
| `pptx/media.js` | 四种来源的图片统一落盘，IR 只留文件名 |
| `pptx/check.js` | 抽取闸门：文本逐页等价（去空白比较）、几何不越界 |
| `pptx/ir.schema.json` | IR v1 契约（draft-07） |
| `sidecar/design_token.py` | IR → DesignToken：画布/背景/页码/色板/字体（众数取值） |
| `sidecar/build_template.py` | token → `template.pptx`：母版、主题色板、字体三档、8 版式、页码占位符 |
| `sidecar/fill_deck.py` | 模板 + IR → `deck.pptx`；写完回读成品再验一次 |
| `sidecar/omml.py` | 公式：MathML → OMML（Office 原生公式）；优先 Office 的 `MML2OMML.XSL`，找不到走内置兜底 |
| `sidecar/build_pptx.py` | 一键串联（模板按主题哈希缓存）+ 输出 `build-report.json` |

---

## 六、四条不可回退的约束

1. **IR 从已渲染的 DOM 抽取**，不从 Markdown 重新解析——分页、图表位图、代码高亮都已是现成结果，
   重解析等于把 marp-core 再实现一遍。
2. **内容样式走逐元素实测**，不经"全局 token → 再应用"——否则主题改一处就要重建模板。
3. **文本不按视觉行拆段**——拆段能让换行与浏览器一致，但改一个字就全乱，与可编辑性互斥。
4. **分页决策留在浏览器侧**——PPTX 侧无法预知 PowerPoint 的排版结果，在那儿算"装不装得下"必然失准。
