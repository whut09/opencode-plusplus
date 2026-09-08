# OpenCode++

[中文说明](README.zh-CN.md)

**A Windows-first Harness plugin for the official OpenCode Desktop application.**

OpenCode++ makes the work around an AI-generated diff visible and reviewable: what it inspected, what it blocked, what it asked to run, and what current evidence actually verified.

## What Problem It Solves

An AI coding session can produce a plausible diff while reading the wrong files, editing outside the intended scope, running an unrelated command, or declaring success without fresh test evidence. OpenCode++ adds a verification control plane around OpenCode Desktop so the model has to work from repository context, explicit edit boundaries, traceable evidence, and a final decision.

OpenCode++ is not another chat application and it is not a replacement model. It is a user-level Desktop plugin that observes the tools OpenCode already exposes and provides Harness tools for:

- selecting relevant files and symbols before blind search;
- preparing task boundaries and required checks;
- guarding commands and protected paths;
- recording sanitized execution evidence against the current working tree;
- evaluating policy, freshness, regression, hallucination, and convergence gates;
- explaining whether the next action is repair, repack, human review, or finalize.

## System Architecture

![OpenCode++ system architecture](docs/images/opencode-plusplus-architecture.svg)

The important boundary is simple: OpenCode still reads files, edits code, and runs commands. OpenCode++ supplies deterministic context, boundaries, evidence checks, and decisions around that work.

| Layer                        | What OpenCode++ does                                                                                    | What it does not claim                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Context Registry + Retrieval | Finds relevant packs, files, symbols, versions, and dependencies; explains selected and rejected files. | Context is guidance, not permission or proof.                           |
| Guard + Policy               | Checks commands, protected paths, contracts, freshness, regression, and required actions.               | It is not an operating-system sandbox.                                  |
| Evidence                     | Matches command or CI results to the current working-tree hash and active evidence policy.              | A passing command alone does not prove business correctness.            |
| Intervention Ledger          | Records observed, prevented, requested, repaired, verified, unresolved, and human-review states.        | Prevention or suggestion is not a verified fix.                         |
| Decision + Dashboard         | Returns the next allowed action and shows the recorded facts in the Desktop result and local artifacts. | It does not expose hidden model chain-of-thought or call another model. |

The normal Desktop path uses one current OpenCode model and one in-process plugin. CLI and MCP remain developer/compatibility surfaces; they are not required for installation or daily use.

## What It Can Do Now

The Windows installer adds one selectable OpenCode primary mode named **OpenCode++**. Select it from the mode picker shown at the bottom of the prompt box, then describe the coding task normally. There are no OpenCode++ Slash Commands to remember.

![Select the OpenCode++ mode](docs/images/opencode-plusplus-mode.png)

When the mode is selected, its prompt instructs the current OpenCode model to use the in-process plugin tools. The plugin does not start a second model or a CLI process. It runs inside OpenCode Desktop and writes auditable runtime artifacts into the repository's `.agent-context/` directory.

The EXE installer is per-user, works on Windows x64, and does not require Administrator permission.

By default the plugin works offline: it does not fetch remote Context sources and does not call a second model. A configured remote source or feedback transport must be explicitly enabled. The active OpenCode model remains responsible for reading, editing, and running commands; OpenCode++ supplies deterministic tools and gates around that work.

## Install And Use

1. Download `opencode-plusplus-setup-win-x64.exe` from [GitHub Releases](https://github.com/whut09/opencode-plusplus/releases).
2. Fully exit OpenCode Desktop.
3. Double-click the EXE and accept the installation message.

![Installer confirmation](docs/images/opencode-plusplus-installer.png)

4. Restart OpenCode Desktop and open a repository.
5. Select **OpenCode++** in the mode picker.
6. Enter a normal request, such as `Fix the login timeout and add a regression test`.
7. Let the selected mode call `prepare`, `retrieve`, `evaluate`, and `next` while it works. Do not switch back to Build for a task that needs the Harness gates.
8. Read the compact status after `evaluate` or `next`. Call `opencode_plusplus_dashboard` when you want stage progress, selected and rejected files, decision basis, evidence freshness, interventions, and the final summary.
9. Inspect `.agent-context/` when you need the trace, findings, required commands, or final report.

The installer writes only these OpenCode configuration files:

```text
<OpenCode config>\plugins\opencode-plusplus.js
<OpenCode config>\agents\opencode-plusplus.md
<OpenCode config>\opencode-plusplus\state.json
<OpenCode config>\opencode-plusplus\installation.json
```

It removes files from older releases that created Slash Commands or patched `app.asar`. It no longer changes the OpenCode Desktop bundle. The default configuration directory is `%USERPROFILE%\.config\opencode`; `OPENCODE_CONFIG_DIR` takes precedence.

## Reports And Boundaries

Runtime evidence is local to each repository:

- `.agent-context/traces/` contains execution and test evidence;
- `.agent-context/runs/` contains task context and edit boundaries;
- `.agent-context/loops/` contains decisions and convergence state;
- `.agent-context/sidecar/latest.md` contains the latest verification summary.
- `.agent-context/sidecar/visualization.json` contains the latest structured Harness Dashboard snapshot.

The plugin is not an operating-system sandbox. It cannot stop another application from editing a file, prove business semantics from an exit code, or guarantee that an opaque tool argument is correctly classified. A passing command is evidence, not a complete correctness proof. Blocking results require the selected mode to repair or request human review.

### What The User Sees

The Desktop tool result defaults to a compact `OpenCode++ ✓ Verified`, `✗ Repair required`, or `⚠ Human review` status. The structured JSON still contains `actionSummary` with `observed`, `prevented`, `requested`, `repaired`, `verified`, and `unresolved` items. Call `opencode_plusplus_dashboard` for the full `Plan -> Prepare -> Retrieve -> Execute -> Collect -> Evaluate -> Decide -> Persist -> Finalize` view with decision basis, evidence freshness, intervention counts, and selected/rejected files. See [Harness Output](docs/reference/harness-output.md).

The dashboard exposes recorded system facts and decision inputs. It does not expose hidden model chain-of-thought. This keeps the view useful for debugging and review without presenting private internal reasoning as an auditable fact.

The Desktop result and `.agent-context/sidecar/latest.md` distinguish these questions:

- **Intervened files:** files selected for inspection, edited within the boundary, or rejected with a reason;
- **Blocked risks:** unsafe commands, protected paths, stale Context, missing tests, policy violations, or unresolved regressions;
- **Suggested fixes:** requested actions or executor-reported edits that still need evidence;
- **Verified fixes:** repairs followed by fresh command or CI evidence for the current working tree;
- **Human work:** unresolved findings, repeated no-progress states, or semantic decisions the Harness cannot prove.

`verified fix` is therefore narrower than `suggested fix`. An annotation, Context document, manual claim, successful earlier test, source edit, commit list, or model-generated summary cannot become verified merely because it looks plausible. External Context is untrusted guidance, and annotation is local knowledge, not policy. When the result says `human-review`, read the exact missing evidence in `actionSummary.evidence`; it is not a request to repeat the task.

Context cache and registry usage are stored under `.agent-context/cache/` and `.agent-context/context-registry/usage/`. Local feedback is stored under `.agent-context/context-registry/feedback/`, annotations under `.agent-context/knowledge/annotations/`, and intervention records under `.agent-context/interventions/`. These are local runtime artifacts and should normally remain uncommitted.

On Windows, paths with spaces and non-ASCII characters are supported, but the plugin still depends on the active user's permissions, the repository being writable, and OpenCode Desktop loading the configured plugin directory. Antivirus locks, read-only folders, unavailable network sources, invalid registry content, and permission failures are reported as diagnostics or human-review states; they are not converted into successful verification.

## Customize Your Own Harness

OpenCode++ is intentionally an extension point. If OpenCode feels too permissive, too strict, or simply does not match your team's workflow, fork or extend the plugin and define your own Harness policy instead of hiding the problem in a prompt.

Useful customization points include:

- the primary agent prompt in `src/installer/opencode-plusplus-prompts.ts`;
- command and protected-path rules in `src/integrations/opencode/plugin-runtime/`;
- retrieval ranking in `src/retrievers/` and `src/core/ranker.ts`;
- evidence trust and freshness in `src/outputs/evidence.ts` and `src/harness/verification-plane/`;
- loop stopping and decision arbitration in `src/harness/control-plane/`;
- Desktop-specific tool behavior in `src/integrations/opencode/plugin-runtime/harness/`.

The safe customization pattern is: add a test for the desired policy, change the plugin or agent mode, run the full checks, and distribute a new checksummed Windows installer. Keep the Harness explicit about what it can observe and what remains a human decision.

## Contributing

1. Fork the repository and create a focused branch.
2. Read `AGENTS.md`, the relevant source files, and the matching English and Chinese documentation.
3. Add or update deterministic tests before changing behavior.
4. Keep Desktop runtime artifacts, `dist/`, installer staging, secrets, and local `.agent-context/` files out of commits.
5. Run `npm run check`, `npm run lint`, `npm run format:check`, `npm run docs:bilingual:check`, and `npm test`.
6. For installer changes, also run `npm run build:installer:windows`, `npm run test:installer:windows`, and `npm run release:verify` on Windows.
7. Update both language versions of user-facing documentation and explain compatibility boundaries in the pull request.

See [the documentation index](docs/README.md), [Windows architecture](docs/concepts/windows-plugin-architecture.md), and [the contribution guide](CONTRIBUTING.md).

## Developer Compatibility Surface

The repository retains CLI and MCP entry points for source development, CI, diagnostics, and compatibility integrations. They are not the normal Desktop installation path and are not required by ordinary users.

## License

[MIT](LICENSE)
