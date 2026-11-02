"use strict"

/**
 * tap-entry.js — 只给 e2e/tap-real.js 用的极小入口。
 *
 * 不比 `entry.js`：那份挂着一整队分页 / IR / 快照探针，重且与本测试无关。
 * 这里只把播放器递到 window 上，让 puppeteer 能在页面里读 index / step。
 */

const { createDeckPlayer } = require("../kit/player")

module.exports = { createDeckPlayer }
