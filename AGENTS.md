# Development Rules

This file provides guidance to AI agents when working with code in this repository.

## 人机协作开发协议

- 用户与AI：
  - 双方共同遵循
    - 名正言顺（名正方能言顺：概念正确，理论才正确；命名规范，代码逻辑才能顺畅）
    - 名副其实（名实相符：文档与代码相符、概念与理论相符、变量与代码逻辑相符等）
  - 用户：不断提出新的需求，推动项目演进
  - AI：
    - AI需要拥有独立自主的思想，实事求是、客观中立
    - 不向用户的不合理需求妥协
    - 根据用户需求，捕捉用户的精神状态，如用户词不达意，提醒用户头脑清醒后再下达指令
- AI与文档：用户的文档可能不准确，请仔细甄别，可修改优化文档；
- 文档与设计：名副其实，文档和设计相匹配
  - 文档：
    - 采用合适的结构进行思想陈述
    - 文档言简意赅
  - 设计：
    - 追求规范的项目架构设计
    - 可考虑配以合适的图表
- 设计与开发：
  - 边开发边修改设计
  - 边设计边进行项目重构
- 开发与Bug：不能为了快速修复bug、省事、省时而不断地打补丁；
- Bug与测试：复现 → 根因分析 → 修复 → 回归测试 → 关闭
- 周而复始，直至项目成熟完善

## Project Overview

MD2Slides（`@wenlanstudio/md2slides`）is an editor-independent Markdown → slides/PPTX
engine. **No manual page breaks in the body**: headings cut chapters, content that
doesn't fit is split automatically — tables continue by row (repeated headers),
code by line (continuous numbering), lists by item (numbering continues). Core
content (images, tables, formulas) is guaranteed to stay intact across page breaks.

The pipeline: **parse → logical pagination (sections) → physical pagination
(browser-measured) → compose → frozen Slide IR → PPTX / HTML export**.

- **Version**: see `package.json`
- **License**: MIT
- **Repository**: <https://github.com/wenlanstudio/md2slides>
- **Online demo**: <https://wenlanstudio.github.io/md2slides/>

## Tech Stack

| Layer            | Technology                                        |
| ---------------- | ------------------------------------------------- |
| Language         | JavaScript (CommonJS, `"type": "commonjs"`)       |
| Runtime          | Node.js >= 18                                     |
| Markdown engine  | markdown-it (token-stream based parsing)          |
| Physical measure | Headless browser via `puppeteer-core` (system Chrome) |
| Unit tests       | Node.js built-in test runner (`node --test`)      |
| E2E tests        | Custom runner (`e2e/`) on puppeteer-core + jsdom  |
| PPTX (image)     | pptxgenjs 4                                       |
| PPTX (editable)  | Python sidecar — python-pptx 1.0.2 + lxml        |
| Package manager  | npm (single package, no workspace)                |
| Types            | Hand-written `.d.ts` in `types/`                  |

## Directory Structure

```
<repo-root>/
  index.js                  Public entrypoint (re-exports core pipeline).
  types/                    Ambient .d.ts for the npm package.
  core/                     The pure engine — no host, no browser UI.
    parse/                  frontMatter.js, markdown.js — MD → token stream.
    section.js              Logical pagination: heading-based chapter cutting.
    split/                  Physical split strategies: sectionize, cols,
                            splitSemicolons (code splits by line).
    paginate/               layout-core, overflow, furniture, toc —
                            browser-measured overflow → physical pages.
    compose.js              Page assembly into the final DOM.
    render/                 theme/style/diagram/highlight rendering.
    themes/                 base.css, lecture.css (theme name: lecture),
                            highlight.css.
    quiz/                   parse.js — quiz question parsing. MUST run on the
                            markdown-it token stream as a core rule (rendered
                            comment nodes are lost after sectionize).
    cover.js                Cover page generation.
  kit/                      Framework-agnostic player layer (hosts pick what
                            they need; core stays pure).
    player.js               "How it looks" only: one page per screen, scale
                            fit, navigation, step state. navKey(key) is the
                            SINGLE point of navigation semantics.
    steps.js                Step-splitting legislation (how content is broken
                            into reveal steps); player only applies the result.
    swipe.js                Touch gestures; translates to navKey via SWIPE_KEY.
    lightbox.js             Fullscreen image viewer (zero DOM intrusion —
                            IR / PPTX export are unaffected).
    quiz/                   client.js (WS client) + panel.js (result overlay).
  export/pptx/              PPTX export: ir.js + ir.schema.json (Slide IR),
                            media.js, sidecar/ (Python build_pptx.py for the
                            editable path). See export/pptx/ARCHITECTURE.md.
  host/                     Host glue — how the engine ships to end users.
    browser/                deck-core, echarts/mermaid hosts (standalone web).
    thin/                   Lightweight host (graphviz, plantuml).
    server/                 HTTP server host.
    marktext/               Integration package for marktext / wenlan
                            (deck-full-entry.js, deck.html, dist/ build
                            artifact — git-ignored).
  e2e/                      E2E: check.js (main suite), lightbox-real.js and
                            tap-real.js (real-input regressions), runner,
                            fixtures, snapshots/ (committed baselines),
                            .cache/shots (git-ignored working shots).
  test/unit/                Node --test unit specs.
  tools/                    build-host, check-deps, smoke, export-html,
                            ir-snapshot, shot-update, pack-marktext, etc.
  examples/                 demo.md (feature overview) + quiz-demo.md.
  docs/                     API.md, FRONTMATTER.md, design notes, assets.
  out/, lib/, dist/         Build artifacts (git-ignored).
```

## Development Workflow

```bash
npm install

# Full test suite (what CI runs): unit + check-deps + smoke + quiz-smoke +
# build:host + e2e
npm test

# Individual pieces
npm run test:unit      # unit tests only (node --test)
npm run check          # tools/check-deps.js — bundle dependency audit
npm run smoke          # end-to-end pipeline smoke (parse → paginate → export)
npm run quiz           # quiz parsing / flow smoke
npm run e2e            # browser e2e suite (puppeteer-core, system Chrome)
npm run e2e:lightbox   # lightbox real-input regression (real mouse/wheel)
npm run e2e:tap        # tap real-input regression

# Build / packaging
npm run build:host     # rebuild host dist/ + lib/ + version.json
npm run pack:marktext  # build:host + pack for the marktext integration

# Snapshots / baselines
npm run snapshot        # dump Slide IR snapshot
npm run snapshot:update # update IR snapshot baseline
npm run shot:update     # update screenshot baselines

# HTML export of a markdown file
npm run html
```

## Testing

- Unit tests use the **Node built-in runner**, not Vitest/Jest:
  `npm run test:unit`, single file: `node --test test/unit/<name>.test.js`
- E2E runs against a **real headless browser** (puppeteer-core + system
  Chrome), not a bundled Chromium download.
- **Baseline policy: only trust the local machine.** CI on Ubuntu has font
  drift, so CI skips pixel-comparison segments. After changing themes, font
  sizes, pagination logic, or copy text, you MUST clear `e2e/.cache/shots` and
  refresh `e2e/snapshots/`, then rerun the full e2e round and review.
- Synthetic DOM events (dispatchEvent) cannot catch real interaction bugs —
  pointer capture, hit-target rewrites, stacking-order issues are only visible
  in the `e2e:lightbox` / `e2e:tap` real-input suites. If you touch pointer
  handling, run them.

## Code Style

No ESLint config in this repo; match the existing files.

- CommonJS (`require`/`module.exports`); `"use strict"` at the top of kit files
- **Double quotes only** in source — `check-deps` audits bundle text, and the
  bundler's `JSON.stringify` only escapes double quotes (stray single quotes
  once leaked into dist/ and were mistaken for real dependencies)
- No semicolons, 2-space indentation
- Header comments on every module: one short block stating the module's single
  responsibility and its boundary (what belongs here, what does not). Chinese
  is the working language for comments and docs.
- Comment rule (same as wenlan): a comment must describe what isn't
  obvious from the code — rationale, invariants, ownership. Never restate the
  code or echo words already in the name.
- New files: quote discipline above + keep them listed in `package.json`
  `files` if they ship to npm (or they are intentionally internal).

## Architecture: The Pipeline

```
core/parse       markdown-it → token stream (front matter extracted)
core/section.js  logical pagination: headings cut chapters (no `---` needed)
core/split       split strategies per block type (tables/code/lists/cols)
core/paginate    physical pagination: measure heights in a headless browser
                 (getBoundingClientRect), overflow → continuation pages
core/compose     assemble final page DOM; Slide IR frozen here
export/pptx      IR → pptxgenjs (image deck, no Python) or
                 IR JSON → sidecar/build_pptx.py (editable, needs python-pptx)
kit/*            presentation layer: player, steps, swipe, lightbox, quiz panel
host/*           host glue: browser (web), thin, server, marktext
```

Key layering rules:

- **core stays pure**: no host assumptions, no player UI. kit consumes core's
  DOM; hosts consume kit.
- **Slide IR is frozen** at compose time. Exports (image PPTX, editable PPTX,
  HTML) all derive from the IR — nothing re-measures or re-renders.
- **Steps**: `kit/steps.js` is the only place that decides how content is
  split into reveal steps; `player.js::applySteps` only applies them. Tables
  produce one whole-table step plus one step per data row. Hard constraint:
  **one step shows exactly one highlight frame** — never hang the table frame
  and a row frame on the same step.
- **Navigation**: `player.js::navKey` is the single source of navigation
  semantics; swipe.js maps gestures onto it. Touch containers must declare
  `touch-action` (default `pinch-zoom`) or the browser eats the pan and
  gestures die. Wire exactly one event source (pointer XOR touch) — Chromium
  fires both and double listeners double-flip pages.
- **Quiz**: parse at the markdown-it token-stream level (core rule) →
  `kit/quiz/client.js` + `panel.js` → host glue. Rooms attach via the classbuzz
  room password (`host_attach`), not a host token. The standalone HTML player
  also supports it via URL params `?room=XXXX&pass=YYYY`.
- **Lightbox**: zero DOM intrusion (event delegation on IMG, no attributes
  added), so IR/PPTX export is unaffected. The viewer `<img>` is centered by
  the parent flex box — never `absolute + left/top: 50%` (transform is
  overwritten every frame by `translate(tx,ty) scale(k)`). Pan/zoom math is
  center-origin; layout must keep the untransformed box centered or the math
  breaks. Do not use `setPointerCapture` for dragging (it rewrites pointerup
  and click targets). Transformed elements create stacking contexts — give the
  toolbar an explicit z-index.

## Important Notes

- **`host/marktext/dist/`, `lib/`, `out/` are build artifacts** (git-ignored).
  Changing `kit/`, `host/`, or `core/` requires `npm run build:host` before
  hosts pick it up; never hand-edit dist/ output.
- **Typora shell is NOT in this repo** (removed for EULA compliance). Don't
  reference `host/typora/` — it no longer exists here.
- **check-deps** (`npm run check`) is part of `npm test`: it audits that the
  bundled host output doesn't reference undeclared dependencies. If it fails,
  fix the source or the bundle, don't skip the check.
- **Editable PPTX needs Python**: the sidecar uses python-pptx 1.0.2 + lxml
  (Anaconda). Hosted Python 3.13 lacks lxml and is not usable for this path.
  The image PPTX path (pptxgenjs) needs no Python at all.
- **pptxgenjs in Node needs its full dependency closure** (jszip etc.).
  `build-host.js` copies the whole dep tree into `lib/pptxgenjs/node_modules`;
  the marktext packer only ships SHELL_FILES + dist + lib, so node_modules
  must come from the build, never assumed present.
- **examples/demo.md conventions**: demo = feature overview; the body must NOT
  contain manual `---` page breaks (pagination is the engine's job).
- **Windows packaging**: when packaging Electron hosts on Windows, set
  `ELECTRON_MIRROR` and `ELECTRON_BUILDER_BINARIES_MIRROR` (electron-builder
  times out hitting GitHub directly).
- **Don't trust the docs blindly**: sub-project docs go stale; verify claims
  against the code before acting on them.

## Contribution

- Repository: <https://github.com/wenlanstudio/md2slides> (single `main`
  branch; the npm package `@wenlanstudio/md2slides` is not yet published).
- Run `npm test` before submitting.
- Keep `docs/` in sync with the code — 名副其实.
