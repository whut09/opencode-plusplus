# OpenCode++

[English home](README.md)

**面向 Windows 官方 OpenCode Desktop 的 Harness 插件。**

OpenCode++ 让 AI 生成的 diff 周边工作可见、可审查：它检查了什么、阻止了什么、要求执行什么，以及当前证据到底验证了什么。

## 它解决什么问题

AI 编程经常出现“改动看起来合理，但读错文件、越界修改、跑了无关命令，或没有当前工作树上的测试证据就宣布完成”。OpenCode++ 在 OpenCode Desktop 外围增加一层可审计的验证控制面，让模型基于仓库 context、明确编辑边界、可追踪证据和最终决策完成任务。

它不是第二个聊天软件，也不是新的模型。它是安装在当前 Windows 用户配置目录中的 Desktop 插件，使用 OpenCode 已有的工具和模型，提供：

- 在盲目搜索前选择相关文件和符号；
- 准备任务边界和必需检查；
- 检查危险命令和受保护路径；
- 将执行结果按当前工作树记录为脱敏证据；
- 评估 policy、freshness、regression、hallucination 和循环收敛；
- 明确下一步是 repair、repack、human review 还是 finalize。

## 系统架构

![OpenCode++ 系统架构](docs/images/opencode-plusplus-architecture.svg)

最重要的边界很简单：OpenCode 仍然负责读文件、改代码和执行命令；OpenCode++ 在外围提供确定性的 context、边界、证据检查和决策。

| 层                           | OpenCode++ 做什么                                                     | 它不声称什么                               |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| Context Registry + Retrieval | 定位相关 pack、文件、符号、版本和依赖；解释选中与排除的文件。         | Context 是指导，不是权限或证明。           |
| Guard + Policy               | 检查命令、受保护路径、contracts、freshness、regression 和必需动作。   | 它不是操作系统级沙箱。                     |
| Evidence                     | 将 command 或 CI 结果与当前工作树 hash 和 evidence policy 对齐。      | 命令通过不等于业务正确性已证明。           |
| Intervention Ledger          | 记录检测、阻止、要求、修复、验证、未解决和人工审核状态。              | 阻止或建议不等于已验证修复。               |
| Decision + Dashboard         | 返回下一步允许动作，并在 Desktop 结果和本地 artifact 中展示记录事实。 | 不展示模型隐藏思维链，也不调用另一个模型。 |

普通 Desktop 路径只使用当前 OpenCode 模型和一个进程内插件。CLI 和 MCP 只是开发者/兼容入口，不是安装或日常使用的必需品。

## 现在能做什么

Windows 安装器会向 OpenCode 增加一个可选择的 primary mode：**OpenCode++**。在输入框底部的模式选择器中选择它，然后像平常一样描述编码任务。不再需要记忆任何 OpenCode++ Slash Command。

![选择 OpenCode++ 模式](docs/images/opencode-plusplus-mode.png)

选择该模式后，模式 Prompt 会要求当前 OpenCode 模型调用进程内插件工具。插件不会启动第二个模型，也不会启动 OpenCode++ CLI；它运行在 OpenCode Desktop 插件进程内，并把可审计的运行文件写入当前仓库的 `.agent-context/`。

安装器面向 Windows x64，按当前用户安装，不需要管理员权限。

默认情况下插件离线运行：不会主动访问远程 Context source，也不会调用第二个模型。只有显式配置 remote source 或 feedback transport 后才会联网。真正读文件、改代码和执行命令的仍是当前 OpenCode 模型；OpenCode++ 在外围提供确定性工具和 gate。

## 安装和使用

1. 从 [GitHub Releases](https://github.com/whut09/opencode-plusplus/releases) 下载 `opencode-plusplus-setup-win-x64.exe`。
2. 完全退出 OpenCode Desktop。
3. 双击 EXE，等待安装提示完成。

![安装器确认窗口](docs/images/opencode-plusplus-installer.png)

4. 重启 OpenCode Desktop 并打开目标仓库。
5. 在模式选择器中选择 **OpenCode++**。
6. 直接输入任务，例如：`修复登录超时并补充回归测试`。
7. 让该模式在工作过程中调用 `prepare`、`retrieve`、`evaluate` 和 `next`。需要 Harness gate 时不要切回 Build 模式。
8. 在 `evaluate` 或 `next` 后查看简洁的 `OpenCode++` 状态；需要阶段进度、选中/排除文件、决策依据、证据新鲜度、介入记录和最终总结时调用 `opencode_plusplus_dashboard`。
9. 需要查看证据、发现项、必跑命令或最终报告时，打开 `.agent-context/`。

安装器只写入以下 OpenCode 配置文件：

```text
<OpenCode 配置目录>\plugins\opencode-plusplus.js
<OpenCode 配置目录>\agents\opencode-plusplus.md
<OpenCode 配置目录>\opencode-plusplus\state.json
<OpenCode 配置目录>\opencode-plusplus\installation.json
```

它会清理旧版本创建的 Slash Command、skill 和 `app.asar` 补丁，不再修改 OpenCode Desktop 本体。默认配置目录是 `%USERPROFILE%\.config\opencode`；如果设置了 `OPENCODE_CONFIG_DIR`，优先使用它。

## 报告和边界

每个仓库的运行证据都在本地：

- `.agent-context/traces/`：执行和测试证据；
- `.agent-context/runs/`：任务 context 和编辑边界；
- `.agent-context/loops/`：决策和收敛状态；
- `.agent-context/sidecar/latest.md`：最近一次验证摘要。
- `.agent-context/sidecar/visualization.json`：最新结构化 Harness Dashboard 快照。

插件不是操作系统级沙箱，无法阻止其他程序修改文件，无法仅凭退出码证明业务语义正确，也无法保证完全识别不透明的工具参数。命令成功只是证据，不是完整正确性证明；出现 blocker 时，模式必须继续修复或请求人工审核。

### 用户会看到什么

Desktop 工具结果默认显示简洁的 `OpenCode++ ✓ Verified`、`✗ Repair required` 或 `⚠ Human review` 状态。结构化 JSON 仍保留包含 `observed`、`prevented`、`requested`、`repaired`、`verified` 和 `unresolved` 的 `actionSummary`。需要完整的 `Plan -> Prepare -> Retrieve -> Execute -> Collect -> Evaluate -> Decide -> Persist -> Finalize` 视图时调用 `opencode_plusplus_dashboard`。详见 [Harness 输出](docs/reference/harness-output.zh-CN.md)。

Dashboard 展示的是已记录的系统事实和决策输入，不展示模型隐藏的思维链。这样可以支持调试和人工审核，又不会把模型内部推理冒充成可审计事实。

Desktop 结果和 `.agent-context/sidecar/latest.md` 会区分以下问题：

- **介入了哪些文件：** 选中阅读、在边界内修改，或因原因被排除的文件；
- **阻止了什么风险：** 危险命令、受保护路径、过期 Context、缺失测试、policy 违规或未解决回归；
- **建议修复：** Harness 要求的动作，或 executor 报告的修改，但还没有验证证据；
- **已验证修复：** 修改后有对应当前工作树的新鲜 command 或 CI evidence；
- **仍需人工处理：** 未解决 finding、重复无进展，或 Harness 无法证明的业务语义。

所以，`verified fix` 比 `suggested fix` 严格得多。annotation、Context 文档、手工声明、较早的成功测试、看起来合理的源代码修改、提交列表或模型生成的总结，都不能自动变成 verified。外部 Context 是不可信指导，annotation 是本地知识，不是 policy。返回 `human-review` 时，应读取 `actionSummary.evidence` 中的具体证据缺口；这不是要求重新做一遍任务。

Context cache 和 registry usage 位于 `.agent-context/cache/`、`.agent-context/context-registry/usage/`；本地 feedback 位于 `.agent-context/context-registry/feedback/`；annotation 位于 `.agent-context/knowledge/annotations/`；介入记录位于 `.agent-context/interventions/`。这些都是本地运行文件，通常不应提交。

Windows 支持带空格和非 ASCII 字符的路径，但插件仍依赖当前用户权限、仓库可写，以及 OpenCode Desktop 能加载实际配置目录。杀毒软件短暂锁定文件、只读目录、远程 source 断网、registry 内容损坏和权限失败都会返回诊断或 human-review，不会被当成验证成功。

## 定制自己的 Harness

OpenCode++ 本身就是扩展点。如果你觉得 OpenCode 太宽松、太严格，或不符合团队工作流，可以 fork 或扩展插件，定义自己的 Harness policy，而不是仅靠 Prompt 掩盖问题。

常用定制位置：

- `src/installer/opencode-plusplus-prompts.ts`：primary agent Prompt；
- `src/integrations/opencode/plugin-runtime/`：命令和受保护路径规则；
- `src/retrievers/`、`src/core/ranker.ts`：检索排序；
- `src/outputs/evidence.ts`、`src/harness/verification-plane/`：证据可信度和 freshness；
- `src/harness/control-plane/`：循环停止和决策仲裁；
- `src/integrations/opencode/plugin-runtime/harness/`：Desktop 专用工具行为。

推荐流程是：先为期望的 policy 增加测试，再修改插件或 agent mode，运行完整检查，最后重新构建带校验值的 Windows 安装器。始终明确 Harness 能观察什么，以及哪些结果仍需要人工判断。

## 贡献流程

1. Fork 仓库并创建聚焦分支。
2. 阅读 `AGENTS.md`、相关源码以及对应的中英文文档。
3. 行为变更先增加或更新确定性测试。
4. 不要提交 Desktop runtime artifact、`dist/`、安装器 staging、密钥和本地 `.agent-context/`。
5. 运行 `npm run check`、`npm run lint`、`npm run format:check`、`npm run docs:bilingual:check` 和 `npm test`。
6. 安装器变更还要在 Windows 运行 `npm run build:installer:windows`、`npm run test:installer:windows` 和 `npm run release:verify`。
7. 用户文档必须同步更新中英文，并在 Pull Request 中说明兼容性边界。

详见[文档目录](docs/README.zh-CN.md)、[Windows 架构](docs/concepts/windows-plugin-architecture.zh-CN.md)和[贡献指南](CONTRIBUTING.zh-CN.md)。

## 开发者兼容面

仓库仍保留 CLI 和 MCP，用于源码开发、CI、诊断和兼容集成。普通 Desktop 用户不需要安装或使用它们。

## 许可证

[MIT](LICENSE)
