# 参与开发

## 环境

- Node.js >= 18（CI 用 20）
- e2e 需要 Chrome / Edge（`CHROME_PATH` 可指定；不下载 Chromium）
- PPTX 成品比对需要 Python + python-pptx（`MD2SLIDES_PYTHON` 指定解释器，缺则跳过）
- PlantUML 图需要 Java 11+ 和 jar：`npm run fetch:plantuml`

## 本地验证

```bash
npm ci
npm run check       # 静态 require 图
npm run smoke       # 解析 / 主题 / 逻辑分页
npm run test:unit   # 单元测试
npm run e2e         # 物理分页 + IR + PPTX（需浏览器）
```

改完 `core/` 后建议跑完整 `npm test`；改 `host/` 前先 `npm run build:host`。
## 提交约定

- 一个提交只做一件事，说明动机和验证方式。
- 不要提交 `host/lib/plantuml.jar`（GPL 二进制，已 gitignore）。
- 设计文档在 `docs/design/`；接口契约以 `docs/API.md` 为准。

## 交流

就事论事、尊重彼此。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。
