# Permission And Guard Boundaries

[中文](permission-boundaries.zh-CN.md) | English

OpenCode++ deliberately separates user authorization from repository semantics:

| Layer | Owner | Meaning |
| --- | --- | --- |
| OpenCode Permission | OpenCode Desktop | Whether the user allows an operation. |
| OpenCode++ Policy Guard | OpenCode++ plugin | Whether the operation is valid for the task and repository boundary. |

## Compatibility Baseline

The repository's verified Desktop plugin baseline is OpenCode Desktop with `@opencode-ai/plugin` `1.18.18`. Its agent configuration schema accepts these permission keys:

```text
edit
bash
webfetch
doom_loop
external_directory
```

The OpenCode++ primary agent uses only this schema. It does not add unsupported `read` or `search` keys. Ordinary edit behavior is intentionally not overridden, so the user's existing host policy remains authoritative for normal project edits.

## Result Classes

The command guard returns one of three deterministic dispositions:

- `allowed`: no OpenCode++ policy block and no additional host consent signal;
- `approval-required`: OpenCode++ detected an operation that should be decided by OpenCode's native permission prompt;
- `policy-blocked`: OpenCode++ detected a semantic boundary violation and stops the tool before execution.

Approval-required examples include package installation, network-affecting Git or download commands, and paths outside the repository. The plugin records the result and does not throw, so OpenCode can ask the user.

Policy-blocked examples include destructive reset/clean/delete commands, unknown project scripts, protected generated or secret paths, and commands that would tamper with Harness evidence. The plugin throws before execution. This remains true when OpenCode is configured for automatic approval; host consent cannot grant a semantic exception.

The legacy `allowed` boolean remains in the result for compatibility. It is `false` only for `policy-blocked`; use `disposition` when the caller needs to distinguish all three cases.

## Primary Agent Override

The installed `agents/opencode-plusplus.md` contains a small agent-specific override:

- asks OpenCode for consent before package, network, remote Git, and external-directory operations;
- denies common destructive shell patterns and doom-loop behavior;
- asks before `webfetch`;
- leaves ordinary `edit` and all unrelated global permissions untouched.

This is not a replacement for the user's global OpenCode permission configuration. If the host does not support a rule, the plugin's deterministic policy boundary still applies to policy-blocked operations.

## Evidence Boundary

Permission approval is not verification evidence. A user approving `npm install` authorizes the command; only the resulting captured command or CI evidence can satisfy a Harness requirement. Likewise, an allowed edit is not proof that the task is correct. Guard, evidence freshness, policy, and finalization remain separate decisions.
