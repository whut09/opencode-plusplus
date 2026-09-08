# Harness Output

[中文](harness-output.zh-CN.md) | English

OpenCode++ has two output layers so normal coding work stays readable without losing audit detail.

## Compact status

`prepare`, `retrieve`, `evaluate`, and `next` return structured JSON. Their `humanReadable` field is compact by default:

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

When a current check fails, the result is explicit:

```text
OpenCode++ ✗ Repair required

Failed
npm test

Next
Fix test/auth/session.test.ts.
```

When OpenCode++ cannot prove a source change with an executable verifier:

```text
OpenCode++ ⚠ Human review

Need you
No executable verification command was found for source changes.

Suggested
Configure a test command or manually review the diff.
```

Only non-empty high-signal action categories may appear in compact text. The result never describes a recommended command as a passed check: an unexecuted command is shown as a suggestion or next action.

## Structured action summary

The JSON `actionSummary` remains the compatibility and audit interface. It keeps all categories even when a category is empty:

- `observed`: a file, finding, state, or context signal was recorded;
- `prevented`: a boundary, command, or policy risk was stopped;
- `requested`: an action is required before the loop can proceed;
- `repaired`: an intervention changed state but is not verified;
- `verified`: fresh command or CI evidence matches the current working tree;
- `unresolved`: a blocker remains active.

The structured `visualization`, `interventions`, `findings`, `missingEvidence`, and `requiredCommands` fields are also retained. They are the source of truth for artifacts and API clients.

## Detailed Dashboard

Use `opencode_plusplus_dashboard` when you want the full view. It includes:

- phase progress from Plan through Finalize;
- selected and rejected files and rejection reasons;
- boundaries, findings, missing evidence, and required commands;
- working-tree hash and evidence freshness;
- intervention counts and decision basis;
- final decision and next action.

Human-review results also expose a separate `dashboard` field so a compact status can remain readable while the complete recorded facts are available for review. The snapshot is persisted at `.agent-context/sidecar/visualization.json`; the latest human report is at `.agent-context/sidecar/latest.md`.

The Dashboard shows recorded facts and deterministic decision inputs. It does not expose hidden model chain-of-thought, and it does not add a second model call.

## Toast transitions

Toasts are state-change notifications, not a log of every finding. OpenCode++ emits at most one deduplicated toast for each transition:

- verification started;
- repair required;
- human review required;
- verified.

The same decision and evidence state does not repeatedly notify the user. Detailed events remain in the sidecar trace and intervention ledger.

## What counts as verified

`✓` means the Harness found valid command or CI evidence captured against the current working-tree hash. It does not mean the model's explanation, a manual claim, an old test run, a Context Pack, or an annotation is proof. A successful command is evidence for the gate; business correctness may still require human review.
