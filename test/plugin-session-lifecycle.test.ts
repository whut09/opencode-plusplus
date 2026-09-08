import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSidecarRecorder,
  notifyOpenCodePlusPlusToast,
  notifyPluginInterventionSignals,
  type OpenCodeSidecarRuntimeContext
} from "../src/integrations/opencode/plugin-runtime/events.js";
import { createOpenCodePlusPlusSidecar } from "../src/integrations/opencode/plugin-runtime/index.js";
import { readOpenCodePlusPlusPluginStatus, setOpenCodePlusPlusPluginEnabled } from "../src/integrations/opencode/plugin-runtime/state.js";
import {
  buildCompactingContext,
  createSessionLifecycle,
  SESSION_READY_DEBOUNCE_MS,
  type SessionLifecycle
} from "../src/integrations/opencode/plugin-runtime/session-lifecycle.js";
import type { OpenCodeSidecarVerifyResult } from "../src/integrations/opencode/sidecar.js";
import type { PluginInterventionSnapshot } from "../src/integrations/opencode/plugin-runtime/harness/types.js";

test("toast helper prefers tui.toast.show and falls back to app.log", () => {
  const toastCalls: Array<{ title: string; message: string }> = [];
  const logCalls: string[] = [];
  const withToast: OpenCodeSidecarRuntimeContext = {
    directory: "/tmp",
    client: {
      tui: { toast: { show: (input) => toastCalls.push(input) } },
      app: { log: (input) => logCalls.push(input.message) }
    }
  };
  assert.equal(notifyOpenCodePlusPlusToast(withToast, "OpenCode++", "已就绪"), "toast");
  assert.deepEqual(toastCalls, [{ title: "OpenCode++", message: "已就绪" }]);
  assert.deepEqual(logCalls, []);

  const logCallsAfterFallback: string[] = [];
  const failingToast: OpenCodeSidecarRuntimeContext = {
    directory: "/tmp",
    client: {
      tui: {
        toast: {
          show: () => {
            throw new Error("toast unavailable");
          }
        }
      },
      app: { log: (input) => logCallsAfterFallback.push(input.message) }
    }
  };
  assert.equal(notifyOpenCodePlusPlusToast(failingToast, "OpenCode++", "已就绪"), "log");
  assert.equal(logCallsAfterFallback.length, 1);
  assert.match(logCallsAfterFallback[0]!, /已就绪/);

  const noClient: OpenCodeSidecarRuntimeContext = { directory: "/tmp" };
  assert.equal(notifyOpenCodePlusPlusToast(noClient, "OpenCode++", "已就绪"), "log");
});

test("intervention notifications emit one prioritized transition and deduplicate it", () => {
  const toastCalls: string[] = [];
  const context: OpenCodeSidecarRuntimeContext = {
    directory: "/tmp",
    client: { tui: { toast: { show: (input) => toastCalls.push(`${input.title}: ${input.message}`) } } }
  };
  const snapshot: PluginInterventionSnapshot = {
    ledgerPath: "ledger.jsonl",
    eventCount: 4,
    selectedFiles: ["src/app.ts"],
    excludedFiles: [],
    interventions: [
      signal("blocker-1", "prevented", "blocked protected edit"),
      signal("verified-1", "verified", "test fix verified"),
      signal("review-1", "human-review", "manual review required"),
      signal("progress-1", "human-review", "no-progress: repeated state")
    ],
    problems: ["blocked protected edit"],
    actions: ["inspect"],
    verifiedFixes: [signal("verified-1", "verified", "test fix verified")],
    remainingProblems: [signal("blocker-1", "prevented", "blocked protected edit")],
    humanReview: [signal("review-1", "human-review", "manual review required"), signal("progress-1", "human-review", "no-progress: repeated state")]
  };

  assert.equal(notifyPluginInterventionSignals(context, snapshot, "prepare"), 0);
  assert.equal(toastCalls.length, 0);
  assert.equal(notifyPluginInterventionSignals(context, snapshot, "dashboard"), 0);
  assert.equal(toastCalls.length, 0);
  assert.equal(notifyPluginInterventionSignals(context, snapshot, "evaluate"), 1);
  assert.equal(notifyPluginInterventionSignals(context, snapshot, "evaluate"), 0);
  assert.equal(toastCalls.length, 1);
  assert.ok(toastCalls.some((message) => message.includes("human review required")));
  assert.ok(!toastCalls.some((message) => message.includes("no progress")));

  const otherRepository = { ...context, directory: "/tmp/other-opencode-repository" };
  assert.equal(notifyPluginInterventionSignals(otherRepository, snapshot, "evaluate"), 1);
});

test("session ready build is debounced at least two seconds by default", () => {
  assert.ok(SESSION_READY_DEBOUNCE_MS >= 2000);
});

test("session.created stays quiet until the OpenCode++ mode is activated", async () => {
  const fixture = createLifecycleFixture({
    debounceMs: 50,
    buildContext: async (root) => {
      mkdirSafe(path.join(root, ".agent-context"));
      writeFileSync(path.join(root, ".agent-context", "build-ran.json"), "{}", "utf8");
    }
  });
  try {
    fixture.lifecycle.onSessionCreated();
    await sleep(100);
    assert.deepEqual(fixture.dirtyMarks, []);
    assert.deepEqual(fixture.toasts, []);
    assert.equal(existsSync(path.join(fixture.root, ".agent-context", "build-ran.json")), false);

    fixture.lifecycle.onHarnessActivated();
    assert.deepEqual(fixture.dirtyMarks, ["session.created"]);

    await waitFor(() => existsSync(path.join(fixture.root, ".agent-context", "build-ran.json")));
    assert.deepEqual(fixture.toasts, ["OpenCode++ 已就绪"]);
    assert.ok(
      readEventLines(fixture.root).some((line) => line.type === "sidecar.context-ready"),
      "context-ready event is recorded"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mode activation build failure only logs and never throws", async () => {
  const fixture = createLifecycleFixture({
    debounceMs: 50,
    buildContext: async () => {
      throw new Error("context build exploded");
    }
  });
  try {
    fixture.lifecycle.onSessionCreated();
    fixture.lifecycle.onHarnessActivated();
    await waitFor(() => readEventLines(fixture.root).some((line) => line.type === "sidecar.log" && line.message === "session ready context build failed"));
    assert.deepEqual(fixture.toasts, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session.idle blocker toasts the first blocker with a next-step hint and never throws", () => {
  const fixture = createLifecycleFixture();
  try {
    const blocked = {
      ok: false,
      blockers: ["Contract violations: 2", "Policy required evidence missing: 1"]
    } as unknown as OpenCodeSidecarVerifyResult;

    fixture.lifecycle.onSessionIdle(blocked);
    assert.deepEqual(fixture.toasts, ["OpenCode++ 未通过：Contract violations: 2。下一步调用 opencode_plusplus_next"]);

    fixture.lifecycle.onSessionIdle(null);
    const passed = { ok: true, blockers: [] } as unknown as OpenCodeSidecarVerifyResult;
    fixture.lifecycle.onSessionIdle(passed);
    assert.equal(fixture.toasts.length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("generated runtime watcher updates do not trigger another dirty verification", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-runtime-watcher-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const eventHook = plugin.event as (input: { event?: Record<string, unknown> }) => Promise<void>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await eventHook({ event: { type: "session.created", sessionID: "session-runtime" } });
    await message({ sessionID: "session-runtime", agent: "opencode-plusplus" });
    const tracePath = path.join(root, ".agent-context", "traces", "opencode-sidecar-events.jsonl");
    const before = existsSync(tracePath) ? readEventLines(root).length : 1;
    await eventHook({
      event: {
        type: "file.watcher.updated",
        sessionID: "session-runtime",
        properties: { file: ".agent-context/cache/tokenizer-cache.json" }
      }
    });
    const workflow = readEventLines(root);
    assert.equal(
      workflow.some((line) => line.type === "file.watcher.updated.ignored"),
      true
    );
    assert.equal(workflow.filter((line) => line.type === "repository marked dirty").length, 0);
    assert.ok(workflow.length >= before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absolute generated runtime watcher updates are ignored", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-absolute-runtime-watcher-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const eventHook = plugin.event as (input: { event?: Record<string, unknown> }) => Promise<void>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await message({ sessionID: "session-absolute-runtime", agent: "opencode-plusplus" });
    await eventHook({
      event: {
        type: "file.watcher.updated",
        sessionID: "session-absolute-runtime",
        properties: { file: path.join(root, ".agent-context", "cache", "tokenizer-cache.json") }
      }
    });
    const events = readEventLines(root);
    assert.equal(
      events.some((line) => line.type === "file.watcher.updated.ignored"),
      true
    );
    assert.equal(
      events.some((line) => line.type === "repository marked dirty"),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compacting injects harness state into output.context and never replaces output.prompt", () => {
  const fixture = createLifecycleFixture();
  const root = fixture.root;
  try {
    writeJsonFile(root, path.join(".agent-context", "sidecar", "plugin-session-session-1.json"), {
      taskId: "fix-login-timeout-bug",
      task: "fix login timeout bug",
      type: "bugfix",
      sessionId: "session-1",
      updatedAt: new Date().toISOString()
    });
    writeJsonFile(root, path.join(".agent-context", "runs", "fix-login-timeout-bug", "run.json"), {
      id: "fix-login-timeout-bug",
      allowedEditGlobs: ["src/auth/**"],
      avoidEditGlobs: ["docs/**"]
    });
    writeJsonFile(root, path.join(".agent-context", "sidecar", "plugin-evaluate-session-1.json"), {
      taskId: "fix-login-timeout-bug",
      sessionId: "session-1",
      blocking: true,
      decision: "repair",
      missingEvidence: ["required_tests_passed"],
      requiredCommands: ["npm test -- auth"],
      humanReview: {
        schemaVersion: "opencode-plusplus.human-review.v1",
        requestId: "review-1",
        taskId: "fix-login-timeout-bug",
        sessionId: "session-1",
        reasonCode: "BOUNDARY_EXPANSION_REQUIRED",
        title: "OpenCode++ needs permission to expand task scope.",
        explanation: "The current boundary excludes a shared token file.",
        requiredUserAction: "Approve the requested scope expansion.",
        suggestedCommands: [],
        affectedFiles: ["packages/shared/token.ts"],
        resumeCondition: "The new boundary revision resumes the current task.",
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    });
    writeFileSync(path.join(root, ".agent-context", "sidecar", "latest.md"), "# Sidecar latest\n\nBlocking gates:\n- evidence.no-test-after-edit\n", "utf8");

    const output: { prompt: string; context: string[] } = { prompt: "original prompt", context: [] };
    fixture.lifecycle.onSessionCompacting({ sessionID: "session-1" }, output);
    assert.equal(output.context.length, 1);
    assert.match(output.context[0]!, /OpenCode\+\+ taskId: fix-login-timeout-bug/);
    assert.match(output.context[0]!, /allowedEditGlobs: src\/auth\/\*\*/);
    assert.match(output.context[0]!, /avoidEditGlobs: docs\/\*\*/);
    assert.match(output.context[0]!, /blocking=yes/);
    assert.match(output.context[0]!, /decision=repair/);
    assert.match(output.context[0]!, /missingEvidence: required_tests_passed/);
    assert.match(output.context[0]!, /human review: BOUNDARY_EXPANSION_REQUIRED/);
    assert.match(output.context[0]!, /human review action: Approve the requested scope expansion/);
    assert.match(output.context[0]!, /human review resume: The new boundary revision/);
    assert.match(output.context[0]!, /opencode_plusplus_next returns finalize/);
    assert.equal(output.prompt, "original prompt");

    const bare: { context?: string[] } = {};
    fixture.lifecycle.onSessionCompacting({ sessionID: "session-1" }, bare);
    assert.equal(bare.context?.length, 1);

    fixture.lifecycle.onSessionCompacting({}, undefined);

    const emptyRoot = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-lifecycle-empty-"));
    try {
      assert.equal(buildCompactingContext(emptyRoot), undefined, "no harness state produces no injection in an empty repository");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("disabled lifecycle skips ready build, idle blocker, compacting, and error recording", async () => {
  const fixture = createLifecycleFixture({ debounceMs: 50, buildContext: async () => undefined });
  try {
    setOpenCodePlusPlusPluginEnabled(false, fixture.stateFile);
    assert.equal(readOpenCodePlusPlusPluginStatus(fixture.stateFile).enabled, false);

    fixture.lifecycle.onSessionCreated();
    await sleep(150);
    assert.deepEqual(fixture.dirtyMarks, []);
    assert.deepEqual(fixture.toasts, []);
    assert.ok(
      readEventLines(fixture.root).some((line) => line.type === "session.created" && line.enabled === false),
      "session.created still records the enabled flag"
    );

    const blocked = { ok: false, blockers: ["Contract violations: 2"] } as unknown as OpenCodeSidecarVerifyResult;
    fixture.lifecycle.onSessionIdle(blocked);
    assert.deepEqual(fixture.toasts, []);

    const output: { context: string[] } = { context: [] };
    fixture.lifecycle.onSessionCompacting({}, output);
    assert.deepEqual(output.context, []);

    fixture.lifecycle.onSessionError({ properties: { message: "boom" } });
    assert.ok(!readEventLines(fixture.root).some((line) => line.type === "session.error"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session.error records evidence without throwing", () => {
  const fixture = createLifecycleFixture();
  try {
    fixture.lifecycle.onSessionError({ properties: { message: "provider timeout", sessionID: "session-9" } });
    const recorded = readEventLines(fixture.root).find((line) => line.type === "session.error");
    assert.match(recorded?.message as string, /provider timeout/);
    assert.equal(recorded?.sessionID, "session-9");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("plugin exposes the experimental.session.compacting hook and keeps it inactive when disabled", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-lifecycle-wiring-"));
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const tools = plugin.tool as Record<string, { execute: () => Promise<string> }>;
    await tools.opencode_plusplus_disable.execute();

    const eventHook = plugin.event as (input: { event?: Record<string, unknown> }) => Promise<void>;
    await eventHook({ event: { type: "session.created" } });
    assert.ok(readEventLines(root).some((line) => line.type === "session.created" && line.enabled === false));

    const compacting = plugin["experimental.session.compacting"] as (input: unknown, output: unknown) => Promise<void>;
    assert.equal(typeof compacting, "function");
    const output: { context: string[] } = { context: [] };
    await compacting({}, output);
    assert.deepEqual(output.context, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createLifecycleFixture(options: { debounceMs?: number; buildContext?: (root: string) => Promise<unknown> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-lifecycle-"));
  const stateFile = path.join(root, "state.json");
  const context: OpenCodeSidecarRuntimeContext = {
    directory: root,
    client: {
      tui: {
        toast: {
          show: (input: { title: string; message: string }) => fixture.toasts.push(`${input.title} ${input.message}`)
        }
      }
    }
  };
  const fixture = {
    root,
    stateFile,
    toasts: [] as string[],
    dirtyMarks: [] as string[],
    lifecycle: undefined as unknown as SessionLifecycle
  };
  const recorder = createSidecarRecorder(context);
  fixture.lifecycle = createSessionLifecycle({
    directory: root,
    context,
    recorder,
    idle: {
      markDirty: (type: string) => fixture.dirtyMarks.push(type),
      maybeVerifyOnIdle: async () => null
    },
    isEnabled: () => readOpenCodePlusPlusPluginStatus(stateFile).enabled,
    buildContext: options.buildContext,
    readyDebounceMs: options.debounceMs
  });
  return fixture;
}

function readEventLines(root: string): Array<Record<string, unknown>> {
  const eventLog = path.join(root, ".agent-context", "traces", "opencode-sidecar-events.jsonl");
  if (!existsSync(eventLog)) return [];
  return readFileSync(eventLog, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("sidecar event records have stable metadata and duplicate event IDs are idempotent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-event-envelope-"));
  try {
    const recorder = createSidecarRecorder({ directory: root });
    recorder.record("tool.execute.after", { eventId: "call-1", sessionId: "session-a", taskId: "task-a" });
    recorder.record("tool.execute.after", { eventId: "call-1", sessionId: "session-a", taskId: "task-a" });
    const events = readEventLines(root);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventId, "call-1");
    assert.equal(events[0]?.sequence, 1);
    assert.equal(events[0]?.sessionId, "session-a");
    assert.equal(events[0]?.taskId, "task-a");
    assert.equal(events[0]?.schemaVersion, 1);
    assert.equal(typeof events[0]?.timestamp, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJsonFile(root: string, relativePath: string, value: unknown): void {
  mkdirSafe(path.join(root, path.dirname(relativePath)));
  writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mkdirSafe(directory: string): void {
  mkdirSync(directory, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signal(interventionId: string, status: "prevented" | "verified" | "human-review", problem: string) {
  return {
    interventionId,
    eventId: `event-${interventionId}`,
    status,
    phase: "evaluate",
    category: "evidence",
    problem,
    targetFiles: ["src/app.ts"],
    action: "inspect",
    evidenceRefs: [],
    confidence: 0.9,
    source: "test",
    timestamp: "2026-08-25T00:00:00.000Z"
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000, intervalMs = 25): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await sleep(intervalMs);
  }
}
