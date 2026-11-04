import { checks } from "./checks.js";

export async function runAllChecks({ dir = process.cwd(), timeoutMs = 8000 } = {}) {
  const ctx = { dir, timeoutMs };
  const results = [];
  for (const check of checks) {
    let result;
    try {
      result = await check.run(ctx);
    } catch (err) {
      result = { level: "fail", detail: `检查器内部异常：${err.message}`, advice: "这通常是 env-doctor 自身的 bug，欢迎提 issue" };
    }
    results.push({ id: check.id, title: check.title, ...result });
  }
  const summary = {
    pass: results.filter(r => r.level === "pass").length,
    warn: results.filter(r => r.level === "warn").length,
    fail: results.filter(r => r.level === "fail").length,
    skip: results.filter(r => r.level === "skip").length,
  };
  return { results, summary, meta: { dir, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform } };
}
