# OpenCode++ Documentation

[中文目录](README.zh-CN.md) | English

OpenCode++ is a Windows-first Harness plugin for the official OpenCode Desktop. Install the EXE, select the **OpenCode++** primary mode, and let it provide context, edit boundaries, evidence, and verification decisions around normal coding work. CLI and MCP are developer/compatibility surfaces, not user installation paths and not a second Desktop application.

![OpenCode++ system architecture](images/opencode-plusplus-architecture.svg)

The product has one normal user path: OpenCode Desktop plus the installed in-process plugin. The current OpenCode model still performs the coding work. OpenCode++ makes the surrounding control loop visible: Context and Retrieval select what matters, Guards define what is allowed, Evidence checks what is actually proven, and the Intervention Ledger explains what was observed, blocked, requested, repaired, verified, or left unresolved.

## Start Here

Read these in order if OpenCode++ is new to you: install the Windows plugin, understand the product boundary, then inspect the architecture and the visible Desktop results.

| Goal                                               | Document                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Install, upgrade, disable, or uninstall on Windows | [OpenCode Desktop on Windows](integrations/opencode-desktop.md)                       |
| Understand the plugin and its hard boundaries      | [Windows plugin architecture and boundaries](concepts/windows-plugin-architecture.md) |
| Understand the product boundary (CLI/MCP internal) | [Product Boundary](developer/product-boundary.md)                                     |
| Start in five minutes                              | [Getting Started](getting-started.md)                                                 |
| Understand the global event-driven runtime         | [OpenCode Global Sidecar](integrations/opencode-sidecar.md)                           |
| Understand context, guards, evidence, and loops    | [Architecture](concepts/architecture.md)                                              |
| Understand Desktop and developer entry boundaries  | [Integration Modes](concepts/integration-modes.md)                                    |
| Operate the CLI (developer surface)                | [CLI Reference](reference/cli-reference.md)                                           |
| Configure evidence trust                           | [Configuration](reference/config.md)                                                  |
| Choose minimal verification commands               | [Smart Verification Planner](reference/verification-planner.md)                       |
| Understand native permission versus semantic guards | [Permission And Guard Boundaries](reference/permission-boundaries.md)                  |
| Rate Context quality without sending source code   | [Context Feedback](reference/context-feedback.md)                                     |
| Build and publish releases                         | [Release Checklist](release.md)                                                       |
| Contribute or customize the Harness                | [Contribution Guide](../CONTRIBUTING.md)                                              |

## Concepts

- [Positioning](concepts/positioning.md)
- [Windows Plugin Architecture](concepts/windows-plugin-architecture.md)
- [Architecture](concepts/architecture.md)
- [Guard Modules](concepts/guard-modules.md)
- [Integration Modes](concepts/integration-modes.md)
- [Loop Engineering](concepts/loop-engineering.md)

## Windows and Integrations

- [OpenCode Desktop on Windows](integrations/opencode-desktop.md)
- [OpenCode Global Sidecar](integrations/opencode-sidecar.md)
- [OpenCode MCP](integrations/opencode-mcp.md)
- [Codex MCP](integrations/codex-mcp.md)
- [Claude Code MCP](integrations/claude-code-mcp.md)
- [Cursor MCP](integrations/cursor-mcp.md)
- [Executor CLI](integrations/executor-cli.md)
- [MCP Troubleshooting](integrations/mcp-troubleshooting.md)

## Developer Documentation

- [Product Boundary](developer/product-boundary.md)
- [Source Walkthrough](developer/source-walkthrough.md)
- [Runtime State Machine](developer/runtime-state-machine.md)
- [Guard Gate Schema](developer/guard-gate-schema.md)
- [Benchmark Guide](developer/benchmark-guide.md)
- [Desktop Harness Usability Baseline](developer/usability-baseline.md)

## Reference

- [CLI Reference](reference/cli-reference.md)
- [CLI Help Snapshot](reference/cli-help-snapshot.md)
- [MCP Tools](reference/mcp-tools.md)
- [Configuration](reference/config.md)
- [Artifacts](reference/artifacts.md)
- [Generated Files](reference/generated-files.md)
- [Executor Adapters](reference/executor-adapters.md)
- [Retrieval Providers](reference/retrieval.md)
- [Smart Verification Planner](reference/verification-planner.md)
- [Permission And Guard Boundaries](reference/permission-boundaries.md)
- [Context Feedback](reference/context-feedback.md)
- [Release Checklist](release.md)
- [Roadmap](roadmap.md)

Each maintained English page has a Chinese page next to it with the .zh-CN.md suffix. The CLI help snapshot is generated canonical output; the Chinese CLI reference explains the same command groups and links to that snapshot.
