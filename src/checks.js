import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runCmd, fetchWithTimeout, parseNpmrc, isHostCoveredByNoProxy } from "./util.js";

const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
// 连通性探针用「一定存在」的包；不能用本包名——未发布时返回 404，
// 报告里会出现「可达（HTTP 404）」这种自相矛盾的文案。
const CONNECTIVITY_PROBE = "npm";

// Node 官方 LTS 生命周期表（EOL 日期，UTC）。奇数号 Current 只支持约 6 个月，不进表。
// 数据源：nodejs.org 发布计划 / endoflife.date/nodejs；出新的偶数号 LTS 时更新此表。
export const NODE_EOL = {
  14: "2023-04-30",
  16: "2023-09-11",
  18: "2025-04-30",
  20: "2026-04-30",
  22: "2027-04-30",
  24: "2028-04-30",
  26: "2029-04-30",
};

/** 纯函数：给定主版本号与当前时间，返回 EOL 判定。state ∈ eol | soon | ok | current-odd | unknown */
export function nodeEolStatus(major, now = new Date()) {
  const eol = NODE_EOL[major];
  if (!eol) return { state: major % 2 === 1 ? "current-odd" : "unknown", eol: null };
  const days = Math.ceil((new Date(`${eol}T00:00:00Z`) - now) / 86400000);
  if (days <= 0) return { state: "eol", eol, days };
  if (days <= 180) return { state: "soon", eol, days };
  return { state: "ok", eol, days };
}

export const checks = [
  {
    id: "node-version",
    title: "Node.js 版本与支持状态",
    async run() {
      const v = process.version;
      const major = Number(v.slice(1).split(".")[0]);
      const s = nodeEolStatus(major);
      if (major < 14 || s.state === "eol") {
        return { level: "fail", detail: `${v} 已于 ${s.eol ?? "更早"} 结束官方支持（EOL）`, advice: "升级到仍在支持期的偶数号 LTS（22 / 24）" };
      }
      if (s.state === "soon") {
        return { level: "warn", detail: `${v} 将于 ${s.eol} 结束官方支持（剩约 ${s.days} 天）`, advice: "提前规划升级到最新偶数号 LTS" };
      }
      if (s.state === "current-odd") {
        return { level: "warn", detail: `${v} 为奇数号 Current 版本，非 LTS`, advice: "生产/求职环境建议使用偶数号 LTS 版本" };
      }
      if (s.state === "unknown") {
        return { level: "warn", detail: `${v} 不在内置 EOL 表中，无法确认支持状态`, advice: "对照 nodejs.org 发布计划确认是否仍在支持期；若是新 LTS，请更新 checks.js 的 NODE_EOL 表" };
      }
      return { level: "pass", detail: `${v}（LTS，官方支持至 ${s.eol}）` };
    },
  },
  {
    id: "node-installations",
    title: "Node 多版本共存",
    async run() {
      const listCmd = process.platform === "win32" ? "where.exe" : "which";
      const args = process.platform === "win32" ? ["node"] : ["-a", "node"];
      const r = await runCmd(listCmd, args, { timeoutMs: 5000 });
      if (!r.ok) {
        return { level: "skip", detail: "无法枚举 node 路径，跳过" };
      }
      const locations = [...new Set(r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
      if (locations.length <= 1) {
        return { level: "pass", detail: `唯一安装：${locations[0] || process.execPath}` };
      }
      return {
        level: "warn",
        detail: `发现 ${locations.length} 个 node 安装：${locations.join("；")}`,
        advice: "多版本并存时 PATH 顺序决定实际版本，容易出现「刚装的版本没生效」。建议用 nvm-windows / volta / fnm 统一管理并清理散装安装",
      };
    },
  },
  {
    id: "package-managers",
    title: "包管理器（npm / pnpm / yarn）",
    async run() {
      const parts = [];
      for (const [cmd, args] of [["npm", ["--version"]], ["pnpm", ["--version"]], ["yarn", ["--version"]]]) {
        const r = await runCmd(cmd, args, { timeoutMs: 6000 });
        parts.push({ cmd, version: r.ok ? r.stdout.trim().split(/\r?\n/)[0] : null });
      }
      const npm = parts.find(p => p.cmd === "npm");
      if (!npm.version) {
        return { level: "fail", detail: "npm 不可用", advice: "npm 随 Node 安装，缺失说明 Node 安装损坏，建议重装 Node" };
      }
      const missing = parts.filter(p => !p.version).map(p => p.cmd);
      const summary = parts.map(p => `${p.cmd} ${p.version ?? "缺失"}`).join("，");
      if (missing.length === 0) {
        return { level: "pass", detail: summary };
      }
      return { level: "pass", detail: summary + `（${missing.join("/")} 未安装，如项目需要可补装）` };
    },
  },
  {
    id: "registry-connectivity",
    title: "当前 npm registry 连通性",
    async run(ctx) {
      if (ctx.offline) {
        return { level: "skip", detail: "离线模式（--offline），跳过网络检查" };
      }
      const current = await getCurrentRegistry(ctx.dir, ctx.timeoutMs);
      const r = await fetchWithTimeout(new URL(current + (current.endsWith("/") ? "" : "/") + CONNECTIVITY_PROBE), { timeoutMs: ctx.timeoutMs, method: "HEAD" });
      if (!r.ok && r.aborted) {
        return {
          level: "fail",
          detail: `registry ${current} 连接超时（8s）`,
          advice: "检查代理是否在运行、HTTPS_PROXY 是否指向正确端口（对照案例：代理未启动时端口不监听，所有请求静默超时）",
        };
      }
      if (!r.ok) {
        return { level: "fail", detail: `registry ${current} 请求失败：${r.message}`, advice: "先排查网络与代理，再排查 registry 地址拼写" };
      }
      return { level: "pass", detail: `registry ${current} 可达（HTTP ${r.status}）` };
    },
  },
  {
    id: "mirror-lag",
    title: "镜像同步滞后检测（对照官方源）",
    async run(ctx) {
      if (ctx.offline) {
        return { level: "skip", detail: "离线模式（--offline），跳过网络检查" };
      }
      const current = await getCurrentRegistry(ctx.dir, ctx.timeoutMs);
      if (/registry\.npmjs\.org/.test(current)) {
        return { level: "skip", detail: "当前已是官方源，无镜像滞后问题" };
      }
      // 用一个镜像滞后高发包做对照：scoped optional 依赖最常出现"官方有、镜像没有"
      const probe = "@dsh-ops/bash-win32-x64";
      const official = await fetchWithTimeout(OFFICIAL_REGISTRY + probe, { timeoutMs: ctx.timeoutMs });
      const mirror = await fetchWithTimeout(current.replace(/\/$/, "") + "/" + probe, { timeoutMs: ctx.timeoutMs });
      if (!official.ok) {
        return { level: "skip", detail: "官方源探测失败，跳过对照" };
      }
      const officialVersions = extractVersions(official.body);
      const mirrorVersions = mirror.ok ? extractVersions(mirror.body) : [];
      if (officialVersions.length === 0) {
        return { level: "skip", detail: "探针包在官方源不存在，跳过对照" };
      }
      if (mirrorVersions.length === 0) {
        return { level: "fail", detail: `镜像 ${current} 完全没有探针包 ${probe}，官方源有 ${officialVersions.length} 个版本`, advice: "给该 scope 单独配官方源：在项目 .npmrc 写 @scope:registry=https://registry.npmjs.org/" };
      }
      const missing = officialVersions.filter(v => !mirrorVersions.includes(v));
      if (missing.length > 0) {
        return { level: "fail", detail: `镜像滞后：官方源有 ${missing.join(", ")}，镜像缺失`, advice: "对涉及该包的 scope 单独切官方源（案例：optionalDependencies 精确锁版本遇镜像滞后 → 安装硬失败 ERR_PNPM_NO_MATCHING_VERSION）" };
      }
      return { level: "pass", detail: `镜像与官方源同步（探针 ${probe}，官方 ${officialVersions.length} 个版本全部存在）` };
    },
  },
  {
    id: "npmrc-scope-override",
    title: ".npmrc scope 源覆盖",
    async run(ctx) {
      const proj = ctx.dir;
      const files = [
        { where: "项目", p: path.join(proj, ".npmrc") },
        { where: "用户", p: path.join(os.homedir(), ".npmrc") },
      ];
      const found = [];
      for (const f of files) {
        try {
          const text = fs.readFileSync(f.p, "utf8");
          const parsed = parseNpmrc(text);
          const scopes = Object.keys(parsed).filter(k => k.endsWith(":registry"));
          if (Object.keys(parsed).length) found.push({ where: f.where, file: f.p, entries: parsed, scopes });
        } catch { /* 文件不存在属正常 */ }
      }
      if (found.length === 0) {
        return { level: "pass", detail: "未发现 .npmrc 配置（全部走默认源），如遇镜像滞后再按 scope 补覆盖" };
      }
      const desc = found.map(f => `${f.where}级 .npmrc：${f.scopes.length ? f.scopes.join(", ") : Object.keys(f.entries).join(", ")}`).join("；");
      return { level: "pass", detail: desc };
    },
  },
  {
    id: "npm-strict-ssl",
    title: "npm TLS 校验（strict-ssl）",
    async run(ctx) {
      const r = await runCmd("npm", ["config", "get", "strict-ssl"], { timeoutMs: 6000, cwd: ctx.dir });
      if (!r.ok) {
        return { level: "skip", detail: "无法读取 npm 配置，跳过" };
      }
      if (r.stdout.trim().toLowerCase() === "false") {
        return {
          level: "fail",
          detail: "strict-ssl=false：npm 已全局关闭 TLS 证书校验",
          advice: "这是公司代理自签证书场景的一刀切绕过，等于对中间人完全放行。改用 NODE_EXTRA_CA_CERTS=<公司根证书路径>（或 .npmrc 的 cafile）恢复校验",
        };
      }
      return { level: "pass", detail: "strict-ssl 开启，npm 走正常 TLS 校验" };
    },
  },
  {
    id: "git-proxy-layer",
    title: "双层代理配置（git config + 环境变量）",
    async run() {
      // git 读 ~/.gitconfig（不依赖进程环境），Node 自身 HTTPS 读环境变量——
      // 两层各管一种网络栈，只配一层就会出现"有的工具通、有的工具超时"（真实案例）。
      const gitR = await runCmd("git", ["config", "--global", "--get", "http.proxy"], { timeoutMs: 5000 });
      const gitProxy = gitR.ok ? gitR.stdout.trim() : "";
      const envHttp = process.env.HTTP_PROXY || process.env.http_proxy || "";
      const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy || "";
      const hasGit = Boolean(gitProxy);
      const hasEnv = Boolean(envHttp || envHttps);
      if (hasGit && hasEnv) {
        return { level: "pass", detail: `两层齐全：git → ${gitProxy}；env → ${envHttps || envHttp}` };
      }
      if (!hasGit && !hasEnv) {
        return {
          level: "warn",
          detail: "未配置任何代理",
          advice: "直连正常可忽略；若需访问 GitHub 等被墙资源：git config --global http.proxy http://127.0.0.1:PORT 且设置 HTTPS_PROXY 环境变量（两层缺一不可）",
        };
      }
      const layer = hasGit ? "git" : "环境变量";
      const other = hasGit ? "环境变量层（影响 Node/pnpm 自身的 HTTPS）" : "git 层（git config --global http.proxy，影响 pnpm 解析 github: 依赖）";
      return {
        level: "warn",
        detail: `仅配置了${layer}代理，缺${hasGit ? "环境变量层" : "git 层"}`,
        advice: `补上${other}，否则会出现"git 能拉、npm 超时"或反之的半可用状态`,
      };
    },
  },
  {
    id: "proxy-consistency",
    title: "代理端点一致性",
    async run() {
      const gitR = await runCmd("git", ["config", "--global", "--get", "http.proxy"], { timeoutMs: 5000 });
      const gitProxy = gitR.ok ? gitR.stdout.trim() : "";
      const envHttp = process.env.HTTP_PROXY || process.env.http_proxy || "";
      const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy || "";
      // 归一化到 protocol//host:port 再比，忽略末尾斜杠与路径差异
      const norm = u => {
        try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return u.replace(/\/$/, ""); }
      };
      const endpoints = [];
      if (gitProxy) endpoints.push(["git http.proxy", gitProxy]);
      if (envHttp) endpoints.push(["HTTP_PROXY", envHttp]);
      if (envHttps) endpoints.push(["HTTPS_PROXY", envHttps]);
      if (endpoints.length < 2) {
        return { level: "pass", detail: endpoints.length ? `仅一个代理端点：${endpoints.map(e => e.join(" → ")).join("；")}` : "无代理配置，跳过一致性对照" };
      }
      const [, firstUrl] = endpoints[0];
      const mismatched = endpoints.slice(1).filter(([, u]) => norm(u) !== norm(firstUrl));
      if (mismatched.length > 0) {
        return {
          level: "warn",
          detail: `各层代理指向不同端点：${endpoints.map(e => e.join(" → ")).join("；")}`,
          advice: "git、Node、npm 各挑一个端点走，出口不一致时会出现「有的工具通、有的工具超时」且难定位。统一为同一 host:port（真实案例：xray 混合端口 10808 同时服务 http/https）",
        };
      }
      return { level: "pass", detail: `各层代理一致：${endpoints.map(e => e.join(" → ")).join("；")}` };
    },
  },
  {
    id: "no-proxy-registry",
    title: "NO_PROXY 是否排除当前 registry",
    async run(ctx) {
      const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
      const registry = await getCurrentRegistry(ctx.dir, ctx.timeoutMs);
      const host = new URL(registry).host.toLowerCase();
      if (!noProxy) {
        return {
          level: "warn",
          detail: "未设置 NO_PROXY",
          advice: "配了代理但没排除镜像域名时，原本直连可用的 registry 会被塞进代理隧道变慢/超时（真实案例）。建议 NO_PROXY 包含你的常用镜像域",
        };
      }
      const parts = noProxy.split(",").map(s => s.trim()).filter(Boolean);
      const covered = isHostCoveredByNoProxy(noProxy, host);
      if (!covered) {
        return {
          level: "warn",
          detail: `NO_PROXY 未包含当前 registry 域 ${host}（现值：${parts.join(", ")}）`,
          advice: "把常用 registry 域加入 NO_PROXY，避免镜像流量绕行代理",
        };
      }
      return { level: "pass", detail: `NO_PROXY 已覆盖 ${host}` };
    },
  },
  {
    id: "lockfile-consistency",
    title: "lockfile 与 package.json 一致性",
    async run(ctx) {
      const proj = ctx.dir;
      const pkgPath = path.join(proj, "package.json");
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      } catch {
        return { level: "skip", detail: "当前目录不是 Node 项目（无 package.json），跳过" };
      }
      const lockPath = path.join(proj, "pnpm-lock.yaml");
      const pkgLockPath = path.join(proj, "package-lock.json");
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
      const depNames = Object.keys(allDeps);
      if (fs.existsSync(lockPath)) {
        const lock = fs.readFileSync(lockPath, "utf8");
        const missing = depNames.filter(name => !lock.includes(`'${name}@`) && !lock.includes(`"${name}@`) && !lock.includes(`/${name}@`));
        if (missing.length > 0) {
          return {
            level: "fail",
            detail: `pnpm-lock.yaml 缺少 ${missing.length} 个已声明依赖的记录：${missing.slice(0, 5).join(", ")}`,
            advice: "lockfile 与 package.json 脱节会导致每次安装重新解析、撞上镜像缺口（真实案例）。跑一次 pnpm install 让 lockfile 补齐",
          };
        }
        return { level: "pass", detail: `pnpm-lock.yaml 覆盖全部 ${depNames.length} 个已声明依赖` };
      }
      if (fs.existsSync(pkgLockPath)) {
        return { level: "pass", detail: "存在 package-lock.json（npm 项目）" };
      }
      return {
        level: "warn",
        detail: "有 package.json 但没有任何 lockfile",
        advice: "提交 lockfile 到版本库，保证团队成员与 CI 安装结果一致",
      };
    },
  },
  {
    id: "disk-space",
    title: "磁盘剩余空间",
    async run(ctx) {
      if (typeof fs.statfs !== "function") {
        return { level: "skip", detail: "当前 Node 版本不支持 fs.statfs（需 18.15+），跳过" };
      }
      try {
        const target = fs.existsSync(ctx.dir) ? ctx.dir : os.homedir();
        const stat = await fs.promises.statfs(target);
        const freeGiB = (Number(BigInt(stat.bsize) * BigInt(stat.bavail)) / 1024 ** 3);
        const human = `${freeGiB.toFixed(1)} GB`;
        if (freeGiB < 1) {
          return { level: "fail", detail: `${target} 所在卷仅剩 ${human}`, advice: "npm/pnpm 缓存与原生模块编译很容易吃掉数 GB，先清理：npm cache clean --force 或 pnpm store prune" };
        }
        if (freeGiB < 5) {
          return { level: "warn", detail: `${target} 所在卷剩余 ${human}（低于 5 GB 安全水位）`, advice: "建议清理包管理器缓存或转移大目录，避免安装/编译中途爆盘" };
        }
        return { level: "pass", detail: `${target} 所在卷剩余 ${human}` };
      } catch (err) {
        return { level: "skip", detail: `无法读取磁盘信息：${err.message}` };
      }
    },
  },
  {
    id: "path-safety",
    title: "项目路径含中文/空格",
    async run(ctx) {
      const abs = path.resolve(ctx.dir);
      const hasChinese = /[\u4e00-\u9fff]/.test(abs);
      const hasSpace = /\s/.test(abs);
      if (hasChinese || hasSpace) {
        return {
          level: "warn",
          detail: `路径 ${abs} 含${hasChinese ? "中文" : ""}${hasChinese && hasSpace ? "和" : ""}${hasSpace ? "空格" : ""}`,
          advice: "部分工具链（原生模块编译、ComfyUI、某些 CLI）对非 ASCII/含空格路径处理不良，建议工作目录放在纯英文无空格路径下（真实案例）",
        };
      }
      return { level: "pass", detail: `路径 ${abs} 安全` };
    },
  },
  {
    id: "git-config",
    title: "Git 可用性与用户配置",
    async run() {
      const v = await runCmd("git", ["--version"], { timeoutMs: 5000 });
      if (!v.ok) {
        return { level: "fail", detail: "git 不可用", advice: "安装 Git for Windows / 或检查 PATH" };
      }
      const name = await runCmd("git", ["config", "--global", "--get", "user.name"], { timeoutMs: 5000 });
      const email = await runCmd("git", ["config", "--global", "--get", "user.email"], { timeoutMs: 5000 });
      if (!name.stdout.trim() || !email.stdout.trim()) {
        return { level: "warn", detail: `${v.stdout.trim().split(/\r?\n/)[0]}，但 user.name/user.email 未配置`, advice: "git config --global user.name/user.email，否则无法提交" };
      }
      return { level: "pass", detail: `${v.stdout.trim().split(/\r?\n/)[0]}，身份：${name.stdout.trim()} <${email.stdout.trim()}>` };
    },
  },
];

async function getCurrentRegistry(cwd, timeoutMs = 6000) {
  // 带 cwd 才能读到项目级 .npmrc（scope 覆盖、registry 重写都在这里）
  const r = await runCmd("npm", ["config", "get", "registry"], { timeoutMs, cwd });
  if (r.ok && r.stdout.trim().startsWith("http")) return r.stdout.trim();
  return OFFICIAL_REGISTRY;
}

function extractVersions(packumentBody) {
  try {
    const j = JSON.parse(packumentBody);
    return Object.keys(j.versions || {});
  } catch {
    return [];
  }
}
