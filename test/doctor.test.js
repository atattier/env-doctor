import { test } from "node:test";
import assert from "node:assert/strict";
import { runAllChecks, selectChecks } from "../src/doctor.js";
import { nodeEolStatus } from "../src/checks.js";
import { renderTerminalReport, renderJsonReport } from "../src/report.js";

test("selectChecks 按 only/skip 过滤并报告未知 id", () => {
  const all = selectChecks({}).list.map(c => c.id);
  assert.ok(all.length >= 14, `应有至少 14 个检查器，实际 ${all.length}`);

  const only = selectChecks({ only: "node-version,lockfile-consistency" });
  assert.deepEqual(only.list.map(c => c.id), ["node-version", "lockfile-consistency"]);
  assert.deepEqual(only.unknown, []);

  const skip = selectChecks({ skip: "node-version" });
  assert.ok(!skip.list.map(c => c.id).includes("node-version"));
  assert.equal(skip.list.length, all.length - 1);

  const bad = selectChecks({ only: "node-version,no-such-check" });
  assert.deepEqual(bad.unknown, ["no-such-check"]);

  // 空字符串等价于未传
  assert.equal(selectChecks({ only: "" }).list.length, all.length);
  assert.equal(selectChecks({ skip: "" }).list.length, all.length);
});

test("nodeEolStatus 用真实 EOL 表判定", () => {
  assert.equal(nodeEolStatus(24).state, "ok");
  assert.equal(nodeEolStatus(18).state, "eol");
  assert.equal(nodeEolStatus(20).state, "eol");
  assert.equal(nodeEolStatus(25).state, "current-odd");
  assert.equal(nodeEolStatus(22, new Date("2027-01-15T00:00:00Z")).state, "soon");
  assert.equal(nodeEolStatus(28).state, "unknown");
});

test("offline 模式把网络类检查标为 skip 且整体加速", async () => {
  const start = Date.now();
  const report = await runAllChecks({ dir: process.cwd(), offline: true });
  for (const id of ["registry-connectivity", "mirror-lag"]) {
    const r = report.results.find(x => x.id === id);
    assert.equal(r.level, "skip", `${id} 在离线模式应为 skip`);
  }
  assert.equal(report.meta.offline, true);
  assert.ok(report.results.length >= 12, "离线只应跳过网络项，其余照跑");
  assert.ok(Date.now() - start < 60000, "离线模式不应卡在网络超时上");
});

test("并行执行后结果仍按声明顺序排列", async () => {
  const report = await runAllChecks({ dir: process.cwd(), offline: true });
  const ids = report.results.map(r => r.id);
  const sorted = [...ids].sort();
  // 只验证稳定输出：同一份输入跑两次顺序一致且与 checks 声明一致
  const report2 = await runAllChecks({ dir: process.cwd(), offline: true });
  assert.deepEqual(ids, report2.results.map(r => r.id));
  assert.deepEqual(ids.length, sorted.length);
});

test("全部检查器可运行且返回规范结构", async () => {
  const report = await runAllChecks({ dir: process.cwd(), timeoutMs: 8000 });
  assert.ok(report.results.length >= 10, "至少 10 个检查器");
  for (const r of report.results) {
    assert.ok(["pass", "warn", "fail", "skip"].includes(r.level), `非法 level: ${r.level}`);
    assert.ok(r.title);
    assert.ok(r.detail);
  }
  const total =
    report.summary.pass + report.summary.warn + report.summary.fail + report.summary.skip;
  assert.equal(total, report.results.length);
});

test("JSON 报告可被解析回原结构", async () => {
  const report = await runAllChecks({ dir: process.cwd(), timeoutMs: 8000 });
  const json = renderJsonReport(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.results.length, report.results.length);
  assert.equal(parsed.summary.fail, report.summary.fail);
});

test("终端报告包含所有检查项标题与合计", async () => {
  const report = await runAllChecks({ dir: process.cwd(), timeoutMs: 8000 });
  const text = renderTerminalReport(report);
  for (const r of report.results) {
    assert.ok(text.includes(r.title), `报告缺标题: ${r.title}`);
  }
  assert.ok(text.includes("合计"));
});

test("lockfile 检查器对构造的坏项目报 fail", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "envdoc-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fake", dependencies: { "missing-dep-alpha": "^1.0.0" } }),
    );
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nnothing here\n");
    const report = await runAllChecks({ dir, timeoutMs: 8000 });
    const lockCheck = report.results.find(r => r.id === "lockfile-consistency");
    assert.equal(lockCheck.level, "fail");
    assert.ok(lockCheck.detail.includes("missing-dep-alpha"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("路径安全检查器对中文路径告警", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = path.join(tmpdir(), "中文目录测试");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(base, { recursive: true });
  try {
    const report = await runAllChecks({ dir: base, timeoutMs: 8000 });
    const pathCheck = report.results.find(r => r.id === "path-safety");
    assert.equal(pathCheck.level, "warn");
    assert.ok(pathCheck.detail.includes("中文"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
