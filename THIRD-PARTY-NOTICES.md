# 第三方组件

本仓库自身以 MIT 发布（见 [LICENSE](LICENSE)）。以下组件随仓库或 npm 包分发，
版权归各自作者，许可如下。

| 组件 | 版本 | 许可 | 上游 |
|---|---|---|---|
| mermaid | bundled（`host/lib/mermaid.min.js`） | MIT | https://github.com/mermaid-js/mermaid |
| Apache ECharts | 6.1.0 | Apache-2.0 | https://github.com/apache/echarts |
| KaTeX（含 `lib/katex/fonts/`） | 0.16.47 | MIT | https://github.com/KaTeX/KaTeX |
| markdown-it | 14.3.2 | MIT | https://github.com/markdown-it/markdown-it |
| highlight.js | 11.9.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| html-to-image | 1.11.13 | MIT | https://github.com/bubkoo/html-to-image |
| PptxGenJS | 4.0.1 | MIT | https://github.com/gitbrent/PptxGenJS |
| JSZip（PptxGenJS bundle 内） | bundled | MIT 或 GPL-3.0-or-later | https://github.com/Stuk/jszip |

> mermaid / PptxGenJS 是打包产物，内含其上游依赖（d3、dagre、JSZip 等）；完整许可与
> 版权声明见各上游仓库的 LICENSE / NOTICE。各组件均保留其原始版权与许可声明。

## PlantUML

`plantuml.jar` **不在本仓库中**。需要 PlantUML 图时运行：

```bash
npm run fetch:plantuml
```

该命令从 Maven Central 下载未经修改的官方二进制到 `host/lib/plantuml.jar`（已 gitignore）。
PlantUML 以 **GPL-3.0** 发布，源码与许可见上游：
https://github.com/plantuml/plantuml

如果你把该 jar 再分发出去，需要同时遵守 GPL-3.0。
