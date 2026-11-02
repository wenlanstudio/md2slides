"use strict";

/**
 * mermaidHost.js — 实现已移到 `host/browser/mermaidHost.js`（图表渲染渠道归 host，
 * 壳与 e2e 共用同一份；两份实现必然漂移）。这里留转发，e2e 内的 require 面不变。
 */

module.exports = require("../host/browser/mermaidHost")
