# Getting Started

[中文](getting-started.zh-CN.md) | English

OpenCode++ is a Windows plugin for OpenCode Desktop. It is useful when a plausible answer is not enough: the selected OpenCode model must gather repository context, stay inside explicit edit boundaries, produce current evidence, and explain why a task can or cannot be finalized.

## Five Minutes

1. Download the Windows EXE from [Releases](https://github.com/whut09/opencode-plusplus/releases).
2. Fully exit OpenCode Desktop, double-click the EXE, and wait for the confirmation message.
3. Restart OpenCode Desktop, open a repository, and select **OpenCode++** in the mode picker.
4. Describe a coding task normally. Do not start an OpenCode++ CLI command and do not add a second model.
5. After the task reaches `evaluate` or `next`, read the compact `OpenCode++` status at the top of the returned tool result.
6. Call `opencode_plusplus_dashboard` or open `.agent-context/sidecar/visualization.json` when you need the detailed phase view; open `.agent-context/sidecar/latest.md` for the latest report.

![OpenCode++ mode](images/opencode-plusplus-mode.png)

## What Happens

The mode prompt steers the current model through `retrieve` and `prepare` before edits, built-in shell execution for required commands, and `evaluate` plus `next` after edits. The plugin runs these tools in-process inside OpenCode Desktop. If a check is stale, missing, forbidden, or repeated without progress, the Harness reports the reason instead of silently claiming success.

The compact result answers the immediate question without printing every empty category:

- `✓ Verified`: current evidence allows finalization;
- `✗ Repair required`: a check or policy gate still blocks the task;
- `⚠ Human review`: OpenCode++ cannot prove the required condition automatically.

The structured result and detailed Dashboard answer six audit questions:

- `observed`: what OpenCode++ recorded;
- `prevented`: which command, path, or policy risk it blocked;
- `requested`: what must happen next;
- `repaired`: what was changed but is not verified yet;
- `verified`: which repair has fresh command or CI evidence for the current working tree;
- `unresolved`: what still blocks completion.

The current model may provide a natural-language task summary, but that summary is not the Harness record. Use `actionSummary`, the Dashboard, and `.agent-context/` when you need to know what OpenCode++ itself did. See [Harness Output](reference/harness-output.md) for the two display layers and Toast rules.

## If The Mode Is Missing

Fully exit OpenCode Desktop before installing or upgrading. After restarting, check the mode picker again. The installer writes to `%USERPROFILE%\.config\opencode` unless `OPENCODE_CONFIG_DIR` is set. The plugin is loaded from the active OpenCode configuration directory; installing the EXE while another Desktop process is still running does not refresh an already loaded plugin.

If an upgrade reports a damaged state or the mode still does not appear, run the EXE with `--doctor --json` from PowerShell for a read-only diagnosis, then use `--repair --json` after closing OpenCode Desktop. Repair only restores OpenCode++-owned files; it does not overwrite your OpenCode configuration.

## When To Customize

Use the default mode first. Fork or extend the plugin when your repository needs different protected paths, test trust, retrieval weighting, evidence policy, or loop stopping rules. Add a test for the new rule and keep the Windows installer and bilingual docs synchronized.

CLI and MCP are developer/compatibility surfaces. They are not needed for this installation path and are not called by the Desktop plugin.
