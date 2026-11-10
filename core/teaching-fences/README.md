# core/teaching-fences

md 教学指令规范 v0 的**唯一语法实现**（md2slides 内部模块）：注释标记族 + 载荷围栏族 + 一致性测试语料。

权威出处：`wenshu-server/docs/TEACHING-SPEC.md`（语法规范）、`wenshu-server/docs/QUESTION-BANK.md`（归属与入库）、生态根 `ARCHITECTURE.md`（ADR-6/10：教学语法一份实现，Java 端零 md 解析）。**语法以 SPEC 为准，实现与 SPEC 不符以代码为准**（SPEC 约定）。

> 2026-11-08 裁决：曾短暂落为独立包（`@wenlanstudio/teaching-fences`），因功能面小、
> 且文览本就整体集成 md2slides（独立包省不掉任何依赖），并入本仓库降为内部模块；
> 「语法一份实现」的架构约束（ADR-6）不变。

## 谁消费它

| 消费方 | 用途 | 方式 |
| --- | --- | --- |
| md2slides 自身（投影引擎） | 解析节点规则钩子、派生按行区间删；```` ```quiz ```` 在 token 流展开 + 二次解析（`core/quiz/fence.js`） | `require("../teaching-fences")` |
| muya（文览渲染器） | 教学指令渲染为块级控件 | 经 md2slides 集成（文览整体打包 md2slides） |
| 文枢 wenshu | **不直接依赖**——发布校验、拆题、派生都调引擎拿结构化结果 | 间接 |

## 语法一句话

**指令 = 注释行，秘密载荷 = 围栏块；题目两轨**（注释行或 ```` ```quiz ```` 题面围栏）。
2026-11-10 起题目增围栏形态：块体是题面 Markdown，二次解析后公式/加粗/代码照常渲染；
与注释族归一成同一份 quiz 结构，旧讲义零迁移。题面围栏**不是**载荷围栏（不进 hide 表）。

````markdown
<!--quiz id=q1 type=single answer=B point=3-->
1 + 1 = ?

- 1
- 2

```quiz id=q2 answer=A point=5
求 $\sum_{i=1}^n i$？

- 1
- 2
```

<!--step id=s1 name="编写 Mapper" point=7-->

```check-code path=.mdjob/src/WordCountMapper.java mode=loose
// 参考答案（载荷，学生版整块删除）
```
````

注释标记：`quiz` / `step` / `fill` / `check-file`；载荷围栏：`check-code` / `match-output` /
`sql-result`；题面围栏：`quiz`（`QUIZ_FENCE_VERBS`，与 `FENCE_VERBS` 分家）。
参数双形式：JSON 完整版优先、`key=val` 简写退回；都读不出**原样保留**并报 problem
（不静默吞笔误）。

## API

```js
const { scan, parseParams, stripOptionPrefix, normalizeAnswer,
        COMMAND_VERBS, FENCE_VERBS, QUIZ_FENCE_VERBS, FENCE_ACTIONS } =
  require("../teaching-fences")   // 包外经 @wenlanstudio/md2slides 深路径亦可

const result = scan(mdText, { requireIds: true })   // 发布校验用；纯抢答讲义省 id 可不传
```

`scan()` 一次扫描返回（行号均 1 基）：

| 字段 | 内容 |
| --- | --- |
| `marks` | 全部教学注释标记 `{verb, params, line, raw}` |
| `fences` | 教学**载荷**围栏 `{verb, params, body, lineStart, lineEnd}`（普通代码块与题面围栏都不进）；`[lineStart,lineEnd)` 是 1 基半开区间，**含闭合行**，派生按行整块删 |
| `quizzes` | 组装完的题（**两轨归一**）：`{id, type, answer, point, limit, shuffle, stem, options:[{text, letter}], line, source, lineStart, lineEnd}`；`answer` 归一为 0 基序号 / 序号数组（multi）/ 文本（fill）。`source = "comment" \| "fence"`；围栏题的 `[lineStart,lineEnd)` 含闭合行，注释题为 `null` |
| `steps` | `{id, name, point, line, asserts:[所属断言围栏]}` |
| `fills` | `{id, min, max, line, contentLines}`（作答区行区间） |
| `problems` | 校验失败 `{code, line, message, verb?}`——任一命中即拒发（SPEC §六） |
| `warnings` | 提示级 `{code, line, message}`（W1 位置依赖选项等），显示但不拒发 |

frontmatter 块（文档头 `---` 围栏）整块跳过——fm 教学字段（course/chapter）的提取与校验归 wenshu，不在本包。

## v0.1 边界

- 只认 ` ``` ` 围栏（md2slides 语感），`~~~` 不认——题面围栏同理；` ```quiz ` 未闭合报 `QUIZ_FENCE_UNCLOSED`（题面会一路吃到文末，宁拒发也不猜）。
- 非白名单动词的注释（如分栏标记）一律当普通注释跳过；「教学动词拼错」的侦测留给接入方语境（v0.2 再议，SPEC §六#5 的引擎侧实现细化）。
- 班级级选项乱序的**排列生成**不在此包（属发题逻辑，M2b 落在 wenshu 与放映页两端共用的地方）；本包只负责 `shuffle` 开关的解析与 W1 提示。
- 一致性语料在 `corpus/cases/`（每用例一对 `.md` + 期望 `.json`）；`core/quiz/parse.js` 接入原语时**跑同一份语料**，保证「预览什么样，判分就什么样」。

## 开发

```bash
npm run test:teaching   # node --test（零依赖，Node ≥18）；已串进 npm test 总链
```
