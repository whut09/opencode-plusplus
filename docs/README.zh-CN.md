# OpenCode++ 文档目录

[English index](README.md) | 中文

OpenCode++ 是面向官方 OpenCode Desktop 的 Windows Harness 插件。安装 EXE 后选择 **OpenCode++** primary mode，它会围绕正常编码任务提供 context、编辑边界、证据和验证决策。CLI 与 MCP 只面向开发者和兼容集成，不是普通安装方式，也不是第二个 Desktop 应用。

![OpenCode++ 系统架构](images/opencode-plusplus-architecture.svg)

产品只有一条普通用户路径：OpenCode Desktop 加上已安装的进程内插件。当前 OpenCode 模型仍然负责实际编码工作。OpenCode++ 让外围控制闭环可见：Context 和 Retrieval 选择重要内容，Guard 定义允许做什么，Evidence 检查什么已经被真实证明，Intervention Ledger 说明检测到、阻止、要求、修复、验证或仍未解决了什么。

## 从这里开始

如果刚接触 OpenCode++，建议按这个顺序阅读：先安装 Windows 插件，再理解产品边界，最后查看架构和 Desktop 中可见的结果。

| 目标                                  | 文档                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Windows 安装、升级、关闭、卸载        | [Windows 安装与使用](integrations/opencode-desktop.zh-CN.md)            |
| 理解插件原理和硬边界                  | [Windows 插件架构与边界](concepts/windows-plugin-architecture.zh-CN.md) |
| 理解产品边界（CLI/MCP 内部定位）      | [产品边界说明](developer/product-boundary.zh-CN.md)                     |
| 五分钟开始                            | [快速开始](getting-started.zh-CN.md)                                    |
| 理解事件驱动运行时                    | [OpenCode 全局 Sidecar](integrations/opencode-sidecar.zh-CN.md)         |
| 理解 context、guard、evidence 和 loop | [总体架构](concepts/architecture.zh-CN.md)                              |
| 理解 Desktop 与开发者入口边界         | [集成模式](concepts/integration-modes.zh-CN.md)                         |
| 理解简洁状态和详细 Dashboard          | [Harness 输出](reference/harness-output.zh-CN.md)                       |
| 使用 CLI（开发者面）                  | [CLI 参考](reference/cli-reference.zh-CN.md)                            |
| 配置证据可信等级                      | [配置参考](reference/config.zh-CN.md)                                   |
| 选择最小验证命令                      | [Smart Verification Planner](reference/verification-planner.zh-CN.md)   |
| 安全恢复未完成 Desktop 任务           | [任务恢复与续接](reference/task-resume.zh-CN.md)                        |
| 理解原生权限与语义 Guard 的分层       | [Permission 与 Guard 边界](reference/permission-boundaries.zh-CN.md)    |
| 在不发送源码的前提下评价 Context 质量 | [Context Feedback](reference/context-feedback.zh-CN.md)                 |
| 构建和发布                            | [发布检查](release.zh-CN.md)                                            |
| 贡献或定制 Harness                    | [贡献指南](../CONTRIBUTING.zh-CN.md)                                    |

## 原理和开发

- [产品边界说明](developer/product-boundary.zh-CN.md)
- [产品定位](concepts/positioning.zh-CN.md)
- [Windows 插件架构](concepts/windows-plugin-architecture.zh-CN.md)
- [总体架构](concepts/architecture.zh-CN.md)
- [Guard 模块](concepts/guard-modules.zh-CN.md)
- [集成模式](concepts/integration-modes.zh-CN.md)
- [Loop Engineering](concepts/loop-engineering.zh-CN.md)
- [Human Review 与人工介入](concepts/human-review.zh-CN.md)
- [任务恢复与续接](reference/task-resume.zh-CN.md)
- [源码导读](developer/source-walkthrough.zh-CN.md)
- [运行时状态机](developer/runtime-state-machine.zh-CN.md)
- [Guard Gate Schema](developer/guard-gate-schema.zh-CN.md)
- [Benchmark 指南](developer/benchmark-guide.zh-CN.md)
- [Desktop Harness 易用性基线](developer/usability-baseline.zh-CN.md)

## 集成和参考

- [OpenCode MCP](integrations/opencode-mcp.zh-CN.md)
- [Codex MCP](integrations/codex-mcp.zh-CN.md)
- [Claude Code MCP](integrations/claude-code-mcp.zh-CN.md)
- [Cursor MCP](integrations/cursor-mcp.zh-CN.md)
- [Executor CLI](integrations/executor-cli.zh-CN.md)
- [MCP 排障](integrations/mcp-troubleshooting.zh-CN.md)
- [MCP 工具](reference/mcp-tools.zh-CN.md)
- [配置参考](reference/config.zh-CN.md)
- [Artifact](reference/artifacts.zh-CN.md)
- [生成文件策略](reference/generated-files.zh-CN.md)
- [Executor Adapter](reference/executor-adapters.zh-CN.md)
- [Retrieval](reference/retrieval.zh-CN.md)
- [Smart Verification Planner](reference/verification-planner.zh-CN.md)
- [Permission 与 Guard 边界](reference/permission-boundaries.zh-CN.md)
- [Context Feedback](reference/context-feedback.zh-CN.md)
- [Harness 输出](reference/harness-output.zh-CN.md)
- [任务恢复与续接](reference/task-resume.zh-CN.md)
- [Roadmap](roadmap.zh-CN.md)

每个英文人工维护页旁边都有 .zh-CN.md 中文页。CLI help snapshot 是机器生成的规范输出，中文 CLI 参考说明相同命令组并链接到该快照。
