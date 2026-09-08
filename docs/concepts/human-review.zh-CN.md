# Human Review：为什么需要人工、要做什么、如何继续

[English](human-review.md) | 中文

OpenCode++ 只有在确定性的运行时无法安全继续，或无法证明任务要求的结果时，才会进入 `human-review`。它不是普通失败信息，也不是要求用户把整个任务重新做一遍。

## 用户需要知道什么

每个 review request 都回答三个问题：

1. **为什么需要人工？** 使用稳定的 `reasonCode`，并由 finding 和当前仓库状态支持。
2. **用户需要做什么？** `requiredUserAction` 明确缺少的是批准、命令、检查还是仓库状态决策。
3. **系统如何继续？** `resumeCondition` 明确下一步安全的运行时迁移，以及仍然需要什么证据。

请求会以结构化 artifact 持久化，并随插件工具结果返回：

```json
{
  "reasonCode": "BOUNDARY_EXPANSION_REQUIRED",
  "title": "OpenCode++ needs permission to expand task scope.",
  "explanation": "The task references a file outside the current edit boundary.",
  "requiredUserAction": "Inspect the requested path and explicitly approve the scope expansion.",
  "suggestedCommands": ["git diff -- packages/shared/token.ts"],
  "affectedFiles": ["packages/shared/token.ts"],
  "resumeCondition": "After approval, the boundary revision is updated and evaluation continues without prepare."
}
```

完整模型还包含 task/session 标识、请求状态、时间戳、boundary revision，以及适用时的当前/请求边界。文件位于 `.agent-context/sidecar/` 下，并通过原子写入保存。

## 原因代码

| 代码                          | 为什么需要 review                                              | 用户做什么                                                 | 什么条件会继续                                                     |
| ----------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `NO_EXECUTABLE_TEST`          | 源码或配置发生了修改，但没有可执行的验证命令。                 | 配置或运行当前工作树上的检查，或人工检查并接受未验证结果。 | 捕获新的 command/CI 证据，或明确该任务是 docs-only/非代码任务。    |
| `BOUNDARY_EXPANSION_REQUIRED` | 任务需要修改当前允许边界之外的路径。                           | 检查请求的文件并明确批准扩展范围。                         | boundary revision 增加；当前任务从 evaluate 继续，不重新 prepare。 |
| `EXTERNAL_SIDE_EFFECT`        | 下一步会影响网络、包状态、外部路径、发布流程或其他不可逆表面。 | 通过 OpenCode 原生 permission 流程批准或拒绝宿主操作。     | 操作完成后，用新鲜证据评估产生的状态。                             |
| `UNVERIFIABLE_RESULT`         | 已观察到的结果不能证明所需 contract 或行为。                   | 提供合适的验证路径，或做出自动化无法替代的语义决策。       | 所需证据被捕获，并针对当前工作树重新评估。                         |
| `PLUGIN_FAILURE`              | 插件 hook、协议、持久化或运行时操作失败。                      | 查看结构化错误和受影响 artifact，修复插件/运行时条件。     | 失败操作产生成功且可诊断的替代结果；不会自动当成 verified。        |
| `AMBIGUOUS_REPOSITORY_STATE`  | 冲突、意外或不完整的仓库状态阻止安全决策。                     | 检查 `git status`/相关 diff，解决或确认仓库状态。          | 仓库状态明确后，当前阶段重新评估。                                 |

具体 request 才是权威信息；建议命令只是指导。Context 或 annotation 中出现的命令不会因此自动执行，也不能作为证据。

## Boundary Expansion 是批准，不是直接阻塞

假设当前任务只允许 `packages/auth/**`，但实现依赖 `packages/shared/token.ts`。OpenCode++ 会显示：

```text
Current:   packages/auth/**
Requested: packages/shared/token.ts
Reason:    the auth implementation imports token expiration logic from this module
```

用户可以检查请求路径，然后以 `action: "approve"` 和 `confirmed: true` 明确调用 `opencode_plusplus_human_review`。OpenCode++ 随后会：

1. 确认请求路径不属于 protected/avoid 路径；
2. 把请求路径加入允许编辑边界；
3. 增加 `boundaryRevision`；
4. 把批准写入 workflow 和 intervention artifact；
5. 从 evaluate 继续当前任务，不重新执行 `prepare`。

批准只扩大范围。它不会批准危险命令、关闭 Guard、生成测试证据，也不会把 repair 变成 verified fix。Protected 路径仍由 policy 阻止。

拒绝请求会让任务保持阻塞的 review 状态并记录决定。用户可以缩小任务，或为受保护的工作建立单独任务。

## OpenCode Desktop 中会看到什么

普通结果保持简洁：

```text
OpenCode++ ⚠ Human review

Need you
OpenCode++ needs permission to expand task scope.

Why
The task references a file outside the current edit boundary.

Do
Inspect the requested path and explicitly approve the scope expansion.

Continue
After approval, the boundary revision is updated and evaluation continues without prepare.
```

结构化结果和 `opencode_plusplus_dashboard` 会保留完整请求、受影响文件、边界版本、findings、证据新鲜度、介入记录和下一步动作。完整记录也可在 `.agent-context/sidecar/` 和 intervention ledger 中查看。

## 证据与继续执行保证

- 用户批准改变的是授权或范围，不是测试证据。
- 建议命令不是命令执行结果。
- 手工声明和外部 Context 不能满足严格的当前工作树证据要求。
- 后续源代码编辑会使之前的通过证据失效，并可能产生新的 review request。
- 插件失败会按 plugin failure 报告，不会在没有可执行解释时静默变成普通 `human-review`。
- 运行时不增加第二个模型调用，也不展示隐藏的模型思维链；展示的是已记录事实、findings 和确定性的决策输入。

当 `resumeCondition` 满足后，下一个插件 evaluate 会从持久化的 task/session 状态继续，不要求用户重复原始任务，也不会重新运行 prepare，除非请求明确说明仓库 Context 已过期。
