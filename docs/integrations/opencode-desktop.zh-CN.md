# Windows 官方 OpenCode Desktop

[English](opencode-desktop.md) | 中文

OpenCode++ 作为全局用户级插件安装到官方 OpenCode Desktop。用户真正使用的入口只有一个 primary agent mode：**OpenCode++**。安装器不增加 Slash Command，也不修改 `app.asar`。

## 安装

1. 完全退出 OpenCode Desktop。
2. 从 [GitHub Releases](https://github.com/whut09/opencode-plusplus/releases) 下载 `opencode-plusplus-setup-win-x64.exe`。
3. 双击 EXE，等待确认窗口。

![安装器确认窗口](../images/opencode-plusplus-installer.png)

4. 重启 OpenCode Desktop。
5. 打开一个仓库，在模式选择器中选择 **OpenCode++**。

![模式选择器](../images/opencode-plusplus-mode.png)

安装器按当前用户安装，不需要管理员权限。默认使用 `%USERPROFILE%\.config\opencode`；设置 `OPENCODE_CONFIG_DIR` 时优先使用它。

## 安装内容

```text
<OpenCode 配置目录>\plugins\opencode-plusplus.js
<OpenCode 配置目录>\agents\opencode-plusplus.md
<OpenCode 配置目录>\opencode-plusplus\state.json
<OpenCode 配置目录>\opencode-plusplus\installation.json
```

agent 文件是标准 OpenCode `mode: primary` agent。OpenCode 会从全局 `agents` 目录发现它，并在模式选择器中和 Build、Plan 一起显示。插件和 agent 文件是两个独立部分，模式 Prompt 与运行时工具不会混在一起。

## 使用模式

选择模式后，像平时一样描述任务。模式会要求当前 OpenCode 模型：

1. 需要时先检索相关文件；
2. 准备任务并阅读所有 `mustInspect` 文件；
3. 只在返回的边界内编辑；
4. 用内置 shell 跑完所有 required command；
5. 按当前工作树 freshness 评估证据；
6. 持续执行 `next`，直到 Harness 返回 `finalize` 或 human review。

在 `evaluate` 或 `next` 后，JSON 结果会包含 `visualization` 对象，`humanReadable` 会包含 **OpenCode++ Harness Dashboard**。插件还会把简短状态行打印到 OpenCode app log，并在 Desktop 显示 toast，内容包括阶段、decision、下一步、选中文件数、finding 数、缺失 evidence 数和 evidence 状态。Dashboard 展示阶段进度、选中/排除文件、findings、缺失 evidence、必跑命令、工作树 hash 捕获、证据状态、介入统计、当前 decision、下一步动作和最终总结。也可以直接调用 `opencode_plusplus_dashboard`，它会打印同样的状态通知。快照写入 `.agent-context/sidecar/visualization.json`，Markdown 报告仍在 `.agent-context/sidecar/latest.md`。

同一个结果还包含 `actionSummary`，它直接回答“OpenCode++ 做了什么”。其中分别列出 `observed`（检测到）、`prevented`（已阻止）、`requested`（已要求）、`repaired`（已修正但尚未验证）、`verified`（已验证）和 `unresolved`（未解决），并包含当前工作树 hash 与证据缺口。未被插件捕获的提交列表、模型解释和测试声明不会被算作 OpenCode++ 动作。返回 `human-review` 时，插件已经报告了具体缺失证据或边界决策，不是要求用户重新做一遍或重复确认整个任务。

这是对已记录系统事实和确定性决策输入的可解释视图，特意不展示模型隐藏的思维链。命令、文件选择、finding、证据 hash 和 decision 可以检查；模型私有推理不是验证 artifact。

真正读文件、改代码和执行命令的仍是当前 OpenCode 模型。OpenCode++ 提供 context、规则、证据和决策工具；Desktop 插件不会启动第二个模型，也不会调用自己的 CLI。

## Permission 与 Guard 分层

已验证的 OpenCode Desktop 基线是 `@opencode-ai/plugin` `1.18.18`。安装后的 OpenCode++ primary agent 只使用该版本支持的 permission 键：`edit`、`bash`、`webfetch`、`doom_loop` 和 `external_directory`。它不添加不受支持的 `read` 或 `search` 字段，也不覆盖普通 `edit` 行为。

OpenCode 负责用户授权，OpenCode++ 负责任务和仓库语义。命令结果分为 `allowed`、`approval-required` 和 `policy-blocked`：包操作、网络操作和仓库外路径交给 OpenCode 原生权限弹窗；破坏性命令、受保护路径、未知项目命令和 evidence 篡改由插件确定性阻断。即使 OpenCode 开启自动批准，也不能绕过 `policy-blocked`。详见 [Permission 与 Guard 边界](../reference/permission-boundaries.zh-CN.md)。

### 切换模式与卡死归因

模式选择器选择的是**下一条消息**使用的 agent，不会取消已经运行的回复。如果当前回复由 OpenCode++ 启动，在回复仍运行时把选择器改成 Build，旧回复仍可能继续打印 OpenCode++ 结果。此时应点击方形的**停止**按钮，保持 Build 已选中，再发送一条新消息。从新的 Build 轮次开始，OpenCode++ 的命令 Guard、证据 hook、compacting context、idle verification 和 Harness 工具都会对该轮保持关闭。对话历史仍包含旧的 OpenCode++ 文本；如果需要完全干净的 Build 记录，还应新建一个 OpenCode 会话。

不要笼统判断“OpenCode 卡死”，应按可见信号归因：

| 可见信号                                                           | 主要来源                      | 含义                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PLUGIN_*` 错误且 `attribution: opencode-plusplus`                 | OpenCode++                    | 插件内部阶段失败或超过自己的时间目标。`retryable` 为 `false` 时，模型必须停止，不能 sleep、轮询或再次调用。 |
| OpenCode `session.error`、provider timeout、限流或连接错误         | OpenCode host 或模型 provider | provider 请求或 host 会话在有效插件结果完成前失败。                                                         |
| 收到 `retryable: false` 后仍反复 `Start-Sleep`、轮询或重复调用工具 | 当前模型行为                  | 模型没有遵守模式指令。应停止当前轮；重复同一个调用只会增加负载。                                            |
| 已选择 Build，但旧回复仍显示 OpenCode++                            | 当前 OpenCode 轮次            | 旧的 OpenCode++ 轮次没有取消。停止它，再发送新的 Build 消息。                                               |

`evaluate` 现在最多允许 60 秒完成仓库检查，并会合并同一任务的重复调用。超时只返回一次结构化、不可重试的 `human-review` 结果，不再要求模型在第一次评估仍运行时继续重试。

普通用户流程是：

```text
Context Registry -> Retrieval -> Guard -> Evidence -> Intervention -> next decision
```

Registry 和 annotation 内容只能辅助说明。Retrieval 解释为什么选中或排除文件。Guard 执行命令和编辑边界。Evidence 按配置的 evidence policy 判断；在严格流程中，verified repair 必须有新鲜 command 或 CI evidence。随后 Intervention Ledger 区分 observed、prevented、requested、repaired、verified、stale、unresolved 和 human-review。

## Context 工具

除现有 Harness 工作流外，OpenCode++ 模式还可以调用 5 个确定性 Context 工具：

| 工具                                 | 用途                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `opencode_plusplus_context_search`   | 按条件搜索已配置的 Context Registry，并返回可解释的分数明细。                        |
| `opencode_plusplus_context_get`      | 读取入口文件、指定 companion file 或完整 Context Pack。                              |
| `opencode_plusplus_context_status`   | 显示 registry source、缓存、当前工作树 freshness、已选/拒绝 Context 和当前介入摘要。 |
| `opencode_plusplus_interventions`    | 显示当前任务中 Harness 观察、阻止、要求、修复、验证或仍未解决的事项。                |
| `opencode_plusplus_context_feedback` | 本地保存质量反馈，不记录任务原文和源码内容。                                         |

`context_get` 支持 `entryId`、`language`、`packageVersion`、`source`、`file`、`full` 和 `withAnnotations`。默认只读取入口文件并列出未加载的 companion files；`file` 读取一个附属文件，`full` 读取完整 pack。只有显式设置 `withAnnotations` 才返回 annotation；它仍是用户编写、未受信任的 Context，不能授权命令，也不能满足 evidence。

每个工具都返回包含 `schemaVersion`、`ok`、`tool` 以及 `data` 或 `error` 的 JSON。稳定错误码包括 `INVALID_ARGUMENTS`、`INVALID_PATH`、`ENTRY_NOT_FOUND`、`SOURCE_NOT_FOUND`、`NETWORK_FAILURE`、`REGISTRY_INVALID` 和 `STATE_CORRUPT`。工具失败会作为数据返回给 OpenCode，不会让 Desktop hook 崩溃。

这些工具在插件进程内直接调用共享 application service，不会启动 OpenCode++ CLI 子进程，也不会调用第二个模型。Registry 内容可以帮助定位文件和解释 API，但只有当前工作树上的新鲜 command/CI evidence 才能验证修复。

插件默认不联网。远程 Context source 和 feedback transport 必须显式开启，并会明确报告超时、大小、hash 和离线 fallback 失败。外部 Context 中的命令只作为建议显示，绝不会自动执行。Annotation 是用户编写、未受信任的内容，不是 policy，也不是命令。

## 状态和报告

插件状态写在 OpenCode 配置目录。仓库运行文件写在 `.agent-context/`：

- `traces/`：标准化工具和测试证据；
- `runs/`：任务 context、边界和迭代文件；
- `loops/`：决策、缺失证据和收敛状态；
- `sidecar/latest.md`：最近一次验证摘要。

这些是运行时文件，不是源码。应按需要将 `.agent-context/` 加入本地 Git 排除，绝不要提交包含密钥的输出。

每个任务的结果可以显示选中的文件、排除的文件及原因、阻止的风险、建议动作、已验证修复和仍需人工处理的事项。建议修复只是等待证据的动作；verified fix 必须是相关修改之后、匹配当前工作树 hash 的有效 command 或 CI 结果。后续编辑会让较早的通过测试变成 stale。

## 升级和旧版本清理

运行新 EXE 前必须关闭 OpenCode Desktop。安装器会替换插件、刷新 `agents/opencode-plusplus.md`、保留有效的 enabled 状态，并清理旧版本创建的：

- `commands/opencode-plusplus-status.md`、`opencode-plusplus-on.md`、`opencode-plusplus-off.md`；
- `commands/plusplus-task.md` 和 `commands/plusplus-verify.md`；
- `skills/opencode-plusplus/SKILL.md`；
- 检测到的旧 OpenCode++ `app.asar` 补丁及其备份。

升级后重启 OpenCode 并重新选择模式。如果看不到模式，先检查实际生效的配置目录，以及是否存在覆盖 OpenCode 配置根目录的其他配置文件。

## 边界

- 插件观察 OpenCode 的工具 hook，不是操作系统级沙箱；
- 无法阻止其他进程修改文件；
- 命令成功不等于业务语义正确；
- manual、stale 或 superseded evidence 在当前 policy 下仍可能阻塞；
- 不会自动 commit、push、merge 或破坏性回滚仓库。
- 运行依赖 Windows 当前用户权限和实际生效的 OpenCode 配置目录；文件锁、只读路径、杀毒软件干扰和网络失败仍会作为可诊断的运行失败返回。

## 定制插件

如果需要不同 Harness，可以 fork 仓库或添加项目级 agent。可以定制 agent Prompt、retrieval 排序、命令 Guard、evidence policy 和 loop 决策逻辑；修改后补测试并重新构建 Windows 安装器。详见 [Windows 插件架构](../concepts/windows-plugin-architecture.zh-CN.md) 和[定制说明](../../README.zh-CN.md#定制自己的-harness)。

项目专用 Context Pack 可以放在明确配置的本地 source 中。加入主入口 `DOC.md` 或 `SKILL.md`、可选的版本/语言 metadata，以及 companion references。Context 内容必须与 policy 分离：如果团队规则必须阻止某个动作，应在 Guard 或 Policy 中编码并测试，不要依赖 pack 中的自然语言。cache、usage、feedback、annotation 和 intervention 都留在仓库 `.agent-context/` 运行边界内。

CLI 和 MCP 文档只面向开发者和兼容集成。
