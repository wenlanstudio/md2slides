---
title: 公式导出回归
book: 回归夹具
---

## 行内公式 $V_t = f(S_t)$

度量 $V_t$ 是状态 $S_t$ 的函数，回归式 $\hat{y} = \beta_0 + \beta_1 x$，误差 $\varepsilon \sim \mathcal{N}(0, \sigma^2)$。

## 列表与表格里的行内公式

- 采样点 $t$ 上的取值 $V_t$
- 半可加度量跨时间相加 $\sum_{t} V_{t}$ 没有意义
- 中文混排：$\text{期末余额} \ge 0$

| 项 | 记号 |
| --- | --- |
| 状态度量 | $V_t$ |
| 事件度量 | $\Delta V_t$ |

## 块级公式

$$
\sum_{t} V_{t} \neq V_{\text{期末}}
$$

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

$$
\binom{n}{k} = \frac{n!}{k! \, (n-k)!}
$$

$$
\left( \int_{0}^{1} x^2 \, dx \right) = \frac{1}{3}
$$

$$
\begin{pmatrix} a & b \\ c & d \end{pmatrix}
$$

以上公式在可编辑 PPTX 里应当是 Office 原生公式（双击可改），不是图片、也不是 LaTeX 字符串。
