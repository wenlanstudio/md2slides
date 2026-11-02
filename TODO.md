# TODO

已完成的部分不再记录——看 git log 与 CHANGELOG。这里只放**还没做**的，按优先级排。

## 1. Typora 宿主壳（已移出）

因合规评估，Typora 宿主壳已从主仓库移除；代码、设计文档与专属测试已单独备份，后续是否恢复另行评估。

## 2. 回归补强

- [x] **截图对比基线**（2026-10-25）：e2e 内逐页真屏截 → 缩到 640 宽入库
      （e2e/snapshots/shots/，38 张 2.0MB），页内 canvas 逐像素比（通道容差 12、阈值 1%），
      `npm run shot:update` 刷新基线。同机回归——字体度量差异的 caveat 同 IR 快照；
      跨机器（CI 转硬性）仍需先钉字体。
- [ ] "续页表格表头与首页一致"目前只验了 `thead` 存在，没比内容。
- [x] "认输"分支已有 fixture 覆盖（2026-10-25，`e2e/fixtures/oversize.md`），且语义升级
      （用户拍板）：超高图片 → 无标题裸页 + 等比缩放铺满版面；超高段落 → 原位缩字号
      顺排（警告），**均不允许溢出**——详见 PAGINATION.md §5.5。途中修了三个真 bug：
      裸页"（续）"标记段占高度导致缩放永远差一截（扣除非图片内容高度 + 亚像素收敛
      重试）、媒体裸页被 furnitureOnly 卫士误拦（媒体豁免）、原位缩放失败不回滚内联
      样式。markdown data-SVG 图片会被 markdown-it 的 XSS 白名单拒绝（svg 不在
      允许列表），夹具改用真实 PNG。
- [ ] PPTX 成品只验了"形状在画布内"，没验**形状之间不重叠**。
- [ ] design token（字号/行距/字体）没有回归：截图，或钉住若干键值。
- [ ] CI 的 e2e 目前 `continue-on-error`：CI 字体度量与开发机不同，涉及行数的断言可能漂移。
      钉住字体（固定字体 / 快照基线按环境分）后转硬性。

## 3. 功能待接线 / 待定

- [ ] **`splitSemicolons.js`**（「A；B；C。」→ 无序列表）接不接：接了并列短语能**按项**切分，
      代价是文本层改写（不落盘）。倾向接，放在 `renderMarkdown` 之前。
- [x] ~~家具页码与主题 `::after` 占位符二选一~~（2026-10-25 删除旧机制）：`chrome.pageNumber`
      恒为 null 的死代码链（ir.js `pageNumberOf` / schema chrome / design_token
      `pageNumber`+`sldnum_box` / fill_deck `_add_page_number`）全部移除——家具页码走
      IR paragraph 块通道已是正解。若将来要「重排页自动更新」的原生页码，再在 sidecar
      给家具页码文本框写 slidenum 域（当前静态文本 N / M 够用）。
- [x] ~~公式目前栅格成图片（不可编辑）~~（2026-10-30 改为 Office 原生公式）：IR 新增
      `math` 块与 `math` run，带 KaTeX 的 MathML + LaTeX 源码；sidecar 的 `omml.py` 把
      MathML 转成 OMML（优先用 Office 的 `MML2OMML.XSL`，找不到走内置兜底），
      `fill_deck` 挂成 `a14:m > m:oMathPara > m:oMath`——双击可编辑。
- [ ] mermaid 含 `<foreignObject>` 的图（HTML 标签做节点）栅格不出来 → 硬失败。
      要么文档约定"图源别用 HTML 标签"，要么给 foreignObject 补专用栅格路子。
- [ ] 第二套主题（等编排层稳定后再做）。

## 4. 导出（面向不想敲命令的用户）

- [x] **CLI 双通道**（2026-10-25）：`node tools/export.js deck.md -o deck.pptx`
      图片型默认（整页真屏栅格 + pptxgenjs 铺满，零依赖、与放映逐像素一致）；
      `--editable` 走 IR + Python sidecar。人话错误（缺 Python / 目标被占用 /
      内容闸门未过）+ 进度输出 + 临时文件原子写。管线复用 e2e/runner 共享段
      （buildPage / injectRuntime / settleDeck——管线副本是「预览什么样导出就
      什么样」的天敌）。本命令就是编辑器导出菜单的挂载点（marktext 等宿主的菜单项，背后都是它）。
- [x] **`exportPptx` 宿主 API**（编辑器内一键导出，2026-10-30 marktext M0 落地）：
      编辑器内导出按钮背后的后端抽成宿主无关模块 `host/pptx/`——工厂
      `createExporter({ libDir })` 绑宿主资产布局，双通道 + ExportError.code
      （NO_DECK / IR_GATE / PYTHON_MISSING / SIDECAR_FAILED / TARGET_BUSY）+ 原子写
      全在上层；marktext（M1）绑自己的 lib 目录即得同款导出。
- [ ] **可编辑通道去 Python 化**：fill_deck / build_template / design_token
      （~1000 行 Python）移植成 JS（pptxgenjs 行距单位恰是磅，与 IR 的
      lineSpacingPt 天然对齐）。动机是分发：编辑器插件的普通用户装不了 Python。
      ⚠ 那 1000 行是血泪细节集合（spcPts / marL / inset / word_wrap=False /
      _check_fit 自检），逐条翻译，漏一条 Office 破版 bug 回归一批——大工程，
      不排期。
- [ ] **图片通道自动回归**：e2e 里加一条「CLI 出片 + dump_pptx 几何检查」
      （当前双通道为手动验证：demo 9 页 / 771KB，几何零问题）。

## 5. 以后（wishlist）

自动目录页（1–2 级标题）· 分号转列表 · 顿号分词高亮 · 编程语言关键字正文高亮 ·
Deck 模式（点击放大 / 核心滚动 / 文件间跳转）· 自动编号（tech=阿拉伯多级 / 公文=中文层级）·
图表动态特性保留（ECharts 交互、matplotlib 动画）·
衍生型双核心（derive 策略：主核心锚定 + 次核心按条切片，spec 见 v0.1.0 标签前的
README「转换方案」节）· marktext 集成（已完成：fork 的页览/放映/分屏/导出，见其 docs/design/view-model.md）
