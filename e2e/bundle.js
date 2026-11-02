"use strict"

/**
 * bundle.js — 把 `core/` 的 CommonJS 模块搬进浏览器。
 *
 * 为什么不引打包器：`core/` 是一张**静态的、只有相对 require** 的 CommonJS 图
 * （`tools/check-deps.js` 天天在守着这件事）。既然如此，为一次 e2e 拖进 esbuild 就
 * 不值：把源码按原样塞进页面，再配一个几十行的 `require` 实现即可。
 * 附带的好处更重要——浏览器里跑的是**与 Node 侧逐字相同的源码**，
 * 不经转译，也就不存在"打包后行为变了"这类说不清的偏差。
 *
 * `core/` 之外的依赖（`fs` / `path` / `lib/highlight.min.js`）不打包，登记成 external，
 * 由页面在注入前挂到 `window.__md2slides_externals` 上（见 `e2e/externals.js`）。
 *
 * Usage:  const script = bundleScript(require.resolve("./entry"))
 *         await page.addScriptTag({ content: script })
 *         await page.evaluate(() => { window.md2slides = installMd2slides(window.__md2slides_externals) })
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")

/** 与 `check-deps.js` 同一条正则：只认相对路径的静态 require。 */
const RE_REQUIRE = /require\(\s*(["'])(\.[^"']+)\1\s*\)/g

/** CommonJS 解析，缩到本仓库用到的那几种写法。 */
const resolveSpec = (fromDir, spec) => {
  const base = path.resolve(fromDir, spec)
  return [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")].find(
    c => fs.existsSync(c) && fs.statSync(c).isFile(),
  ) ?? null
}

const posix = p => p.split(path.sep).join("/")
const relOf = file => posix(path.relative(ROOT, file))

const DEFAULT_ROOTS = ["core", "export", "e2e", "kit", "host/browser"]

/**
 * 默认范围：`core/`、`export/`、`e2e/`、`kit/`，外加 `host/browser/`——浏览器侧图表
 * 渲染器（mermaid/echarts）住在那儿，e2e 经 `pageDiagram.js` 等 shim 共用同一份
 * （图表渲染渠道归 host，壳与回归不许两份实现）。
 *
 * 宿主壳（`tools/build-host.js`）要把仓库根 `index.js` 也打进去（公开 API 面），
 * 传 `sourceRoots` 覆盖即可。`lib/` 下的发行版（hljs 等）永远走 external。
 *
 * @param {string} file
 * @param {string[]} [roots] 参与打包的顶层源码根（相对 ROOT 的路径或文件名）
 */
const isSource = (file, roots = DEFAULT_ROOTS) => {
  const rel = relOf(file)
  if (rel.startsWith("..")) return false
  return roots.some(root => rel === root || rel.startsWith(`${root}/`))
}

/**
 * 从入口出发收集整个模块图。
 *
 * @param {string} entryFile 入口文件的绝对路径
 * @param {object} [opts]
 * @param {string[]} [opts.sourceRoots] 参与打包的顶层源码根，默认 DEFAULT_ROOTS
 * @returns {{ entry: string, modules: Record<string, {src: string, dir: string, deps: object}> }}
 */
const buildBundle = (entryFile, { sourceRoots } = {}) => {
  const modules = {}
  const queue = [path.resolve(entryFile)]

  while (queue.length) {
    const file = queue.shift()
    const id = relOf(file)
    if (modules[id]) continue

    const src = fs.readFileSync(file, "utf8")
    const deps = {}
    for (const match of src.matchAll(RE_REQUIRE)) {
      const spec = match[2]
      const target = resolveSpec(path.dirname(file), spec)
      if (!target) continue // 断链由 check-deps 负责报，这里只管打包
      const tid = relOf(target)
      deps[spec] = isSource(target, sourceRoots) ? tid : `ext:${tid}`
      if (isSource(target, sourceRoots) && !modules[tid]) queue.push(target)
    }
    // 先占位再解析，循环依赖时不会无限入队。
    modules[id] = { src, dir: posix(path.dirname(id)), deps }
  }

  return { entry: relOf(path.resolve(entryFile)), modules }
}

/**
 * 产出可直接 `addScriptTag` 的脚本。
 *
 * `</script` 必须转义：脚本内容是嵌在 HTML 的 script 标签里下去的，
 * 源码里只要出现一次这个串，后面的内容就全被当成 HTML 文本了。
 *
 * @param {string} entryFile 入口文件的绝对路径
 * @param {object} [opts] 同 `buildBundle`
 */
const bundleScript = (entryFile, opts) => {
  const bundle = buildBundle(entryFile, opts)
  const json = JSON.stringify(bundle).replace(/<\/script/gi, "<\\/script")
  return LOADER.replace("__BUNDLE__", () => json)
}

/**
 * 浏览器端的 loader。刻意保持朴素：没有循环检测、没有动态 require、没有 ESM——
 * `core/` 用不到，`require` 不到的地方直接抛，比悄悄返回 undefined 好查。
 */
const LOADER = `
window.__md2slides_bundle = __BUNDLE__;
window.installMd2slides = function (externals) {
  var B = window.__md2slides_bundle;
  var cache = Object.create(null);

  function req(id) {
    if (id.slice(0, 4) === "ext:") {
      var key = id.slice(4);
      if (!externals || !(key in externals)) {
        throw new Error('e2e bundle: 缺少 external "' + key + '"（页面没加载它？）');
      }
      return externals[key];
    }
    if (cache[id]) return cache[id].exports;

    var m = B.modules[id];
    if (!m) throw new Error('e2e bundle: 没有模块 "' + id + '"');
    var mod = { exports: {} };
    cache[id] = mod;
    new Function("module", "exports", "require", "__dirname", "__filename", m.src)(
      mod,
      mod.exports,
      function (spec) { return req(m.deps[spec] || "ext:" + spec); },
      m.dir,
      id
    );
    return mod.exports;
  }

  return req(B.entry);
};
`

module.exports = { buildBundle, bundleScript, LOADER }
