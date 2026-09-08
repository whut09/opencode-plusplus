# Desktop Harness Usability Baseline

[中文](usability-baseline.zh-CN.md) | English

This document records the Stage 0 cost of a normal OpenCode Desktop task with the **OpenCode++** primary mode. It is a measurement baseline, not a claim that the current workflow is optimal.

## Scope and Boundary

The baseline covers the in-process Desktop plugin only:

```text
user task -> OpenCode++ mode -> prepare/retrieve -> model edit -> real command hook -> evaluate/next
```

The current OpenCode model remains the only model. The tests do not start a second model, spawn the CLI, patch `app.asar`, or change production Harness behavior. They use a temporary Git repository and invoke the same plugin hooks and tools exposed to Desktop.

The baseline separates two kinds of work:

- **Model-visible Harness steps** are calls to `prepare`, `retrieve`, `evaluate`, `next`, or `dashboard`.
- **Automatic runtime steps** are recorded sidecar events. Pure `sidecar.log` diagnostic events are excluded from this count; lifecycle, hook, evidence, and intervention events remain visible.

## Metrics

`HarnessUxMetrics` is defined in `test/support/harness-ux-metrics.ts` and records:

| Metric                     | Meaning                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harnessToolCalls`         | Every instrumented `opencode_plusplus_*` tool call.                                                                                                           |
| `modelVisibleHarnessSteps` | Calls to the five core workflow tools: `prepare`, `retrieve`, `evaluate`, `next`, and `dashboard`.                                                            |
| `automaticRuntimeSteps`    | Non-diagnostic sidecar events generated without another model call.                                                                                           |
| `duplicateEvaluations`     | An `evaluate` repeated with the same arguments and working-tree hash.                                                                                         |
| `userInterruptions`        | Explicit user stop/interruption events recorded by the fixture.                                                                                               |
| `userApprovals`            | Explicit approval events recorded by the fixture.                                                                                                             |
| `humanReviews`             | Tool results whose terminal decision or next action is `human-review`; an intervention warning alone is not counted here.                                     |
| `verificationCommands`     | Real command executions captured by the Desktop hook, including failed attempts. A command returning 0 is evidence input, not automatic proof of correctness. |
| `finalDecision`            | The last structured Harness decision observed in the workflow.                                                                                                |

The tests intentionally do not count a model-generated summary as evidence. Command evidence comes from the actual command hook, exit code, output hashes, and working-tree hashes.

## Current Workflow Cases

The contract tests live in `test/harness-ux-baseline.test.ts`. Counts below are the current expected shape; later UX work may reduce them, but any change should update the comparison deliberately.

| Case | Workflow                                                                                               | Harness calls | Model-visible steps | Duplicate evaluations | User approvals | Human reviews | Verification commands | Current final decision |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------: | ------------------: | --------------------: | -------------: | ------------: | --------------------: | ---------------------- |
| A    | prepare -> retrieve -> edit -> test -> contract check -> evaluate -> next -> dashboard                 |             5 |                   5 |                     0 |              0 |             0 |                     2 | `run-tests`            |
| B    | failed test -> evaluate/next -> repair -> passing test -> contract check -> evaluate/next -> dashboard |             7 |                   7 |                     0 |              0 |             0 |                     3 | `run-tests`            |
| C    | docs-only edit -> evaluate -> next -> dashboard                                                        |             5 |                   5 |                     0 |              0 |             0 |                     0 | `ready-for-review`     |
| D    | source edit with no executable verifier -> evaluate -> next -> dashboard                               |             5 |                   5 |                     0 |              0 |    at least 1 |                     0 | `human-review`         |
| E    | Build agent selected; hooks and tools are probed but remain inactive                                   |             0 |                   0 |                     0 |              0 |             0 |                     0 | none                   |

`automaticRuntimeSteps` is reported for every case but is not asserted to one fixed number because the ready-context debounce and high-signal notification events are timing- and state-dependent. The contract does assert that the Build case produces zero runtime events.

## Stage 4 Display Baseline

Stage 4 changes presentation, not the workflow counts above. The same structured result remains available to the model, API clients, artifacts, and Dashboard, while ordinary human-readable output uses one compact status:

- `OpenCode++ ✓ Verified` when current evidence allows finalization;
- `OpenCode++ ✗ Repair required` when a check or gate blocks progress;
- `OpenCode++ ⚠ Human review` when the Harness cannot prove the required condition.

The compact view omits empty action categories and never labels an unexecuted recommended command as a passed check. `opencode_plusplus_dashboard` remains the explicit detailed view; human-review results also expose a `dashboard` field. Toasts are deduplicated transitions (`verification started`, `repair required`, `human review required`, and `verified`), not one notification per intervention.

## What This Baseline Shows

### A and B: evidence ordering cost

The ordinary bugfix and repair-loop fixtures run real commands and capture exit codes. In the current implementation, the sidecar record for a command also carries the repository's changed-file set. The evidence evaluator can therefore classify that command record as the latest edit and mark the test evidence stale. The observed decision remains `run-tests` even after a command returns 0.

This is deliberately recorded rather than silently corrected in Stage 0. A later optimization must prove that command evidence is selected after the actual edit, that old failures are superseded by newer equivalent results, and that a later edit makes earlier success stale.

### C: docs-only cost

The Smart Verification Planner classifies a documentation-only diff before the loop chooses a command. When no Markdown or documentation verifier is configured, it sets `codeTestRequired: false` and `verificationRequired: false`. The loop therefore avoids a fake `run-tests` blocker and reaches `ready-for-review` without claiming that the documentation content is semantically verified. If a docs verifier is configured, it is recommended explicitly instead of silently running the full code suite.

### D: missing verification is a real review boundary

With no executable test, check, or contract script, the plugin stops at `human-review`. No manual statement is converted into test evidence, and no automatic command is invented.

### E: Build isolation

When the active OpenCode agent is `build`, the plugin does not initialize workflow state, guard shell/file hooks, append trace events, or expose an active Harness result. Selecting Build therefore does not activate OpenCode++ behavior on that turn.

## Re-run the Baseline

Run the focused contract file during UX work:

```powershell
node --import tsx --test test/harness-ux-baseline.test.ts
```

Before merging a Stage 0 change, run the repository checks as well:

```powershell
npm run check
npm run lint
npm run format:check
npm run build
npm test
```

The fixture creates temporary repositories under the Windows user temp directory and removes them in `finally` blocks. It does not commit `dist/`, release files, `.agent-context/` runtime output, caches, or secrets.

## Comparison Rule for Later Stages

Future UX changes may reduce model-visible steps, duplicate evaluation, interruptions, or unnecessary verification. They must preserve these invariants:

1. Build remains inactive.
2. Real command evidence remains distinguishable from suggestions and manual claims.
3. A failed verification cannot be reported as a verified fix.
4. A successful result becomes stale after a later edit.
5. `human-review` remains reserved for an actual missing verifier, unresolved blocker, timeout, or semantic decision outside the Harness boundary.

Update this page and the paired Chinese page when the measured workflow intentionally changes.
