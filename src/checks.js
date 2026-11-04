import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runCmd, fetchWithTimeout, parseNpmrc, isHostCoveredByNoProxy } from "./util.js";

const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
// 连通性探针用「一定存在」的包；不能用本包名——未发布时返回 404，
// 报告里会出现「可达（HTTP 404）」这种自相矛盾的文案。
const CONNECTIVITY_PROBE = "npm";

export const checks = [
  {
    id: "node-version",
    title: "Node.js 版本与支持状态",
    async run() {
      const v = process.version;
      const major = Number(v.slice(1).split(".")[0]);
      // Node 官方维护线：偶数号 LTS 约 30 个月，奇数号 Current 约 6 个月。
      // 这里用保守近似：>=18 都算可用，奇数号提示不是 LTS。
      const isEven = major % 2 === 0;
      if (major < 18) {
        return { level: "fail", detail: `${v} 已低于最低支持线（18）`, advice: "升级到 Node 18+ LTS（如 22.x）" };
      }
      if (!isEven) {
        return { level: "warn", detail: `${v} 为奇数号 Current 版本，非 LTS`, advice: "生产/求职环境建议使用偶数号 LTS 版本" };
      }
      return { level: "pass", detail: `${v}（偶数号 LTS 线）` };
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
      const current = await getCurrentRegistry(ctx.dir);
      const r = await fetchWithTimeout(new URL(current + (current.endsWith("/") ? "" : "/") + CONNECTIVITY_PROBE), { timeoutMs: 8000, method: "HEAD" });
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
      const current = await getCurrentRegistry(ctx.dir);
      if (/registry\.npmjs\.org/.test(current)) {
        return { level: "skip", detail: "当前已是官方源，无镜像滞后问题" };
      }
      // 用一个镜像滞后高发包做对照：scoped optional 依赖最常出现"官方有、镜像没有"
      const probe = "@dsh-ops/bash-win32-x64";
      const official = await fetchWithTimeout(OFFICIAL_REGISTRY + probe, { timeoutMs: 8000 });
      const mirror = await fetchWithTimeout(current.replace(/\/$/, "") + "/" + probe, { timeoutMs: 8000 });
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
    id: "no-proxy-registry",
    title: "NO_PROXY 是否排除当前 registry",
    async run(ctx) {
      const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
      const registry = await getCurrentRegistry(ctx.dir);
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

async function getCurrentRegistry(cwd) {
  // 带 cwd 才能读到项目级 .npmrc（scope 覆盖、registry 重写都在这里）
  const r = await runCmd("npm", ["config", "get", "registry"], { timeoutMs: 6000, cwd });
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
