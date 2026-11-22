# 第三方组件

本仓库自身以 MIT 发布（见 [LICENSE](LICENSE)）。以下组件随仓库或 npm 包分发，
版权归各自作者，许可如下。

| 组件 | 版本 | 许可 | 上游 |
|---|---|---|---|
| mermaid | bundled（`host/lib/mermaid.min.js`） | MIT | https://github.com/mermaid-js/mermaid |
| Apache ECharts | 6.1.0 | Apache-2.0 | https://github.com/apache/echarts |
| Vega | bundled（`host/lib/vega.min.js`） | BSD-3-Clause | https://github.com/vega/vega |
| Vega-Lite | bundled（`host/lib/vega-lite.min.js`） | BSD-3-Clause | https://github.com/vega/vega-lite |
| vega-embed | bundled（`host/lib/vega-embed.min.js`） | BSD-3-Clause | https://github.com/vega/vega-embed |
| flowchart.js | bundled（`host/lib/flowchart.min.js` 内） | MIT | https://github.com/adrai/flowchart.js |
| Raphael（`host/lib/flowchart.min.js` 内） | 2.3.0 | MIT | https://github.com/DmitryBaranovskiy/raphael |
| js-sequence-diagrams（vendored snap.svg 版） | 2.0.1 | BSD-2-Clause | https://github.com/bramp/js-sequence-diagrams |
| snap.svg-cjs + eve | bundled（`lib/sequence.min.js` 内） | Apache-2.0 / MIT | https://github.com/adobe-webplatform/Snap.svg |
| underscore + webfontloader（`lib/sequence.min.js` 内） | bundled | MIT / Apache-2.0 | https://github.com/jashkenas/underscore |
| danielbd 字体（`host/lib/sequence-fonts/`） | bundled | 免费使用（js-sequence-diagrams 附带） | https://github.com/bramp/js-sequence-diagrams |
| wavedrom | bundled（`host/lib/wavedrom.min.js`） | MIT | https://github.com/drom/wavedrom |
| Chart.js | bundled（`host/lib/chart.umd.min.js`） | MIT | https://github.com/chartjs/Chart.js |
| abcjs | bundled（`host/lib/abcjs-basic-min.js`） | MIT | https://github.com/paulrosen/abcjs |
| KaTeX | 0.16.47 | MIT | https://github.com/KaTeX/KaTeX |
| KaTeX 字体（`lib/katex/fonts/`） | 0.16.47 | SIL OFL 1.1 | https://github.com/KaTeX/KaTeX |
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
