import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNpmrc, runCmd, fetchWithTimeout } from "../src/util.js";

test("parseNpmrc 解析 scope registry 与普通键", () => {
  const text = `
# comment
@dsh-ops:registry=https://registry.npmjs.org/
registry=https://registry.npmmirror.com/
; another comment
strict-ssl=true
`;
  const parsed = parseNpmrc(text);
  assert.equal(parsed["@dsh-ops:registry"], "https://registry.npmjs.org/");
  assert.equal(parsed["registry"], "https://registry.npmmirror.com/");
  assert.equal(parsed["strict-ssl"], "true");
});

test("parseNpmrc 空输入返回空对象", () => {
  assert.deepEqual(parseNpmrc(""), {});
  assert.deepEqual(parseNpmrc("# only comments\n;more\n"), {});
});

test("runCmd 对不存在的命令返回结构化错误而不是抛出", async () => {
  const r = await runCmd("definitely-not-a-real-cmd-xyz", ["--version"]);
  assert.equal(r.ok, false);
  assert.ok(r.message);
});

test("runCmd 能取回真实命令输出", async () => {
  const r = await runCmd("node", ["--version"]);
  assert.equal(r.ok, true);
  assert.match(r.stdout, /^v\d+\./);
});

test("fetchWithTimeout 对死地址在超时内返回失败", async () => {
  const start = Date.now();
  const r = await fetchWithTimeout("http://127.0.0.1:1/nope", { timeoutMs: 3000 });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.ok(elapsed < 10000, "不应卡死");
});
