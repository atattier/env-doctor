# env-doctor

一键体检 Node.js / pnpm / Git 开发环境：版本、registry 连通性、镜像同步滞后、`.npmrc` scope 覆盖、双层代理、`NO_PROXY`、lockfile 一致性，一条命令给出诊断与修复建议。

> 设计来源：每一条检查都对应一次真实踩坑。比如「两个 npm 源都通，但装插件报所有安装源都无法连接」其实是 GitHub 不通；「装了代理后原本能用的 registry 反而超时」是因为 `NO_PROXY` 没排除镜像域。这些案例被固化成了检查项与建议文案。

## 安装 / 运行

无需安装依赖，Node 18+ 直接运行：

```bash
node bin/env-doctor.js
```

或安装为全局 CLI：

```bash
npm i -g env-doctor
env-doctor
```

## 用法

```bash
env-doctor [选项]

  --json           以 JSON 输出（便于 CI / 脚本消费）
  --dir <path>     指定项目目录（检查 lockfile / .npmrc），默认当前目录
  --timeout <sec>  网络类检查的超时秒数，默认 8
  -v, --version    显示版本
  -h, --help       显示帮助
```

退出码：存在 `fail` 项时返回 `1`，否则 `0` —— 可直接用于 CI 门禁。

### 示例输出

```text
env-doctor 环境体检报告
平台 win32 ｜ Node v22.14.0 ｜ 2026-11-04T16:35:38.656Z

✔ 通过  Node.js 版本与支持状态
      v22.14.0（偶数号 LTS 线）
✔ 通过  当前 npm registry 连通性
      registry https://registry.npmjs.org/ 可达（HTTP 200）
⚠ 警告  双层代理配置（git config + 环境变量）
      仅配置了git代理，缺环境变量层
      ↳ 建议：补上环境变量层（影响 Node/pnpm 自身的 HTTPS），否则会出现"git 能拉、npm 超时"的半可用状态

合计：通过 7 ｜ 警告 2 ｜ 失败 0 ｜ 跳过 1 —— 基本健康，2 项警告
```

## 检查项

| # | 检查 | 说明 |
|---|---|---|
| 1 | Node.js 版本与支持状态 | 低于 18 判失败；奇数号 Current 版本提示非 LTS |
| 2 | 包管理器 | npm / pnpm / yarn 版本盘点，npm 缺失视为 Node 安装损坏 |
| 3 | registry 连通性 | 对当前 registry 做带超时的探测，超时时提示先查代理端口 |
| 4 | 镜像同步滞后 | 以 scoped 包为探针，对照官方源与镜像的版本集合 |
| 5 | `.npmrc` scope 源覆盖 | 列出项目级 / 用户级的 scope registry 配置 |
| 6 | 双层代理 | `git config http.proxy` 与环境变量各管一套网络栈，缺一层即告警 |
| 7 | `NO_PROXY` | 代理是否错误地把当前 registry 也塞进隧道 |
| 8 | lockfile 一致性 | `pnpm-lock.yaml` 是否覆盖 `package.json` 中声明的依赖 |
| 9 | 路径安全 | 项目路径含中文 / 空格时的工具链兼容性风险 |
| 10 | Git 可用性与身份 | `user.name` / `user.email` 是否配置 |

结果分四级：`pass` / `warn` / `fail` / `skip`。

## 设计原则

- **诊断工具不能先于病人倒下**：命令缺失、超时、网络不可达都返回结构化结果，不抛异常。
- **跨平台**：Windows 下用 `where.exe` 按 `PATHEXT` 解析命令，`.cmd` / `.bat` 经 `cmd.exe` 中转；Node 18 / 20 / 22 行为一致。
- **零运行时依赖**：只用 Node 内置模块。
- **只读**：不修改任何配置，只给建议。

## 开发

```bash
npm test          # 单元测试（含真实命令与网络探测）
npm run selfcheck # 对自己跑一次完整体检
```

CI 在 Ubuntu / Windows × Node 18 / 20 / 22 六种组合上运行测试与 CLI 冒烟。

## License

[MIT](LICENSE)
