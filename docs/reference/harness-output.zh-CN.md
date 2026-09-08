# Harness 输出

[English](harness-output.md) | 中文

OpenCode++ 使用两层输出：普通编码时保持结果简洁，同时保留完整的审计信息。

## Compact status

`prepare`、`retrieve`、`evaluate` 和 `next` 返回结构化 JSON。默认 `humanReadable` 是简洁状态：

```text
OpenCode++ ✓ Verified

Changed
3 files

Checks
✓ npm test
✓ npm run typecheck

Status
Ready to finalize
```

当前检查失败时会明确显示：

```text
OpenCode++ ✗ Repair required

Failed
npm test

Next
Fix test/auth/session.test.ts.
```

源代码发生修改但没有可执行验证命令时会显示：

```text
OpenCode++ ⚠ Human review

Need you
No executable verification command was found for source changes.

Suggested
Configure a test command or manually review the diff.
```

简洁文本只显示非空的高信号动作类别。未执行的命令不会被描述成通过检查，而会标为建议或下一步。

## 结构化 Action Summary

JSON 中的 `actionSummary` 继续作为兼容和审计接口，即使类别为空也保留所有字段：

- `observed`：记录了文件、finding、状态或 Context 信号；
- `prevented`：阻止了边界、命令或 policy 风险；
- `requested`：循环继续前必须采取动作；
- `repaired`：介入改变了状态，但还没有验证；
- `verified`：新鲜 command 或 CI evidence 匹配当前工作树；
- `unresolved`：仍有活动 blocker。

结构化 `visualization`、`interventions`、`findings`、`missingEvidence` 和 `requiredCommands` 也会保留，供 artifact 和 API client 使用。

## 详细 Dashboard

需要完整视图时调用 `opencode_plusplus_dashboard`。它包括：

- Plan 到 Finalize 的阶段进度；
- 选中和排除的文件及排除原因；
- 边界、finding、缺失证据和必跑命令；
- 工作树 hash 和 evidence freshness；
- 介入统计和 decision 依据；
- 最终 decision 和下一步动作。

`human-review` 结果还会提供独立的 `dashboard` 字段，因此简洁状态仍然易读，同时完整事实仍可审核。快照保存在 `.agent-context/sidecar/visualization.json`，最近的人类可读报告保存在 `.agent-context/sidecar/latest.md`。

Dashboard 展示已记录事实和确定性的 decision 输入，不展示模型隐藏思维链，也不会增加第二个模型调用。

## Toast 状态迁移

Toast 是状态变化通知，不是每个 finding 的逐条日志。OpenCode++ 对每个迁移最多发送一次去重 Toast：

- verification started；
- repair required；
- human review required；
- verified。

相同 decision 和 evidence 状态不会重复通知。详细事件仍写入 sidecar trace 和 intervention ledger。

## 什么才算 verified

`✓` 表示 Harness 找到了与当前工作树 hash 对应的有效 command 或 CI evidence。这不代表模型解释、手工声明、旧测试、Context Pack 或 annotation 已成为证明。命令成功只是 gate 的证据，业务正确性仍可能需要人工审核。
