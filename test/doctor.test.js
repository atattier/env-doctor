import { test } from "node:test";
import assert from "node:assert/strict";
import { runAllChecks } from "../src/doctor.js";
import { renderTerminalReport, renderJsonReport } from "../src/report.js";

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
