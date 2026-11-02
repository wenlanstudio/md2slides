"use strict"

/**
 * browser.js — 找一台能用的 Chromium，开一个 headless 页面。
 *
 * 用 `puppeteer-core` 而不是 `puppeteer`：后者装的时候要下一整个 Chromium（上百 MB，
 * 还常常卡在下载上），而机器上本来就装着 Chrome / Edge。`core` 不自带浏览器，
 * 只负责连上去——路径找不到就用 `CHROME_PATH` 指一下。
 *
 * 物理分页得在真浏览器里验，是因为它读的是 `getBoundingClientRect()`：jsdom 没有布局
 * 引擎，量出来全是 0，分页逻辑连"这一页溢出了没有"都判断不了。
 */

const fs = require("fs")
const path = require("path")
const { pathToFileURL } = require("url")
const puppeteer = require("puppeteer-core")

/** 常见安装位置。前两个是 Windows，后两个给 Linux / macOS 留着。 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

/**
 * 挑第一台真实存在的浏览器。
 * @returns {string} 绝对路径
 */
const findChrome = () => {
  const found = CANDIDATES.filter(Boolean).find(p => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
  if (!found) {
    throw new Error(
      "找不到 Chrome / Edge。装一个，或者把路径指出来：\n" +
        "  set CHROME_PATH=D:\\...\\chrome.exe    (PowerShell: $env:CHROME_PATH=...)",
    )
  }
  return found
}

/**
 * 开一个 headless 浏览器。
 * @param {object} [opts]
 * @param {string} [opts.executablePath] 不传就自动找
 * @param {boolean} [opts.headless]      默认 true
 * @param {string[]} [opts.args]         追加的启动参数
 */
const launch = (opts = {}) =>
  puppeteer.launch({
    executablePath: opts.executablePath ?? findChrome(),
    headless: opts.headless ?? true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // 关掉字体 hinting 的差异，免得同一份文档在不同机器上量出几像素出入。
      "--font-render-hinting=none",
      // 页面是 file:// 的，还要读同目录的 KaTeX 字体。
      "--allow-file-access-from-files",
      ...(opts.args ?? []),
    ],
  })

/** 本地文件 → `file://` URL。`goto` 需要它，相对路径（KaTeX 字体）才解析得到。 */
const fileUrl = file => pathToFileURL(path.resolve(file)).href

module.exports = { launch, findChrome, fileUrl }
