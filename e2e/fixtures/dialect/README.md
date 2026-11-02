# 方言语料（marktext ↔ md2slides 共享测试输入）

这批 `.md` 是**两个引擎的同一份方言测试输入**：md2slides（本仓，`tools/smoke.js`
的「方言语料」段消费）与 marktext 的 muya（`packages/muya/src/utils/columns/`，
M1 接线时消费）。哪一边改了解析行为、与对方对不上，自己家的测试先红——
「用户混用两个编辑器时行为分叉」是这批语料要消灭的失败模式。

## 语料清单

| 文件 | 锁什么 |
|---|---|
| `cols.md` | `<!-- begin/split/end -->` 三注释分栏：等宽 / 占比（和恰为 100）/ 三栏 / 围栏内字面 |
| `frontmatter.md` | front-matter 八键（title/subtitle/author/date/header/footer/toc/keywords） |
| `slidebreak.md` | 裸 `---` 手写分页符（md2slides 侧切页；muya 侧是普通 thematic break） |

## 语法基准（两侧实现各一份，规则编号一致）

- 分栏：`core/split/cols.js` ↔ `muya utils/columns/syntax.ts`；合法性规则 1–9
  编号两侧一致（8 是 muya 专用的徽标形态）；占比 = 正整数序列且和恰为 100，
  畸形一律降级等宽，宽度绝不猜。
- 分栏标记必须从行首开始独占一行（最多 3 空格缩进）；代码围栏内是字面文本。
- front-matter 必须是文档第一件事（`---` 开闭）；`---` 在正文中 = 分页符。

## 改动规则

- **语料变更 = 方言变更**：先在这里登记，再同步改两侧引擎的断言；单边改语料
  视为破坏契约。
- marktext 侧消费方式（M1 落地）：muya 测试直接引用本目录文件（跨仓同步副本
  亦可，但以本目录为真值源）。
