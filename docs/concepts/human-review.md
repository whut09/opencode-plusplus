# Human Review: Why, What, And Resume

[中文](human-review.zh-CN.md) | English

OpenCode++ uses `human-review` only when a deterministic runtime decision cannot safely continue or cannot prove the required result. It is not a generic failure message and it is not an instruction to repeat the entire task.

## What The User Needs To Know

Every review request answers three questions:

1. **Why is a person needed?** The reason is a stable `reasonCode`, supported by findings and current repository state.
2. **What must the person do?** `requiredUserAction` names the approval, command, inspection, or repository decision that is missing.
3. **How does the task continue?** `resumeCondition` states the next safe runtime transition and the evidence that is still required.

The request is persisted as a structured artifact and is returned in plugin tool results:

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

The complete model also contains the task/session identity, request status, timestamps, boundary revision, and current/requested boundaries when relevant. It is stored below `.agent-context/sidecar/` and is written atomically.

## Reason Codes

| Code                          | Why review is needed                                                                                             | What the user does                                                                                      | What resumes the task                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `NO_EXECUTABLE_TEST`          | A source or configuration change has no executable verification command.                                         | Configure or run an appropriate current-working-tree check, or review and accept the unverified result. | Fresh command/CI evidence, or an explicit policy decision that the task is docs-only/non-code.                      |
| `BOUNDARY_EXPANSION_REQUIRED` | The task needs a path outside the current allowed edit boundary.                                                 | Inspect the requested files and explicitly approve the expansion.                                       | The boundary revision increments; the current task continues at evaluation without a new prepare.                   |
| `EXTERNAL_SIDE_EFFECT`        | The next action affects the network, package state, external paths, publishing, or another irreversible surface. | Approve or reject the host-side operation using the normal OpenCode permission flow.                    | The operation completes and the resulting state is evaluated with fresh evidence.                                   |
| `UNVERIFIABLE_RESULT`         | The observed result cannot prove the required contract or behavior.                                              | Supply a suitable verification route or make the semantic decision that automation cannot make.         | The required evidence is captured and evaluated against the current working tree.                                   |
| `PLUGIN_FAILURE`              | A plugin hook, protocol, persistence, or runtime operation failed.                                               | Inspect the structured error and affected artifact, then correct the plugin/runtime condition.          | The failed operation has a successful, diagnosable replacement result; it is not treated as verified automatically. |
| `AMBIGUOUS_REPOSITORY_STATE`  | Conflicting, unexpected, or incomplete repository state prevents a safe decision.                                | Inspect `git status`/the relevant diff and resolve or confirm the repository state.                     | The repository state is unambiguous and the current phase can be evaluated again.                                   |

The exact request is authoritative; suggested commands are guidance, not evidence and are never executed solely because they appear in Context or an annotation.

## Boundary Expansion Is An Approval, Not A Block

Suppose the current task allows `packages/auth/**`, but the implementation imports `packages/shared/token.ts`. OpenCode++ reports:

```text
Current:  packages/auth/**
Requested: packages/shared/token.ts
Reason:   the auth implementation imports token expiration logic from this module
```

The user can inspect the requested path and explicitly approve `opencode_plusplus_human_review` with `action: "approve"` and `confirmed: true`. OpenCode++ then:

1. verifies that the requested path is not a protected/avoid path;
2. adds the requested path to the allowed boundary;
3. increments `boundaryRevision`;
4. records the approval in the workflow and intervention artifacts; and
5. resumes the current task at evaluation without rebuilding the task with `prepare`.

Approval expands scope only. It does not approve a dangerous command, disable a Guard, create test evidence, or turn a repair into a verified fix. Protected paths remain policy-blocked.

Rejecting the request leaves the task in a blocking review state and records the decision. The user can then narrow the task or make a separate, explicit task for the protected work.

## What Appears In OpenCode Desktop

Normal results stay compact:

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

The structured result and `opencode_plusplus_dashboard` retain the detailed request, affected files, boundary revisions, findings, evidence freshness, interventions, and next action. Full records are also available in `.agent-context/sidecar/` and the intervention ledger.

## Evidence And Resume Guarantees

- A user approval changes authorization or scope; it is not test evidence.
- A suggested command is not a command result.
- Manual claims and external Context cannot satisfy a strict current-working-tree evidence requirement.
- A later source edit supersedes earlier passing evidence and can create a new review request.
- A plugin failure is reported as a plugin failure, not silently converted into `human-review` without an actionable explanation.
- The runtime does not add a second model call and does not expose hidden model chain-of-thought; it shows recorded facts, findings, and deterministic decision inputs.

When the stated resume condition is met, the next plugin evaluation continues from the persisted task/session state. It does not require the user to repeat the original task or rerun preparation unless the request explicitly says the repository context itself is stale.
