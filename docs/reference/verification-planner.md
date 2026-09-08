# Smart Verification Planner

[中文](verification-planner.zh-CN.md) | English

The Smart Verification Planner turns a repository diff into a small, explainable set of **recommended verification commands**. It is a planning layer for the Harness; it does not execute commands and it never creates Evidence ledger entries.

## Why it exists

Running the same full test suite for every task is slow and noisy. A documentation edit should not require a monorepo build, while a dependency or cross-module change should not be validated with only one focused test. The planner uses repository metadata and the real changed-file list to choose an appropriate minimum.

The boundary is deliberate:

```text
repository files + real diff
        -> discovery
        -> deterministic classification
        -> cost-aware plan
        -> user/agent may execute a command
        -> command hook records Evidence
        -> Policy and Loop evaluate freshness
```

Discovery is not execution. A line such as `npm run test` in a plan is a recommendation until the Desktop command hook or CI importer records exit code, output hashes, and the current working-tree hash.

## Discovery sources

`discoverVerificationCommands()` reads local configuration without starting a subprocess. It recognizes:

- Node `package.json` scripts (`test`, `lint`, `typecheck`, `check`, `build`, and documentation checks), including declared workspaces;
- Python `pyproject.toml`, `pytest.ini`, `tox.ini`, and pytest/Ruff/mypy configuration in `setup.cfg`;
- Rust `Cargo.toml` (`cargo test`, `cargo check`, `cargo build`);
- Go `go.mod` (`go test ./...`, `go vet ./...`, `go build ./...`);
- `Makefile`, `Justfile`, and recognized test/lint/check/build targets;
- CI workflow files, as lower-confidence local recommendations;
- TypeScript and ESLint project configuration when no corresponding package script exists.

Each result contains:

| Field           | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `command`       | The command a user or agent may choose to run.                      |
| `cwd`           | The absolute working directory for the command.                     |
| `source`        | The file or source kind that caused discovery.                      |
| `scope`         | `file`, `package`, `workspace`, or `repository`.                    |
| `estimatedCost` | `low`, `medium`, or `high`; it is a scheduling hint, not a timeout. |
| `confidence`    | Deterministic metadata confidence: `high`, `medium`, or `low`.      |
| `reason`        | A human-readable explanation for the recommendation.                |

Malformed configuration produces a diagnostic. It is not silently converted into an empty successful registry or a passed verification result.

## Change classification

`classifyVerificationChanges()` uses normalized paths, file kinds, package boundaries, and the existing dependency graph. It does not use an LLM.

| Classification        | Typical signal                                                         | Default verification intent                                             |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `docs-only`           | `README*`, `docs/**`, `*.md`, `*.mdx` only                             | No code test; run a docs verifier only if one is configured.            |
| `tests-only`          | Test directories and test/spec filenames only                          | Run affected tests.                                                     |
| `source-local`        | Source changes inside one module/package                               | Changed-file lint, affected tests, then local typecheck when available. |
| `source-cross-module` | Multiple modules or package boundaries                                 | Add workspace tests and broader type checks.                            |
| `config`              | Runtime, compiler, or project configuration                            | Validate affected package and configuration consumers.                  |
| `dependency`          | Manifest or lockfile changes                                           | Add workspace checks and build when available.                          |
| `build-system`        | Build scripts/configuration, Cargo/Make/Just build inputs              | Include typecheck/build according to discovered commands.               |
| `ci`                  | CI workflow or pipeline files                                          | Validate the commands represented by the changed workflow.              |
| `security-sensitive`  | Auth, session, credential, secret, payment, billing, or checkout paths | Preserve the underlying plan and add broader review signals.            |

Multiple kinds can apply. The primary kind is selected by a stable severity order, so array or filesystem enumeration order cannot change the result.

## Minimal plan

The planner follows this order and stops at the smallest set appropriate for the classification:

```text
changed-file lint
    -> affected package test
    -> package typecheck
    -> workspace test for broad-risk changes
    -> full build for dependency/build/CI/security changes when discovered
```

An affected workspace package is preferred over its root full-workspace script. Root/workspace commands are used as a fallback when no package-level verifier exists. Duplicate commands are removed using command, working directory, and kind, then stable ordering is applied.

The planner can use the existing test/dependency graph to turn a package test into a focused test-file command. It does not claim that the focused command passed.

## Docs-only and no-test repositories

For a docs-only diff, the plan returns `codeTestRequired: false`. If no Markdown or documentation verifier is discovered, `verificationRequired` is also false, so Loop does not create a fake `run-tests` blocker or human-review request. If a configured docs verifier exists, it is returned as an optional-to-run docs command.

For a source/config diff with no executable verifier, `codeTestRequired` remains true, `commands` is empty, and `verificationRequired` remains true. Loop then reports human review because a person must choose or configure the repository check; the planner never invents a command.

## Evidence and freshness

The planner does not weaken `evidenceSatisfies()`:

- only a command or CI record with the configured evidence policy can satisfy strict requirements;
- the result must have a successful exit code and the current working-tree hash;
- evidence must be after the latest relevant edit;
- a later edit makes earlier passing evidence stale;
- Context, annotations, selector output, and planner recommendations are not test evidence.

Policy and Loop consume the same `VerificationPlan`. The report exposes its classification and command reasons, while the existing public `buildTestSelection()` API remains available for compatibility.

## Integration points

- Core planner: `src/core/verification/`
- Policy consumer: `src/harness/verification-plane/policy-engine.ts`
- Loop consumer: `src/harness/control-plane/loop-controller.ts`
- Task artifact: `.agent-context/runs/<task-id>/verification-plan.md`
- Desktop result: `verification` in the structured Harness result
- Shared application service: `src/application/verification-service.ts`

Use `npm test` and the focused `test/verification-planner.test.ts` suite to validate changes. Do not commit `.agent-context/` runtime output or generated build directories.
