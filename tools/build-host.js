"use strict"

/**
 * build-host.js — 为 marktext 形态产出 deck-full bundle。
 *
 * Typora 宿主壳已移出主仓库（合规评估，代码见独立备份）；本脚本只保留
 * marktext deck-full 的构建：渲染进程全沙箱，compose 也在页面里跑。
 * 产物：host/marktext/dist/deck-full.js（由 tools/pack-marktext.js 打进资产包）。
 */

const fs = require("fs")
const path = require("path")
const { buildBundle } = require("../e2e/bundle")

const ROOT = path.resolve(__dirname, "..")
const MDIST = path.join(ROOT, "host", "marktext", "dist")

const PAGE_LOADER = `
window.__md2slides_externals = window.__md2slides_externals || {
  fs: {
    readFileSync: function () {
      throw new Error("md2slides deck-page: 浏览器里没有 fs（样式应由父侧 compose 拼好带进来）");
    },
    existsSync: function () { return false; },
  },
  path: {
    sep: "/",
    resolve: function () {
      return Array.prototype.filter.call(arguments, Boolean).join("/").replace(/\\/+/g, "/");
    },
    join: function () {
      return Array.prototype.filter.call(arguments, Boolean).join("/").replace(/\\/+/g, "/");
    },
    dirname: function (p) { return String(p).split("/").slice(0, -1).join("/") || "."; },
    basename: function (p, ext) {
      var base = String(p).split("/").pop() || "";
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
  },
  "lib/highlight.min.js": window.hljs,
};
window.installMd2slidesDeck = function (externals) {
  var modules = __BUNDLE__.modules;
  var cache = Object.create(null);

  function extReq(key) {
    if (externals && Object.prototype.hasOwnProperty.call(externals, key)) return externals[key];
    throw new Error("md2slides deck-page: 缺少 external " + key + "（页面没加载它？）");
  }

  function req(id) {
    if (id.slice(0, 4) === "ext:") return extReq(id.slice(4));
    if (cache[id]) return cache[id].exports;
    var m = modules[id];
    if (!m) throw new Error("md2slides deck-page: 没有模块 " + id);
    var mod = { exports: {} };
    cache[id] = mod;
    new Function("module", "exports", "require", "__dirname", "__filename", m.src)(
      mod,
      mod.exports,
      function (spec) { return req(m.deps[spec] || ("ext:" + spec)); },
      m.dir,
      id
    );
    return mod.exports;
  }

  return req(__BUNDLE__.entry);
};
window.installMd2slidesDeck(window.__md2slides_externals);
`

const main = () => {
  fs.rmSync(MDIST, { recursive: true, force: true })
  fs.mkdirSync(MDIST, { recursive: true })

  const entry = path.join(ROOT, "host", "marktext", "deck-full-entry.js")
  const out = path.join(MDIST, "deck-full.js")
  const bundle = buildBundle(entry, {
    sourceRoots: ["core", "export", "kit", "host/browser", "host/marktext", "lib"],
  })
  fs.writeFileSync(out, PAGE_LOADER.replace(/__BUNDLE__/g, () => JSON.stringify(bundle)), "utf8")
  const kb = (fs.statSync(out).size / 1024).toFixed(0)
  console.log("  ok    " + path.relative(ROOT, out) + "  " + Object.keys(bundle.modules).length + " 模块 / " + kb + " KB")
}

main()
