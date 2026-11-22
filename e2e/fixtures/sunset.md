---
headingDivider: 3
paginate: true
theme: sunset
title: 热带日落主题回归
keywords: 热带日落, 每级一色, 热血橙蓝
---

这一份专打 `theme: sunset` 主题本身的视觉回归：日落奶白底、每级标题一色
（h1 火焰橙红 + 深红海平线 / h2 深海蓝 / h3 孔雀青 / h4-h6 蓝灰）、蓝表头、
孔雀青行内码、彩色 hljs 配色。结构与度量沿用 lecture——同一份文档两套主题
页数一致，切主题不会让页码漂移。

## 第一章 标题梯与文字

正文深板岩灰 **火焰红加粗强调**、*橙红斜体*、行内代码 `matplotlib` 和
[青蓝链接](https://example.com)。关键词高亮走 mark 通道：subplot 与
Axes 对象应该与加粗同款火焰红。

### 1.1 四级及以下

#### 四级标题蓝灰

四级及以下同一色，只靠字号区分层级。列表的颜色跟随正文：

- 折线图看趋势
- 柱状图比大小
- 散点图看分布

> 引用块：橙左边 + 浅橙底，像日落余晖落在纸面上。行内代码 `plt.show()`
> 跟随引用配色，不是正文里的孔雀青。

## 第二章 表格与代码

### 2.1 表格

橙红表头配白字，投影仪上对比最稳；斑马纹是浅橙白。

| 函数 | 用途 | 返回 |
| --- | --- | --- |
| plt.plot | 折线图 | Line2D |
| plt.bar | 柱状图 | BarContainer |
| plt.scatter | 散点图 | PathCollection |

### 2.2 代码块（短码放大）

```python
import matplotlib.pyplot as plt
```

<=4 行的短码走 .bigcode 放大链（--fs-code-short），与 lecture 同规。

### 2.3 长代码块（hljs 彩色配色）

```python
import matplotlib.pyplot as plt

# 落日坠海：火焰红 -> 橙 -> 孔雀青
colors = ["#e53935", "#f4511e", "#00897b"]
for i, c in enumerate(colors):
    plt.bar(i, (i + 1) * 2, color=c)
plt.title("热带日落")
plt.show()
```

注释应显示暖灰斜体、字符串孔雀青、关键字火焰红、函数名深海蓝——
彩色 hljs 配色是这套主题唯一整套重画的部分。
