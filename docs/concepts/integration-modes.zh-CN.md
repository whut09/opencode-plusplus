# 集成模式与入口边界

[English](integration-modes.md) | 中文

OpenCode++ 面向普通用户只有一个产品路径：安装到官方 OpenCode Desktop 的 Windows 插件。CLI 和 MCP 仍然保留为开发者与兼容入口。它们共享 application service 和 Harness 规则，但不是 Desktop 的替代界面。

## 产品路径：OpenCode Desktop

普通用户流程是：

```text
下载 EXE -> 按当前用户安装 -> 重启 OpenCode Desktop
  -> 选择 OpenCode++ primary mode
  -> 像平常一样描述任务
  -> 当前 OpenCode 模型调用进程内 OpenCode++ 工具
```

真正读文件、改代码和执行命令的仍是当前 OpenCode 模型。插件提供确定性的 context 选择、编辑边界、命令/路径 Guard、证据记录、policy 评估、介入记录和下一步 decision。它不会启动第二个模型、启动 OpenCode++ CLI、增加 Slash Command，也不会修改 `app.asar`。

当前 Desktop 插件注册的工具名称是：

- `opencode_plusplus_enable`
- `opencode_plusplus_disable`
- `opencode_plusplus_status`
- `opencode_plusplus_dashboard`
- `opencode_plusplus_prepare`
- `opencode_plusplus_retrieve`
- `opencode_plusplus_context_search`
- `opencode_plusplus_context_get`
- `opencode_plusplus_context_status`
- `opencode_plusplus_interventions`
- `opencode_plusplus_context_feedback`
- `opencode_plusplus_evaluate`
- `opencode_plusplus_next`

primary mode 会要求当前模型在编辑前调用 `prepare`，需要上下文时调用 `retrieve`，保留 required command 证据，在编辑后调用 `evaluate`，并在声称完成前调用 `next`。只有当前 gate 允许时，插件才会返回 `finalize`。

## Desktop 会报告什么

每个 Harness 结果都包含结构化 `actionSummary`。普通 `humanReadable` 默认是简洁状态；显式调用 `opencode_plusplus_dashboard` 或出现 human-review 时可以获得完整 Dashboard。各类别仍严格区分：

| 类别         | 含义                                            |
| ------------ | ----------------------------------------------- |
| `observed`   | OpenCode++ 记录了文件选择、finding 或状态信号。 |
| `prevented`  | 某个命令、路径、policy 或边界风险被阻止。       |
| `requested`  | Harness 要求采取动作，例如跑测试或检查调用方。  |
| `repaired`   | 介入进入 repaired，但还没有当前证据验证。       |
| `verified`   | 有效 command 或 CI 结果匹配当前工作树 hash。    |
| `unresolved` | 仍有 blocker 或人工审核事项。                   |

结构化结果和 Dashboard 会展示选中和排除的文件、findings、必跑命令、证据 freshness、decision、下一步和当前工作树 hash。简洁输出会隐藏空类别，并把未执行命令标为建议。未被插件捕获的提交列表、模型解释和测试声明不会被算作 OpenCode++ 动作。`human-review` 会报告具体缺失证据或边界决策，不表示要求用户把整个任务重做一遍。详见 [Harness 输出](../reference/harness-output.zh-CN.md)。

## 开发者面 A：Agent-led 兼容流程

外部 Agent 可以通过 CLI 或 stdio MCP 调用 OpenCode++，同时继续由自己掌握执行流程：

```text
外部 Agent -> OpenCode++ application service
  -> context / retrieval / tests / impact / policy / verify
  -> 外部 Agent 决定执行哪个返回动作
```

这个入口适合 CI 集成、MCP client、仓库诊断，以及已经拥有执行循环的 Agent。Host Agent 可以读取 finding 和 gate，但 OpenCode++ 无法保证 Host Agent 一定遵守它们。

CLI 和 MCP 入口见 [CLI 参考](../reference/cli-reference.zh-CN.md)、[MCP 工具](../reference/mcp-tools.zh-CN.md) 和对应集成文档。它们不是 Desktop 安装或日常 Desktop 使用的必需品。

## 开发者面 B：Harness-led 自动化

CLI orchestrator 可以负责有界自动化循环，并把外部 coding agent 当作 executor：

```text
CLI orchestrator
  -> plan 和 task pack
  -> 调用 executor
  -> 收集 diff 和 trace
  -> 评估 Guard / Policy / Evidence / Impact
  -> 确定性 decision
  -> continue、repair、repack、block、rollback 或 human-review
```

CI 或本地自动化示例：

```powershell
opencode-plusplus orchestrate "修复登录超时" . --executor mock --max-loops 3 --fail-on required
```

真实 executor 命令属于高级自动化能力。命令按 argv 解析，不经过 shell，并会拒绝 shell 控制符。实际编辑由 executor 完成；OpenCode++ 收集其输出并评估仓库状态。`mock` 只验证 Harness 行为，不能当作真实 Agent 成功率。

Harness-led artifact 包括 task pack、每轮 executor result、trace event、Guard finding、policy、verify、loop state、decision state 和 `.agent-context/` 下的 orchestrator report。orchestrator 可以通过 run ID 恢复持久化运行，并在 `finalize`、`block`、`rollback`、`human-review`、重复无进展或达到循环上限时停止。

## 共享规则与硬边界

所有入口使用同一套核心规则：

- Context 和 annotation 只能辅助说明，且是不受信任内容，不授予命令权限；
- 只有匹配当前工作树的新鲜 command 或 CI evidence 才能验证修复；
- 命令成功是 evidence，不是业务正确性的完整证明；
- `prevented`、`requested` 和 `repaired` 不能显示为 `verified`；
- 外部 Context 不能满足测试、contract、freshness、forbidden path 或 finalize 条件；
- runtime state、trace、report、registry、annotation 和 feedback 都通过 atomic storage 边界写入；
- 插件不是操作系统沙箱，无法控制其他应用；
- OpenCode++ 不会自动 commit、push、merge 或破坏性回滚用户工作树。

普通交互使用 Desktop 路径。只有在接入开发工具、CI 或其他 Agent 宿主时，才使用 CLI 或 MCP。
