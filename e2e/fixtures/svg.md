---
headingDivider: 3
paginate: true
title: SVG 围栏回归
---

这一份验「手写 SVG 走图表围栏」：页面侧预通行把 svg 围栏栅格成 2x PNG，
分页才会把它当**图片核心**保护，IR 与可编辑 PPTX 也才拿得到 .png 媒体。
不要把 SVG 写成正文里的内联标签或外链图片——那两种在导出环节会断链。

## viewBox 定尺寸（推荐）

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120">
  <rect x="2" y="2" width="236" height="116" rx="14" fill="#FDFAF3" stroke="#1A1A1C" stroke-width="4"/>
  <circle cx="80" cy="60" r="34" fill="#D85A30"/>
  <rect x="140" y="30" width="70" height="60" rx="8" fill="#1D9E75"/>
</svg>
```

## 数值宽高定尺寸

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect width="200" height="100" fill="#1A1A1C"/>
  <circle cx="100" cy="50" r="36" fill="#FDFAF3"/>
  <circle cx="100" cy="50" r="16" fill="#D85A30"/>
</svg>
```

## 与文字同页

图片核心可以带一段引导语；分页会保证它不被拆成两半。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 80">
  <rect x="4" y="4" width="152" height="72" rx="8" fill="#EEEDFE" stroke="#534AB7" stroke-width="3"/>
  <text x="80" y="48" text-anchor="middle" font-size="18" fill="#26215C">SVG</text>
</svg>
```
