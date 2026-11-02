# 安全策略

## 报告问题

请通过 GitHub 的 [Security Advisories](https://github.com/wenlanstudio/md2slides/security/advisories/new)
私密报告，不要开公开 issue。请附复现步骤、影响版本和可能的缓解方式。

## 已知边界

- 放映的「投屏」功能会在 `0.0.0.0` 起一个本地 HTTP 服务，**默认没有访问控制**，
  设计前提是局域网可信。要暴露到公网，请自行加反向代理、鉴权或防火墙。
- `/f?p=` 只服务白名单目录，字体只服务 KaTeX 字体目录；不要把它当通用文件服务器。
- deck 里的**可执行代码块**（`python` / `bash` / `powershell` / `hive` / `mysql`）在放映时
  点击 ▶ 会真的在本机执行；ECharts 的 option 也会用 `new Function` 求值。不要打开或放映
  来源不可信的 deck。
