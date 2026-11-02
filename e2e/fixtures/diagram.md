---
headingDivider: 3
paginate: true
title: 图表渲染回归
---

这一份专打「图表由宿主渲染」那条链路：预通行必须跑在物理分页实测之前，
这样 IR 量到的图高度才是真的。

## 一张小图

```dot
digraph hello {
  rankdir=TB
  intro -> core -> outro
}
```

## 一张决策树

```dot
digraph decide {
  rankdir=TB
  node [shape=box]
  start -> cond
  cond -> yes [label="yes"]
  cond -> no  [label="no"]
  yes  -> done
  no   -> retry
  retry -> cond
}
```

## 一张流程图（mermaid）

mermaid 是浏览器运行时，只能在页面里渲染——这一块验的就是"预通行分环境跑两遍"。

```mermaid
flowchart TD
  A[md source] --> B{has diagram?}
  B -- yes --> C[host renderDiagram]
  B -- no --> D[compose only]
  C --> E[img in DOM]
  D --> E
  E --> F[overflow measures]
```

## 一张统计图（echarts）

echarts 画到 canvas 上，同样只能在页面里渲染；它直接 `getDataURL()` 出 PNG，
省掉了 SVG→PNG 那一道栅格。

```echarts
{
  "xAxis": { "type": "category", "data": ["Mon", "Tue", "Wed", "Thu", "Fri"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [120, 200, 150, 80, 70] }]
}
```

## 一张时序图（plantuml）

plantuml 走 `java -jar`，跟 graphviz 一样是 Node 侧的活。

```plantuml
@startuml
Alice -> Bob: request
Bob --> Alice: response
@enduml
```

## 图后面还有正文

图表被当成「中心内容」，所以它会独占一页——后面的段落不该被挤到同一页上。
