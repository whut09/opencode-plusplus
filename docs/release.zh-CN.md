# 发布检查

[English](release.md) | 中文

OpenCode++ 有一个产品交付物和一个开发者交付物：

- Windows EXE 是产品发布物：官方 OpenCode Desktop 的用户级全局插件安装器，以及 `opencode-plusplus` primary mode；
- npm 包是开发者 artifact：把 CLI、MCP、Harness 和共享运行时作为开发/CI 工具携带，Desktop 用户从不安装它。

benchmark fixture、agent-runs、仓库文档、源代码资产和本地运行时文件不应进入 npm 包，npm 包还必须排除 `release/`、`.installer-build/` 和 `apps/desktop/`。Windows EXE 只写入用户级 plugin 和 `agents/opencode-plusplus.md`，安装后需要重启 OpenCode。

产品边界保持明确：EXE 只安装一个 OpenCode Desktop 插件和一个 `OpenCode++` primary mode，不修改 `app.asar`，不增加 Slash Command，不安装第二个模型，也不是操作系统沙箱。插件只是围绕 OpenCode Desktop 已有工具提供用户级控制和 evidence 层。

发布说明必须让用户看懂 selected/rejected 文件、阻止的风险、建议修复、已验证修复和仍需人工处理的区别。`verified fix` 必须是匹配当前工作树的新鲜 command 或 CI evidence；Context 文档、annotation、手工声明和较早的测试结果都不等同于证明。

## 发布前检查

```powershell
npm run check
npm run lint
npm run format:check
npm run docs:cli:check
npm run docs:bilingual:check
npm test
npm run benchmark
npm run benchmark:agent
npm run benchmark:desktop
npm run build
npm run build:installer:windows
npm run test:installer:windows
npm run release:verify
npm run release:verify:desktop
```

Windows 安装器构建必须在 Windows + Node.js 20+ 和 .NET Framework 4.x 构建工具环境执行。esbuild 压缩插件，gzip 生成 payload，再由 Windows C# 编译器嵌入 EXE，并生成 `.sha256` 与 `opencode-plusplus-release.json`。发布前运行 `npm run test:installer:windows`，验证安装、primary mode、disable、enable、插件加载、旧文件清理和 12 MiB 体积上限。

`npm run release:verify` 只校验 npm 开发包，因此可以在没有安装器输出的干净 checkout 中运行。安装器构建后，`npm run release:verify:desktop` 继续核对 EXE 存在、大小、SHA256、manifest、独立 plugin bundle 加载、mode 路径、旧文件清理、卸载恢复和 installer health/repair metadata。`npm run benchmark:desktop` 是确定性的进程内插件 benchmark，付费模型调用数固定为 0。

PR CI 同时运行 Ubuntu 和 Windows，绝不调用付费 executor。Linux 验证 npm 开发包和确定性 proxy benchmark；Windows 构建 EXE、执行安装/恢复 gate，并运行 Desktop plugin benchmark。真实 Desktop 启动只通过手动 `Desktop smoke` workflow：先用 winget 安装官方 `SST.OpenCodeDesktop`，再运行 `npm run test:desktop:real`。手动 Desktop release workflow 在上传或发布资产前也强制通过同一启动 gate。

默认发布流程离线运行，不要求远程 Context Registry source 或 feedback transport。若发布测试显式开启远程 source，必须记录 URL、超时、大小限制、内容 hash 和离线 fallback 行为。网络失败、registry 内容非法、权限拒绝、只读仓库、Windows 非 ASCII 路径和文件短暂占用，都必须返回可诊断失败或 review，不能伪造成功。

Windows 安装器会在每个修改动作前执行预检。检测到正在运行的 `OpenCode.exe`、无效配置路径、不可写目标或损坏 state 时，会在修改任何自有文件前阻止安装。`--doctor --json` 是只读诊断；`--repair --json` 只恢复 OpenCode++ 自己拥有的 plugin、primary agent、runtime state、manifest 和旧文件，必须保留有效的启用状态，也不能重写用户的 OpenCode 配置。安装对话框会显示版本、配置路径、plugin/agent 结果以及重启、选择和使用步骤，而不再只显示“请重启”。

## 版本和包边界

根 package.json 的 version 是唯一版本源。package-info:generate 生成 CLI、MCP、freshness 和插件使用的运行时版本常量。release:verify 检查 npm pack manifest、文件数、包大小和必需入口。

确认 npm 包包含 dist（含插件入口 `dist/integrations/opencode/global-plugin.js`）、README、配置示例和 LICENSE，但不包含 node_modules、benchmark fixture、agent-runs、本地 cache、`.installer-build/`、release、开发脚本或 `.agent-context`。Windows Release 同时上传 EXE、SHA256 和 release manifest，清洁 checkout 能重新构建。

## Windows 发布说明

当前 Release 二进制未做商业代码签名。用户遇到 SmartScreen 时，应先核对 Release 页的 SHA256，再决定是否运行。不要把本地 EXE 或用户配置文件提交进仓库。

发布后确认 npm 版本、GitHub Release 资产、EXE digest、manifest version 和 origin/main commit。版本变更只修改根 package.json；package-info 和 Desktop release manifest 必须与其一致。

`.agent-context/`、`benchmarks/results/`、`dist/`、`release/`、`.installer-build/`、本地配置和 secrets 都是构建输出或用户数据，不得提交或作为源码资产上传。Registry cache、usage、feedback、annotation、intervention、trace 和 sidecar report 都属于仓库本地运行状态，并排除在 npm 包之外。
