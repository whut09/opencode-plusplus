# 总体架构

[English](architecture.md) | 中文

OpenCode++ 是围绕现有 coding agent 的可验证可靠性层：

```text
Context -> Agent -> Execution -> Trace -> Evaluation -> Context Update -> Loop
```

它不是自治 coding agent。Harness 持久化仓库状态、收集证据并报告下一步；实际编辑仍由用户或外部 executor 完成。

## Windows 默认路径

官方 OpenCode Desktop 加载用户级全局插件，这是普通用户唯一的产品入口。插件接收 tool before/after、file edited、watcher updated 和 session idle 事件，分别执行命令/路径 Guard、证据记录和空闲增量验证；prepare/retrieve/evaluate/next 等工具在插件进程内调用 application service。输出写入当前仓库的 .agent-context，并通过 actionSummary 和 Dashboard 显示可审计事实。

## 可靠性层

1. Context Guard：扫描、索引、任务 pack、token 和 freshness。
2. Boundary Guard：allowed/avoid 路径、protected/generated 文件和 contracts。
3. Evidence Guard：退出码、时间、输出 hash、working-tree hash、command/CI/manual 来源。
4. Impact Guard：直接/传递依赖、相关测试和风险。
5. Hallucination Guard：不存在的文件、命令、依赖、配置和符号。
6. Regression Guard：历史问题、脆弱模块和反回归测试。
7. Loop Guard：finalize、repair、repack、run-tests、block、rollback、human-review。

## Harness 阶段

Harness-led Orchestrator 按 Plan、PrepareSandbox、Execute、Collect、Evaluate、Decide、Persist、Finalize/Continue 分阶段运行。每阶段写状态和 artifact，支持 run-id 恢复、幂等 persist、working-tree hash、fingerprint 和 repeated-state/no-progress。

## Windows 与 Harness 的边界

Desktop 插件是事件驱动的会话观察者，不启动多轮 executor；CLI/MCP Harness 才能调用 executor 并拥有有界循环。两者共享 application service、evidence policy 和 Guard 实现，但不共享 UI、进程生命周期或回滚权。

详细阶段和收敛算法见 [运行时状态机](../developer/runtime-state-machine.zh-CN.md) 与 [Loop Engineering](loop-engineering.zh-CN.md)。

## Permission 与 Policy 的职责

OpenCode 原生 permission 表示用户授权：包操作、网络、远程 Git 或仓库外路径可以由 OpenCode 弹窗请求同意。OpenCode++ Command Guard 表示仓库语义：它可以把操作交给宿主，返回 `approval-required`；也可以对破坏性命令、受保护路径、未知项目命令或 evidence 篡改返回 `policy-blocked` 并在执行前停止。即使宿主开启自动批准，也不能覆盖后者。
