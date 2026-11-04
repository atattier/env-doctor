#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runAllChecks } from "../src/doctor.js";
import { renderTerminalReport, renderJsonReport } from "../src/report.js";

const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  dir: null,
  timeoutMs: 8000,
};

const dirIdx = args.indexOf("--dir");
if (dirIdx >= 0 && args[dirIdx + 1] && !args[dirIdx + 1].startsWith("--")) {
  flags.dir = args[dirIdx + 1];
}
if (!flags.dir) flags.dir = process.cwd();

const timeoutIdx = args.indexOf("--timeout");
if (timeoutIdx >= 0 && args[timeoutIdx + 1]) {
  const n = Number(args[timeoutIdx + 1]);
  if (Number.isFinite(n) && n > 0) flags.timeoutMs = n * 1000;
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`env-doctor — Node.js/pnpm/Git 开发环境体检

用法:
  env-doctor [选项]

选项:
  --json           以 JSON 输出（便于 CI / 脚本消费）
  --dir <path>     指定项目目录（检查 lockfile / .npmrc），默认当前目录
  --timeout <sec>  网络类检查的超时秒数，默认 8
  -v, --version    显示版本号
  -h, --help       显示本帮助

检查项:
  1  Node.js 版本与支持状态          6  双层代理配置（git config + 环境变量）
  2  包管理器（npm/pnpm/yarn）       7  NO_PROXY 是否排除当前 registry
  3  当前 registry 连通性            8  lockfile 与 package.json 一致性
  4  镜像同步滞后检测（对照官方源）   9  项目路径含中文/空格
  5  .npmrc scope 源覆盖             10  Git 可用性与用户配置`);
  process.exit(0);
}

const report = await runAllChecks({ dir: flags.dir, timeoutMs: flags.timeoutMs });

if (flags.json) {
  console.log(renderJsonReport(report));
} else {
  console.log(renderTerminalReport(report));
}

process.exit(report.summary.fail > 0 ? 1 : 0);
