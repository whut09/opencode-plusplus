# 快速开始

[English](getting-started.md) | 中文

OpenCode++ 是 OpenCode Desktop 的 Windows 插件，适合“看起来合理”还不够的编码任务。它让当前 OpenCode 模型先获取仓库 context，遵守明确编辑边界，产生当前工作树上的证据，并说明任务为什么可以或不可以 finalize。

## 五分钟开始

1. 从 [Releases](https://github.com/whut09/opencode-plusplus/releases) 下载 Windows EXE。
2. 完全退出 OpenCode Desktop，双击 EXE，等待确认提示。
3. 重启 OpenCode Desktop，打开仓库，在模式选择器中选择 **OpenCode++**。
4. 像平常一样描述编码任务。不要启动 OpenCode++ CLI，也不要增加第二个模型。
5. 任务进入 `evaluate` 或 `next` 后，查看工具结果顶部的简洁 `OpenCode++` 状态。
6. 需要详细阶段视图时调用 `opencode_plusplus_dashboard` 或打开 `.agent-context/sidecar/visualization.json`；打开 `.agent-context/sidecar/latest.md` 查看最近报告。

![OpenCode++ 模式](images/opencode-plusplus-mode.png)

## 运行时做什么

模式 Prompt 会引导当前模型在编辑前调用 `retrieve` 和 `prepare`，用内置 shell 执行 required command，并在编辑后调用 `evaluate` 和 `next`。这些工具在 OpenCode Desktop 插件进程内运行。如果检查过期、缺失、被禁止或连续多轮没有进展，Harness 会明确报告原因，而不是静默宣布成功。

简洁结果先回答当前最重要的问题：

- `✓ Verified`：当前证据允许 finalize；
- `✗ Repair required`：检查或 policy gate 仍然阻塞；
- `⚠ Human review`：OpenCode++ 无法自动证明所需条件。

结构化结果和详细 Dashboard 再回答六个审计问题：

- `observed`：OpenCode++ 记录了什么；
- `prevented`：阻止了哪个命令、路径或 policy 风险；
- `requested`：下一步必须做什么；
- `repaired`：什么已经修改但还没有验证；
- `verified`：哪个修复有匹配当前工作树的新鲜 command 或 CI evidence；
- `unresolved`：什么仍然阻塞完成。

当前模型可以生成自然语言任务总结，但那不是 Harness 记录。需要确认 OpenCode++ 自己做了什么时，以 `actionSummary`、Dashboard 和 `.agent-context/` 为准。两层显示和 Toast 规则见 [Harness 输出](reference/harness-output.zh-CN.md)。

## 看不到模式怎么办

安装或升级前必须完全退出 OpenCode Desktop。重启后再查看模式选择器。安装器默认写入 `%USERPROFILE%\.config\opencode`；设置 `OPENCODE_CONFIG_DIR` 时使用该目录。插件从当前生效的 OpenCode 配置目录加载；如果安装时 Desktop 仍在运行，已经加载的旧插件不会自动刷新。

## 什么时候定制

先使用默认模式。仓库如果需要不同的受保护路径、测试可信度、retrieval 权重、evidence policy 或循环停止规则，可以 fork 或扩展插件。为新规则增加测试，并保持 Windows 安装器和中英文文档同步。

CLI 和 MCP 只面向开发者和兼容集成，不是这条安装路径的必需品，Desktop 插件也不会调用它们。
