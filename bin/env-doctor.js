#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { runAllChecks, selectChecks } from "../src/doctor.js";
import { checks } from "../src/checks.js";
import { renderTerminalReport, renderJsonReport } from "../src/report.js";

const args = process.argv.slice(2);

function readFlagValue(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} 需要一个值`);
    process.exit(2);
  }
  return value;
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes("--list")) {
  for (const c of checks) {
    console.log(`${c.id.padEnd(24)} ${c.title}`);
  }
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`env-doctor — Node.js/pnpm/Git 开发环境体检

用法:
  env-doctor [选项]

选项:
  --json            以 JSON 输出（便于 CI / 脚本消费）
  --dir <path>      指定项目目录（检查 lockfile / .npmrc），默认当前目录
  --timeout <sec>   网络类检查的超时秒数，默认 8
  --only <ids>      只跑指定检查项（逗号分隔 id，见 --list）
  --skip <ids>      跳过指定检查项（逗号分隔 id）
  --offline         离线模式：跳过所有网络类检查
  --report <file>   把 JSON 报告写入文件（stdout 仍按原样输出）
  -v, --version     显示版本号
  -h, --help        显示本帮助

检查项（env-doctor --list 查看完整 id 与标题）:
   1  Node.js 版本与 EOL 支持状态     8   双层代理配置（git config + 环境变量）
   2  Node 多版本共存                 9   代理端点一致性
   3  包管理器（npm/pnpm/yarn）      10   NO_PROXY 是否排除当前 registry
   4  当前 npm registry 连通性        11  lockfile 与 package.json 一致性
   5  镜像同步滞后检测                12  磁盘剩余空间
   6  .npmrc scope 源覆盖             13  项目路径含中文/空格
   7  npm TLS 校验（strict-ssl）      14  Git 可用性与用户配置

退出码: 0 全部通过/警告，1 存在 fail 项，2 用法错误`);
  process.exit(0);
}

const only = readFlagValue("--only");
const skip = readFlagValue("--skip");
const { unknown } = selectChecks({ only, skip });
if (unknown.length > 0) {
  console.error(`未知的检查项 id：${unknown.join(", ")}（用 --list 查看全部）`);
  process.exit(2);
}

const flags = { json: args.includes("--json"), dir: null, timeoutMs: 8000 };
flags.dir = readFlagValue("--dir") ?? process.cwd();

const timeoutValue = readFlagValue("--timeout");
if (timeoutValue) {
  const n = Number(timeoutValue);
  if (!Number.isFinite(n) || n <= 0) {
    console.error("--timeout 需要一个正数（秒）");
    process.exit(2);
  }
  flags.timeoutMs = n * 1000;
}

const reportFile = readFlagValue("--report");
const offline = args.includes("--offline");

const report = await runAllChecks({ dir: flags.dir, timeoutMs: flags.timeoutMs, offline, only, skip });

if (reportFile) {
  try {
    writeFileSync(reportFile, renderJsonReport(report) + "\n", "utf8");
  } catch (err) {
    console.error(`无法写入报告文件 ${reportFile}：${err.message}`);
    process.exit(2);
  }
}

if (flags.json) {
  console.log(renderJsonReport(report));
} else {
  console.log(renderTerminalReport(report));
}

process.exit(report.summary.fail > 0 ? 1 : 0);
