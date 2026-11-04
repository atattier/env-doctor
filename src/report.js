const LEVEL_META = {
  pass: { icon: "✔", label: "通过" },
  warn: { icon: "⚠", label: "警告" },
  fail: { icon: "✘", label: "失败" },
  skip: { icon: "－", label: "跳过" },
};

// 无 TTY 时（CI 重定向）去掉颜色码
const useColor = process.stdout.isTTY;
const c = {
  green: s => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: s => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: s => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  gray: s => (useColor ? `\x1b[90m${s}\x1b[0m` : s),
  bold: s => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

const colorByLevel = {
  pass: c.green,
  warn: c.yellow,
  fail: c.red,
  skip: c.gray,
};

export function renderTerminalReport(report) {
  const lines = [];
  lines.push(c.bold("env-doctor 环境体检报告"));
  lines.push(c.gray(`平台 ${report.meta.platform} ｜ Node ${report.meta.node} ｜ ${report.meta.generatedAt}`));
  lines.push("");
  for (const r of report.results) {
    const meta = LEVEL_META[r.level];
    const paint = colorByLevel[r.level];
    lines.push(`${paint(meta.icon + " " + meta.label)}  ${r.title}`);
    lines.push(`      ${r.detail}`);
    if (r.advice) lines.push(c.gray(`      ↳ 建议：${r.advice}`));
  }
  lines.push("");
  const s = report.summary;
  const verdict = s.fail > 0
    ? c.red(`发现问题 ${s.fail} 项`)
    : s.warn > 0
      ? c.yellow(`基本健康，${s.warn} 项警告`)
      : c.green("全部通过，环境健康");
  lines.push(`合计：通过 ${s.pass} ｜ 警告 ${s.warn} ｜ 失败 ${s.fail} ｜ 跳过 ${s.skip} —— ${verdict}`);
  return lines.join("\n");
}

export function renderJsonReport(report) {
  return JSON.stringify(report, null, 2);
}
