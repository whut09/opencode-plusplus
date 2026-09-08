# OpenCode 全局 Sidecar

[English](opencode-sidecar.md) | 中文

OpenCode++ 是运行在 Windows 官方 OpenCode Desktop 内的全局插件。安装器把自包含的 CommonJS 插件写入用户 OpenCode 配置目录。日常交互不依赖源代码仓库，也不依赖 OpenCode++ CLI。

## 运行边界

```mermaid
flowchart LR
  User["用户"] --> Desktop["官方 OpenCode Desktop"]
  Desktop --> Plugin["用户级 OpenCode++ 插件"]
  Plugin --> Guard["命令与路径 Guard"]
  Plugin --> Evidence["工具证据记录器"]
  Plugin --> Verify["空闲增量验证器"]
  Guard --> Artifacts["仓库 .agent-context artifact"]
  Evidence --> Artifacts
  Verify --> Artifacts
```

插件处理 `tool.execute.before`、`tool.execute.after`、`file.edited`、`file.watcher.updated` 和 `session.idle`。OpenCode 主程序仍负责模型执行、工具调度、界面、认证和进程生命周期。

## 控制入口

插件为兼容集成保留 `opencode_plusplus_status`、`opencode_plusplus_enable` 和 `opencode_plusplus_disable` 模型可见工具，但普通 Desktop 入口是 `opencode-plusplus` primary mode。Windows 安装器不再写入命令菜单项，也不再补丁 Desktop 本体。禁用后插件仍加载，只跳过 Guard、证据记录和空闲验证。在 Desktop 外仍可用安装器 EXE 的 `--status`、`--enable` 或 `--disable` 做诊断。

Desktop Harness 工具同时返回结构化 JSON 和默认的简洁人类可读状态。结构化 `actionSummary` 仍是 OpenCode++ 的记录结果：`observed`、`prevented`、`requested`、`repaired`、`verified`、`unresolved` 和 `human-review` 分别说明插件观察到、阻止、要求、修复、验证或仍未解决的事项。调用 Dashboard 工具查看详细视图；human-review 结果也提供 `dashboard` 字段。Dashboard 和 `.agent-context/sidecar/visualization.json` 展示选中/排除文件、问题、缺失证据、必需命令、working-tree hash 和介入计数。模型生成的任务总结或提交列表不能替代这些记录。详见 [Harness 输出](../reference/harness-output.zh-CN.md)。

## 证据与 Artifact

工具调用完成后，插件记录脱敏预览和 hash，不保留不受限制的完整输出。宿主提供退出码时记录退出码，否则结果为 `unknown`。在能够确定时记录调用前后 working-tree hash 和变更路径。报告和 trace 通过共享原子存储写入当前仓库的 `.agent-context/`。宿主提供 OpenCode call ID 时，工具事件会使用它作为事件身份，因此重复 after-hook 在 event log 和 execution trace 中都保持幂等；并发 hook 通过文件锁串行写入并获得单调递增的事件 sequence。

Sidecar 是证据采集和验证层，不是单元测试、代码审查、CI、操作系统沙箱，也不是防止其他应用修改文件的安全边界。

## 与批处理 Harness 的关系

Desktop Sidecar 是会话级、事件驱动的。下面的 CLI/MCP Harness 流程只是开发者兼容示例，普通 Desktop 使用不需要它：

```powershell
opencode-plusplus orchestrate "修复登录超时并补回归测试" . --executor opencode --max-loops 3 --fail-on required
```

两条路径共享 Guard、Evidence、Policy 和决策实现，但只有 Harness-led 路径持有 executor 调用权和终止循环决策。

## 排障

1. 安装或升级后完全重启 OpenCode。
2. 使用 `--status --json` 检查当前配置目录和插件文件。
3. 在新会话中调用 `opencode_plusplus_status`。
4. 编辑文件并触发 idle 后查看 `.agent-context/sidecar/latest.md`。
5. 删除旧的 `.opencode/plugins/opencode-plusplus.ts`。

安装路径和生命周期见 [Windows 安装与使用](opencode-desktop.zh-CN.md)。
