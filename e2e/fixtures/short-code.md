---
title: pandas 入门
theme: lecture
paginate: true
stepLines: true
---

# 两栏活格（python short）

先加载数据，再看形状——每行一步，Enter 执行，结果落进右栏。

```python short
import pandas as pd
df = pd.read_csv("scores.csv")
df.head()
df["总分"] = df.sum(axis=1)
df.sort_values("总分", ascending=False).head()
```

## 行数帽之外

超过 12 行的 short 块自动回退普通代码块（两栏只收短 demo）。

```python short
x = 1
x = 2
x = 3
x = 4
x = 5
x = 6
x = 7
x = 8
x = 9
x = 10
x = 11
x = 12
x = 13
```

## 非 short 的普通块

同一页里不带修饰词的 python 块保持原样。

```python
print("普通块不两栏")
```
