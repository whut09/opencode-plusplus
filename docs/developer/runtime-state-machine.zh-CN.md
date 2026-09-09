# 运行时状态机

[English](runtime-state-machine.md) | 中文

## 两种状态

Agent-led 状态写入 .agent-context/runs/<task-id>/state.json，记录 context、task、diff、evidence 和下一步动作。Harness-led Orchestrator 另写 .agent-context/orchestrator/<run-id>/state.json，记录 schemaVersion、phase、iteration、artifact references、trace、context fingerprint、working-tree hash、latest decision、convergence 和时间戳。

## 阶段迁移

```text
Plan -> PrepareSandbox -> Execute -> Collect -> Evaluate -> Decide -> Persist -> Finalize 或 Continue
```

每个阶段成功后原子持久化。resume <run-id> 从 currentPhase 恢复，已完成阶段不重复执行。未知 schemaVersion 必须明确报错，不能猜测兼容。

## 收敛

每轮 fingerprint 包含 working-tree hash、decision action、blocking finding/gate IDs、missing evidence、required commands、context freshness/drift。数组先去重排序后 hash，因此数组原始顺序不影响结果。

- progressing：允许下一轮；
- terminal：finalize、block、rollback 或 human-review 已终止；
- executor-failure：executor 失败或退出码未知；
- repeated-state：连续两轮阻塞 fingerprint 相同，转 human-review/no-progress；
- max-loops-reached：循环预算用尽，不能误报为 repeated-state。

## Sandbox

git-worktree sandbox 在准备成功、executor 失败、阶段异常、正常结束和 resume 后都必须清理。回滚记录 patch 和 decision，不对用户工作树自动执行破坏性命令。

## Desktop 任务恢复

Windows Desktop 插件为每个 `taskId` 和 `sessionId` 保存独立任务身份：

```text
.agent-context/sidecar/task-identity-<task-id>-<session-id>.json
```

新的 OpenCode++ session 激活时，插件只发现并记录候选，不会自动选择最近任务。`repositoryRoot` 必须匹配，且候选必须是未完成状态。latest 工作树指纹匹配时为 `resume-verification`；指纹变化时标记为 `stale-task`，必须明确重建 context 和 validation plan。其他仓库的候选只能提供诊断，不能恢复。

`opencode_plusplus_resume` 将 `inspect` 和 `resume` 分开。inspect 返回候选兼容性和持久化问题；resume 必须带 `confirmed: true` 和当前目标 session。兼容恢复会建立新的 session 关联并从 evaluate 继续，不会把旧输出冒充新验证。stale 恢复保留 task id，同时重建 context 和 validation plan。待处理 human-review 请求可以按 task/request id 跨 session 查找；批准后更新 boundary，并将任务恢复为 `dirty`，随后 evaluate 重新采集证据，不重新开始 prepare。
