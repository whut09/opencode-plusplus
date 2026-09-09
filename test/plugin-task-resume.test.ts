import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/core/git.js";
import { createOpenCodePlusPlusSidecar } from "../src/integrations/opencode/plugin-runtime/index.js";
import { readTaskIdentity } from "../src/integrations/opencode/plugin-runtime/harness/task-resume.js";
import { readWorkflowState } from "../src/integrations/opencode/plugin-runtime/harness/workflow.js";

test("Desktop resume inspects and restores a compatible unfinished task into a new session", async () => {
  const root = createResumeFixture();
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, { execute: (args?: unknown) => Promise<string> }>;
    const prepared = readResult(await tools.opencode_plusplus_prepare.execute({ task: "fix login timeout", sessionId: "session-old" }));
    assert.equal(prepared.ok, true);

    const inspected = readResult(await tools.opencode_plusplus_resume.execute({ action: "inspect", sessionId: "session-new" }));
    assert.equal(inspected.resume?.status, "available");
    assert.equal(inspected.resume?.sourceSessionId, "session-old");
    assert.equal(inspected.resume?.selectedTaskId, prepared.taskId);

    const resumed = readResult(
      await tools.opencode_plusplus_resume.execute({
        action: "resume",
        taskId: prepared.taskId,
        sourceSessionId: "session-old",
        sessionId: "session-new",
        confirmed: true
      })
    );
    assert.equal(resumed.ok, true);
    assert.equal(resumed.resume?.status, "resumed");
    assert.equal(resumed.nextAction, "evaluate");
    assert.equal(readTaskIdentity(root, prepared.taskId!, "session-old")?.status, "abandoned");
    assert.equal(readTaskIdentity(root, prepared.taskId!, "session-old")?.resumedToSessionId, "session-new");
    assert.equal(readTaskIdentity(root, prepared.taskId!, "session-new")?.status, "verification-required");
    assert.equal(readWorkflowState(root, "session-new")?.resumedFromSessionId, "session-old");
    assert.equal(readWorkflowState(root, "session-new")?.taskId, prepared.taskId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop resume never restores an unknown candidate", async () => {
  const root = createResumeFixture();
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, { execute: (args?: unknown) => Promise<string> }>;
    const result = readResult(await tools.opencode_plusplus_resume.execute({ action: "resume", taskId: "missing", sessionId: "session-new", confirmed: true }));
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "RESUME_CANDIDATE_NOT_FOUND");
    assert.equal(readWorkflowState(root, "session-new"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop resume rebuilds context and validation for a stale task", async () => {
  const root = createResumeFixture();
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, { execute: (args?: unknown) => Promise<string> }>;
    const prepared = readResult(await tools.opencode_plusplus_prepare.execute({ task: "fix login timeout", sessionId: "session-old" }));
    writeFileSync(path.join(root, "src", "auth", "session.ts"), "export function loginSession() { return 'changed'; }\n", "utf8");

    const resumed = readResult(
      await tools.opencode_plusplus_resume.execute({
        action: "resume",
        taskId: prepared.taskId,
        sourceSessionId: "session-old",
        sessionId: "session-new",
        confirmed: true
      })
    );
    assert.equal(resumed.ok, true);
    assert.equal(resumed.resume?.status, "resumed");
    assert.equal(resumed.nextAction, "evaluate");
    assert.match(resumed.resume?.message ?? "", /rebuilt/i);
    assert.equal(readTaskIdentity(root, prepared.taskId!, "session-old")?.status, "abandoned");
    assert.equal(readTaskIdentity(root, prepared.taskId!, "session-new")?.status, "active");
    assert.equal(readWorkflowState(root, "session-new")?.phase, "prepared");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readResult(output: string): import("../src/integrations/opencode/plugin-runtime/harness/types.js").PluginHarnessResult {
  return JSON.parse(output) as import("../src/integrations/opencode/plugin-runtime/harness/types.js").PluginHarnessResult;
}

function createResumeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-resume-"));
  mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  mkdirSync(path.join(root, "test", "auth"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", check: "node --version" } }), "utf8");
  writeFileSync(path.join(root, "src", "auth", "session.ts"), "export function loginSession() { return 'ok'; }\n", "utf8");
  writeFileSync(path.join(root, "test", "auth", "session.test.ts"), "console.log('ok');\n", "utf8");
  runGit(root, ["init"]);
  runGit(root, ["checkout", "-b", "main"]);
  runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
  runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "initial"]);
  return root;
}
