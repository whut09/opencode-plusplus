import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenCodePlusPlusSidecar } from "../src/integrations/opencode/plugin-runtime/index.js";
import { runOpenCodePlusPlusCli } from "../src/integrations/opencode/plugin-runtime/cli-runner.js";
import { exitCodeFromOutput } from "../src/integrations/opencode/plugin-runtime/evidence.js";
import { workflowStatePath } from "../src/integrations/opencode/plugin-runtime/harness/workflow.js";
import { normalizeToolExecuteAfter, normalizeToolExecuteBefore } from "../src/integrations/opencode/plugin-runtime/hook-input.js";
import { setOpenCodePlusPlusPluginEnabled } from "../src/integrations/opencode/plugin-runtime/state.js";
import { checkSidecarCommand } from "../src/integrations/opencode/sidecar-command-guard.js";

test("OpenCode plugin normalizes current before hook arguments", () => {
  const result = normalizeToolExecuteBefore(
    { tool: "shell", sessionID: "session-1", callID: "call-1" },
    { args: { command: "npm test", description: "run tests" } }
  );

  assert.equal(result.tool, "shell");
  assert.deepEqual(result.args, { command: "npm test", description: "run tests" });
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.callId, "call-1");
});

test("OpenCode plugin exposes persistent enable, disable, and status tools", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-state-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const tools = plugin.tool as Record<string, { execute: () => Promise<string> }>;

    assert.match(await tools.opencode_plusplus_status.execute(), /Enabled: yes/);
    assert.match(await tools.opencode_plusplus_disable.execute(), /Enabled: no/);
    assert.equal(existsSync(stateFile), true);
    assert.match(await tools.opencode_plusplus_status.execute(), /Enabled: no/);
    assert.match(await tools.opencode_plusplus_enable.execute(), /Enabled: yes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode plugin exposes a visible Harness dashboard", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-dashboard-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const tools = plugin.tool as Record<string, { execute: (args?: unknown) => Promise<string> }>;
    const dashboard = JSON.parse(await tools.opencode_plusplus_dashboard.execute()) as {
      ok: boolean;
      tool: string;
      visualization: { view: string; summary: string; stages: unknown[] };
      humanReadable: string;
    };
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.tool, "dashboard");
    assert.equal(dashboard.visualization.view, "harness-progress");
    assert.ok(dashboard.visualization.stages.length >= 5);
    assert.match(dashboard.humanReadable, /Harness Dashboard/);
    assert.equal(existsSync(path.join(root, ".agent-context", "sidecar", "visualization.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled OpenCode plugin keeps controls available and skips command guards", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-disabled-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const tools = plugin.tool as Record<string, { execute: () => Promise<string> }>;
    await tools.opencode_plusplus_disable.execute();

    const before = plugin["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>;
    await before({ tool: "shell", callID: "call-1" }, { args: { command: "git reset --hard" } });
    assert.match(await tools.opencode_plusplus_status.execute(), /Enabled: no/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled OpenCode plugin guard rejection tells the model what to run instead", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-guard-action-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const before = plugin["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await message({ sessionID: "session-guard", agent: "opencode-plusplus" });

    await assert.rejects(
      before({ tool: "shell", sessionID: "session-guard", callID: "call-1" }, { args: { command: "git reset --hard HEAD" } }),
      (error: Error) => {
        assert.match(error.message, /BLOCKED: Hard git reset/);
        assert.match(error.message, /Evidence: git reset --hard HEAD/);
        assert.match(error.message, /Do instead:/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled OpenCode plugin leaves approval-required commands to native permission", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-native-permission-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const before = plugin["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await message({ sessionID: "session-approval", agent: "opencode-plusplus" });

    await before({ tool: "shell", sessionID: "session-approval", callID: "call-install" }, { args: { command: "npm install zod" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode auto approval cannot bypass a policy-blocked command", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-auto-policy-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const before = plugin["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await message({ sessionID: "session-auto-policy", agent: "opencode-plusplus" });

    await assert.rejects(
      before({ tool: "shell", sessionID: "session-auto-policy", callID: "call-reset" }, { args: { command: "git reset --hard HEAD --auto" } }),
      /BLOCKED: Hard git reset/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Build mode is silent on the next turn while OpenCode++ mode keeps guards active", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-agent-scope-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    const before = plugin["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>;
    const tools = plugin.tool as Record<string, { execute: (args?: unknown, context?: unknown) => Promise<string> }>;

    await message({ sessionID: "session-mode", agent: "opencode-plusplus" });
    await message({ sessionID: "session-mode" });
    await assert.rejects(
      before({ tool: "shell", sessionID: "session-mode", callID: "call-plus" }, { args: { command: "Start-Sleep -Seconds 45" } }),
      /wait|等待/i
    );

    await message({ sessionID: "session-mode", agent: "build" });
    await before({ tool: "shell", sessionID: "session-mode", callID: "call-build" }, { args: { command: "Start-Sleep -Seconds 45" } });

    const inactive = JSON.parse(await tools.opencode_plusplus_prepare.execute({ task: "should not run" }, { sessionID: "session-mode", agent: "build" })) as {
      active: boolean;
      error: { code: string; retryable: boolean; nextStep: string };
    };
    assert.equal(inactive.active, false);
    assert.equal(inactive.error.code, "HARNESS_INACTIVE_AGENT");
    assert.equal(inactive.error.retryable, false);
    assert.match(inactive.error.nextStep, /new message/i);
    assert.equal(existsSync(path.join(root, ".agent-context", "runs", "should-not-run")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar rejects artificial wait commands instead of letting the Desktop loop sleep", () => {
  const result = checkSidecarCommand(".", { command: "Start-Sleep -Seconds 45" });
  assert.equal(result.allowed, false);
  assert.ok(result.findings.some((finding) => /wait|等待/i.test(finding.message)));
});

test("OpenCode plugin keeps compatibility with legacy before hook arguments", () => {
  const result = normalizeToolExecuteBefore({ tool: "write", args: { file: "src/index.ts" } }, undefined);

  assert.equal(result.tool, "write");
  assert.deepEqual(result.args, { file: "src/index.ts" });
  assert.equal(result.callId, undefined);
});

test("OpenCode plugin normalizes current after hook arguments and metadata", () => {
  const result = normalizeToolExecuteAfter(
    { tool: "shell", sessionID: "session-1", callID: "call-1", args: { command: "npm test" } },
    { output: "passed", metadata: { exit: 0 } }
  );

  assert.deepEqual(result.args, { command: "npm test" });
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.callId, "call-1");
  assert.equal(exitCodeFromOutput({ output: "passed", metadata: { exit: 0 } }), 0);
});

test("OpenCode plugin CLI runner preserves arguments without shell interpretation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-cli-"));
  const cliEntrypoint = path.join(root, "fake cli with spaces.mjs");
  try {
    writeFileSync(cliEntrypoint, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");

    const args = ["sidecar", "check-command", "npm run check && echo unsafe"];
    const result = runOpenCodePlusPlusCli(args, root, { runtimeExecutable: process.execPath, cliEntrypoint });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(String(result.stdout).trim()), args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode plugin event hooks survive corrupt workflow persistence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-hook-failure-"));
  const stateFile = path.join(root, "state.json");
  const workflowFile = workflowStatePath(root, "session-1");
  const diagnostics: string[] = [];
  try {
    mkdirSync(path.dirname(workflowFile), { recursive: true });
    writeFileSync(workflowFile, "{broken", "utf8");
    const plugin = await createOpenCodePlusPlusSidecar(
      {
        directory: root,
        client: { app: { log: ({ message }) => diagnostics.push(message) } }
      },
      { stateFile }
    );
    const eventHook = plugin.event as (input: { event?: Record<string, unknown> }) => Promise<void>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await message({ sessionID: "session-1", agent: "opencode-plusplus" });

    await eventHook({ event: { type: "file.edited", sessionID: "session-1", properties: { file: "src/index.ts" } } });

    assert.ok(diagnostics.includes("workflow initialization failed safely"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode plugin state reports revision conflicts without overwriting", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-state-conflict-"));
  const stateFile = path.join(root, "state.json");
  try {
    const disabled = setOpenCodePlusPlusPluginEnabled(false, stateFile, 0);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.revision, 1);

    const stale = setOpenCodePlusPlusPluginEnabled(true, stateFile, 0);
    assert.equal(stale.enabled, false);
    assert.equal(stale.revision, 1);
    assert.match(stale.diagnostic ?? "", /Revision conflict/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
