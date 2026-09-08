# Desktop Harness 易用性基线

[English](usability-baseline.md) | 中文

本文记录在 OpenCode Desktop 中选择 **OpenCode++** primary mode 后，完成普通任务的 Stage 0 成本。它是测量基线，不表示当前流程已经最优。

## 范围和边界

基线只覆盖 Desktop 进程内插件：

```text
用户任务 -> OpenCode++ 模式 -> prepare/retrieve -> 模型编辑 -> 真实命令 hook -> evaluate/next
```

当前 OpenCode 模型仍然是唯一模型。测试不会启动第二个模型、启动 CLI、修改 `app.asar`，也不会改变生产 Harness 行为。测试使用临时 Git 仓库，调用 Desktop 暴露的同一组插件工具和 hook。

基线区分两类工作：

- **模型可见 Harness 步骤**：调用 `prepare`、`retrieve`、`evaluate`、`next` 或 `dashboard`。
- **自动运行时步骤**：sidecar 记录的事件。纯 `sidecar.log` 诊断事件不计入该数量；生命周期、hook、证据和介入事件仍然保留。

## 指标

`HarnessUxMetrics` 定义在 `test/support/harness-ux-metrics.ts`，记录：

| 指标                       | 含义                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `harnessToolCalls`         | 每一次被 instrumentation 的 `opencode_plusplus_*` 工具调用。                                         |
| `modelVisibleHarnessSteps` | 五个核心流程工具的调用数：`prepare`、`retrieve`、`evaluate`、`next`、`dashboard`。                   |
| `automaticRuntimeSteps`    | 未产生额外模型调用的、非诊断 sidecar 事件。                                                          |
| `duplicateEvaluations`     | 参数和工作树 hash 都相同的重复 `evaluate`。                                                          |
| `userInterruptions`        | fixture 显式记录的用户停止/中断事件。                                                                |
| `userApprovals`            | fixture 显式记录的用户批准事件。                                                                     |
| `humanReviews`             | 工具结果的终态 decision 或 next action 是 `human-review` 的次数；单独的介入警告不计入。              |
| `verificationCommands`     | Desktop hook 捕获的真实命令执行次数，失败执行也计入。命令返回 0 只是证据输入，不自动等于正确性证明。 |
| `finalDecision`            | 流程中最后观察到的结构化 Harness decision。                                                          |

测试不会把模型生成的总结当成证据。命令证据来自真实 command hook、退出码、输出 hash 和工作树 hash。

## 当前流程场景

契约测试位于 `test/harness-ux-baseline.test.ts`。下表是当前预期形状；后续 UX 工作可以减少这些数字，但必须有意识地更新比较基线。

| 场景 | 流程                                                                                          | Harness 调用 | 模型可见步骤 | 重复 evaluate | 用户批准 | 人工审核 | 验证命令 | 当前最终 decision  |
| ---- | --------------------------------------------------------------------------------------------- | -----------: | -----------: | ------------: | -------: | -------: | -------: | ------------------ |
| A    | prepare -> retrieve -> edit -> test -> contract check -> evaluate -> next -> dashboard        |            5 |            5 |             0 |        0 |        0 |        2 | `run-tests`        |
| B    | 测试失败 -> evaluate/next -> 修复 -> 测试通过 -> contract check -> evaluate/next -> dashboard |            7 |            7 |             0 |        0 |        0 |        3 | `run-tests`        |
| C    | 只改文档 -> evaluate -> next -> dashboard                                                     |            5 |            5 |             0 |        0 |        0 |        0 | `ready-for-review` |
| D    | 修改源码但没有可执行验证命令 -> evaluate -> next -> dashboard                                 |            5 |            5 |             0 |        0 |   至少 1 |        0 | `human-review`     |
| E    | 选择 Build；探测 hook 和工具但保持 inactive                                                   |            0 |            0 |             0 |        0 |        0 |        0 | 无                 |

每个场景都会记录 `automaticRuntimeSteps`，但不会断言一个固定数字，因为 ready-context debounce 和高信号通知事件依赖时序和状态。契约会断言 Build 场景产生 0 个运行时事件。

## 基线揭示的问题

### A、B：证据顺序成本

普通 bugfix 和 repair-loop fixture 都执行真实命令并捕获退出码。当前实现中，sidecar 的命令记录同时带有仓库 changed-file 集合。因此证据评估器可能把该命令记录识别成最后一次编辑，从而把测试证据判为 stale。即使命令返回 0，观察到的 decision 仍然是 `run-tests`。

Stage 0 特意记录这个现象，而不是偷偷修正。后续优化必须证明：命令证据是在真实编辑之后选择的；较新的等价结果会 supersede 旧失败；之后再次编辑会使旧成功证据 stale。

### C：只改文档的成本

Smart Verification Planner 会在 Loop 选择命令前先把只改文档的 diff 分类出来。没有 Markdown 或文档验证器时，它设置 `codeTestRequired: false` 和 `verificationRequired: false`。因此 Loop 不会伪造 `run-tests` blocker，而是到达 `ready-for-review`；这不代表文档语义已经被自动证明。如果仓库配置了 docs verifier，系统会明确建议该命令，而不是静默运行完整代码测试。

### D：缺少验证命令确实需要人工审核

当仓库没有可执行的 test、check 或 contract script 时，插件会停在 `human-review`。用户手工声明不会被转换成测试证据，系统也不会凭空发明一个命令。

### E：Build 隔离

当前 OpenCode agent 是 `build` 时，插件不会初始化 workflow state、拦截 shell/file hook、追加 trace 事件，也不会暴露 active Harness 结果。因此在该轮选择 Build 不会激活 OpenCode++ 行为。

## 重新运行基线

UX 工作期间运行聚焦契约文件：

```powershell
node --import tsx --test test/harness-ux-baseline.test.ts
```

Stage 0 合并前还要运行仓库检查：

```powershell
npm run check
npm run lint
npm run format:check
npm run build
npm test
```

fixture 会在 Windows 用户临时目录创建临时仓库，并在 `finally` 中清理。不会提交 `dist/`、发布文件、`.agent-context/` 运行时输出、缓存或 secret。

## 后续阶段的比较规则

后续 UX 改动可以减少模型可见步骤、重复 evaluate、中断或不必要的验证，但必须保持：

1. Build 保持 inactive。
2. 真实命令证据必须与建议和人工声明区分。
3. 失败验证不能被报告为已验证修复。
4. 后续编辑会使旧成功结果 stale。
5. `human-review` 只用于确实缺少验证器、存在未解决 blocker、超时，或超出 Harness 边界的语义决策。

如果测量流程有意变化，请同步更新本文和对应的英文页面。
