# Integration Modes and Entry Boundaries

[中文](integration-modes.zh-CN.md) | English

OpenCode++ has one end-user product path: the Windows plugin installed into the official OpenCode Desktop. CLI and MCP remain developer and compatibility surfaces. They share application services and Harness rules, but they are not alternative Desktop interfaces.

## Product Path: OpenCode Desktop

The normal user flow is:

```text
Download EXE -> install per user -> restart OpenCode Desktop
  -> select OpenCode++ primary mode
  -> describe the task normally
  -> OpenCode model uses in-process OpenCode++ tools
```

The current OpenCode model still reads files, edits code, and runs commands. The plugin adds deterministic context selection, edit boundaries, command/path guards, evidence capture, policy evaluation, intervention records, and the next-action decision. It does not start a second model, spawn the OpenCode++ CLI, add Slash Commands, or modify `app.asar`.

The current Desktop tool names are:

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

The primary mode instructs the current model to call `prepare` before editing, use `retrieve` when it needs context, preserve required command evidence, call `evaluate` after edits, and call `next` before claiming completion. The plugin returns `finalize` only when the current gates permit it.

## What Desktop Reports

Every rendered Harness result includes a structured `actionSummary`. Normal `humanReadable` output is a compact status; the full Dashboard is available through the explicit `opencode_plusplus_dashboard` tool and in human-review results. The categories remain deliberately separate:

| Category     | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `observed`   | OpenCode++ recorded a file selection, finding, or state signal.                  |
| `prevented`  | A command, path, policy, or boundary risk was blocked.                           |
| `requested`  | The Harness requires an action, such as running a test or inspecting a caller.   |
| `repaired`   | An intervention moved to repaired, but current evidence has not verified it yet. |
| `verified`   | A valid command or CI result matches the current working-tree hash.              |
| `unresolved` | A blocker or review item remains active.                                         |

The structured result and Dashboard show selected and rejected files, findings, required commands, evidence freshness, decision, next action, and the current working-tree hash. Compact output omits empty categories and labels unexecuted commands as suggestions. Commit lists, model explanations, and test claims that were not captured by the plugin are not OpenCode++ actions. `human-review` reports the exact missing evidence or boundary decision; it does not mean the user must repeat the entire task. See [Harness Output](../reference/harness-output.md).

## Developer Surface A: Agent-Led Compatibility

An external agent can call the CLI or stdio MCP tools while it remains the active controller:

```text
External agent -> OpenCode++ application service
  -> context / retrieval / tests / impact / policy / verify
  -> external agent decides which returned action to perform
```

This surface is useful for CI integrations, MCP clients, repository diagnostics, and agents that already have their own execution loop. The returned findings and gates are available to the host agent, but OpenCode++ cannot guarantee that the host agent follows them.

The CLI and MCP entries are documented under [CLI Reference](../reference/cli-reference.md), [MCP Tools](../reference/mcp-tools.md), and the integration guides. They are not required for Desktop installation or daily Desktop use.

## Developer Surface B: Harness-Led Automation

The CLI orchestrator can own a bounded automation loop and use an external coding agent as an executor:

```text
CLI orchestrator
  -> plan and task pack
  -> executor invocation
  -> diff and trace collection
  -> Guard / Policy / Evidence / Impact evaluation
  -> deterministic decision
  -> continue, repair, repack, block, rollback, or human-review
```

Example for CI or a local automation experiment:

```powershell
opencode-plusplus orchestrate "fix login timeout bug" . --executor mock --max-loops 3 --fail-on required
```

Real executor commands are an advanced automation feature. They are parsed as argv-style commands without a shell, and shell control operators are rejected. The executor performs the actual edit; OpenCode++ collects its output and evaluates the resulting repository state. A `mock` run validates Harness behavior and is not a real Agent success measurement.

Harness-led artifacts include task packs, per-iteration executor results, trace events, Guard findings, policy, verification, loop state, decision state, and the orchestrator report under `.agent-context/`. The orchestrator can resume a persisted run by run ID and stops on `finalize`, `block`, `rollback`, `human-review`, repeated no-progress state, or the configured loop limit.

## Shared Rules and Hard Boundaries

All surfaces use the same core rules:

- Context and annotations are advisory and untrusted; they do not grant command authority.
- Only fresh command or CI evidence matched to the current working tree can verify a repair.
- A successful command is evidence, not proof of business correctness.
- `prevented`, `requested`, and `repaired` must not be displayed as `verified`.
- External Context cannot satisfy tests, contracts, freshness, forbidden-path checks, or finalize conditions.
- Runtime state, trace, report, registry, annotation, and feedback writes use the atomic storage boundary.
- The plugin is not an operating-system sandbox and cannot control other applications.
- OpenCode++ does not automatically commit, push, merge, or destructively roll back the user's working tree.

Use the Desktop path for normal interactive work. Use CLI or MCP only when integrating OpenCode++ with development tooling, CI, or another agent host.
