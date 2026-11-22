---
headingDivider: 3
paginate: true
title: 图表透传回归（新七类）
---

这一份专打「编辑器能画、deck 补齐透传」的七类图表：vega-lite / flowchart /
sequence / wavedrom / chart / abc（drawio 走 diagrams.net embed、要网络，
不进离线回归，见 diagramHost.js 的铁律注释）。

## 一张声明式统计图（vega-lite）

vega 只认 JSON（与编辑器同规格），svg 渲染器产出，栅格成 PNG。

```vega-lite
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "description": "柱状图",
  "data": { "values": [
    {"a": "A", "b": 28}, {"a": "B", "b": 55}, {"a": "C", "b": 43},
    {"a": "D", "b": 91}, {"a": "E", "b": 81}
  ] },
  "mark": "bar",
  "encoding": {
    "x": { "field": "a", "type": "nominal" },
    "y": { "field": "b", "type": "quantitative" }
  }
}
```

## 一张流程图（flowchart）

flowchart.js 的 DSL，Raphael 同步出 SVG。

```flowchart
st=>start: 开始
op=>operation: 处理
cond=>condition: 通过？
e=>end: 结束

st->op->cond
cond(yes)->e
cond(no)->op
```

## 一张时序图（sequence）

手绘主题（hand），danielbd 字体就绪后才画。

```sequence
Alice->Bob: 请求
Bob-->Alice: 应答
```

## 一张波形图（wavedrom）

数字时序；块配置头与宽松 JSON 都认（core/render/blockSource.js）。

```wavedrom
{ "signal": [
  { "name": "clk", "wave": "p..." },
  { "name": "req", "wave": "0.1..0.." },
  { "name": "ack", "wave": "1...01" }
] }
```

## 一张统计图（chart.js）

canvas 直出 PNG，@width/@height 块配置头决定显示尺寸。

```chart
// ==BlockCodeConfig==
// @width 560px
// @height 300px
// ==/BlockCodeConfig==

config = {
  type: "bar",
  data: {
    labels: ["一", "二", "三"],
    datasets: [{ label: "样例", data: [12, 19, 7] }]
  }
}
```

## 一段乐谱（abc）

abcjs 出谱，单 SVG 栅格。

```abc
X:1
T:音阶
M:4/4
L:1/8
K:C
CDEF GABc | cBAG FEDC
```
