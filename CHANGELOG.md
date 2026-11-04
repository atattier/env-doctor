# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-11-05

对标同类工具（npm doctor / envinfo / node-environment-check）后的第一次升级。

### 新增

- 4 个新检查项（共 14 项）：
  - `node-installations` — PATH 上多版本 Node 共存检测
  - `npm-strict-ssl` — `strict-ssl=false` 判失败，建议改用 `NODE_EXTRA_CA_CERTS`
  - `proxy-consistency` — git / HTTP_PROXY / HTTPS_PROXY 端点一致性对照
  - `disk-space` — 目标卷剩余空间（<5 GB 告警，<1 GB 失败）
- CLI 选项：`--only <ids>`、`--skip <ids>`、`--offline`、`--report <file>`、`--list`；未知检查 id 报错并以退出码 2 结束
- `node-version` 改用真实 Node LTS 生命周期表（`NODE_EOL`），输出官方支持截止日期

### 变更

- 检查项由串行改为**并行执行**，整轮体检耗时明显下降（结果仍按声明顺序输出）
- 报告 `meta` 新增 `offline`、`durationMs` 字段

### 修复

- Node 18 / 20 已过官方 EOL（2025-04 / 2026-04），旧逻辑「≥18 即通过」不再如实反映，现按 EOL 表判 fail

## [0.1.0] — 2026-11-04

- 首版：10 项检查、终端/JSON 双输出、CI（Ubuntu/Windows × Node 18/20/22）
