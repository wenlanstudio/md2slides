"use strict"

/**
 * teaching-fences — md 教学指令规范 v0 的唯一语法实现（md2slides 内部模块）。
 *
 * 为什么语法只允许一份实现（ARCHITECTURE ADR-6/10）：投影引擎（md2slides）
 * 与编辑器渲染（muya，经 md2slides 集成）都从这里拿同一套解析，漂移的后果是
 * 「预览认得出的题，判分认不出」或反之。一致性由 corpus/ 语料兜底：接入方
 * 跑同一份用例。2026-11-08 曾短暂落为独立包，同日并入本仓库（README 有裁决议）。
 *
 * 本模块零运行时依赖、零 md 库依赖：文档级扫描是自写的行状态机，不绑
 * markdown-it——绑定与否是宿主的事（md2slides 在 token 流上用本模块的
 * 参数/答案/前缀原语，wenshu 经引擎拿 scan() 的结构化结果）。
 */

module.exports = {
  // 文档级：一次扫描出全部教学结构与校验结果
  scan: require("./src/scan").scan,
  // 语法常量（宿主据此决定要不要把某个注释/围栏交给本模块）
  COMMAND_VERBS: require("./src/verbs").COMMAND_VERBS,
  FENCE_VERBS: require("./src/verbs").FENCE_VERBS,
  QUIZ_FENCE_VERBS: require("./src/verbs").QUIZ_FENCE_VERBS,
  ASSERT_VERBS: require("./src/verbs").ASSERT_VERBS,
  // 教学围栏的默认节点动作（喂给 md2slides 的围栏策略钩子 fencePolicy）
  FENCE_ACTIONS: require("./src/verbs").FENCE_ACTIONS,
  // 原语级：宿主自己遍历 AST/token 时逐个复用
  parseParams: require("./src/params").parseParams,
  parseCommand: require("./src/command").parseCommand,
  parseFenceInfo: require("./src/fence").parseFenceInfo,
  stripOptionPrefix: require("./src/options").stripOptionPrefix,
  hasPositionDependency: require("./src/options").hasPositionDependency,
  normalizeAnswer: require("./src/answers").normalizeAnswer,
}
