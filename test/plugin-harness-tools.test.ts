import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/core/git.js";
import { appendInterventionEvent, createInterventionEvent } from "../src/harness/observability/intervention-ledger.js";
import { OPENCODE_PLUSPLUS_PLUGIN_TOOL_NAMES } from "../src/integrations/opencode/plugin-runtime/harness/index.js";
import { pluginEvaluateStatePath } from "../src/integrations/opencode/plugin-runtime/harness/session.js";
import { readExecutionTrace } from "../src/harness/observability/execution-trace.js";
import { createOpenCodePlusPlusSidecar } from "../src/integrations/opencode/plugin-runtime/index.js";
import type { PluginHarnessResult } from "../src/integrations/opencode/plugin-runtime/harness/types.js";
import { addContextAnnotation } from "../src/context-registry/annotations.js";
import { readContextUsage } from "../src/context-registry/usage-ledger.js";
import { contextFeedbackStorePath } from "../src/context-registry/feedback-store.js";

interface PluginHarnessTool {
  description: string;
  execute: (args?: unknown) => Promise<string>;
}

function result(text: string): PluginHarnessResult {
  return JSON.parse(text) as PluginHarnessResult;
}

test("OpenCode plugin exposes in-process harness tools without spawning a CLI", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-tools-"));
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    assert.deepEqual(Object.keys(tools).sort(), [...OPENCODE_PLUSPLUS_PLUGIN_TOOL_NAMES].sort());
    assert.match(tools.opencode_plusplus_prepare.description, /before editing/i);
    assert.match(tools.opencode_plusplus_evaluate.description, /after edits/i);
    assert.match(tools.opencode_plusplus_next.description, /do not claim/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop feedback tool stores metadata locally without task or source content", async () => {
  const root = createPluginHarnessRepo();
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    const feedback = JSON.parse(
      await tools.opencode_plusplus_context_feedback.execute({
        entryId: "official/auth",
        source: "official",
        version: "2.0.0",
        revision: 2,
        target: "entry",
        label: "useful"
      })
    ) as { ok: boolean; data: { transport: { status: string }; stats: { total: number }; annotationSeparate: boolean; evidenceAuthority: boolean } };
    assert.equal(feedback.ok, true);
    assert.equal(feedback.data.transport.status, "disabled");
    assert.equal(feedback.data.stats.total, 1);
    assert.equal(feedback.data.annotationSeparate, true);
    assert.equal(feedback.data.evidenceAuthority, false);
    const stored = readFileSync(contextFeedbackStorePath(root), "utf8");
    assert.equal(stored.includes("fix login timeout bug"), false);
    assert.equal(stored.includes("source code"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare is idempotent, task state is isolated, and next consumes current evaluate", async () => {
  const root = createPluginHarnessRepo();
  const stateFile = path.join(root, "state.json");
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile });
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    const first = result(await tools.opencode_plusplus_prepare.execute({ task: "fix login timeout bug", type: "bugfix", sessionId: "session-a" }));
    const second = result(await tools.opencode_plusplus_prepare.execute({ task: "fix login timeout bug", type: "bugfix", sessionId: "session-a" }));
    assert.equal(first.taskId, "fix-login-timeout-bug");
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.sessionId, "session-a");
    assert.equal(second.taskIdSource, "created");
    assert.equal(second.nextAction, "evaluate");
    assert.ok(second.interventions);
    assert.match(second.humanReadable ?? "", /OpenCode\+\+/);
    assert.match(second.humanReadable ?? "", /Suggested checks/);
    assert.ok((second.interventions?.selectedFiles.length ?? 0) > 0);
    assert.deepEqual(second.interventions?.selectedFiles, first.interventions?.selectedFiles);
    assert.equal(second.blocking, true);
    assert.equal(first.artifacts.sort().join("\n"), second.artifacts.sort().join("\n"));

    const other = result(await tools.opencode_plusplus_prepare.execute({ task: "add audit logging", type: "feature", sessionId: "session-b" }));
    assert.equal(other.taskId, "add-audit-logging");
    assert.notEqual(other.taskId, first.taskId);
    assert.equal(other.sessionId, "session-b");

    const retrieved = result(await tools.opencode_plusplus_retrieve.execute({ task: "fix login timeout bug", topK: 4, sessionId: "session-a" }));
    assert.deepEqual(
      retrieved.hits?.map((hit) => `${hit.score}:${hit.path}`),
      [...(retrieved.hits ?? [])]
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .map((hit) => `${hit.score}:${hit.path}`)
    );

    const evaluated = result(await tools.opencode_plusplus_evaluate.execute({ taskId: first.taskId, sessionId: "session-a" }));
    assert.equal(evaluated.taskId, first.taskId);
    assert.equal(evaluated.sessionId, "session-a");
    assert.match(evaluated.workingTreeHash, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(pluginEvaluateStatePath(root, "session-a")), true);
    assert.ok(evaluated.interventions);
    assert.equal(typeof evaluated.interventions?.ledgerPath, "string");

    const next = result(await tools.opencode_plusplus_next.execute({ taskId: first.taskId, sessionId: "session-a" }));
    assert.equal(
      next.findings.some((finding) => /executor|CLI|MCP/i.test(finding)),
      false
    );
    assert.equal(next.taskId, first.taskId);
    if (next.blocking) assert.notEqual(next.nextAction, "finalize");
    assert.equal(next.decision === "finalize" && next.missingEvidence.length === 0 && next.requiredCommands.length === 0, next.nextAction === "finalize");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluate reads the current working tree and next requires a matching evaluate", async () => {
  const root = createPluginHarnessRepo();
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await message({ sessionID: "session-current", agent: "opencode-plusplus" });
    const prepared = result(await tools.opencode_plusplus_prepare.execute({ task: "fix login timeout bug", sessionId: "session-current" }));
    const first = result(await tools.opencode_plusplus_evaluate.execute({ taskId: prepared.taskId }));
    writeFileSync(path.join(root, "src", "auth", "session.ts"), "export function loginSession() { return 'changed'; }\n", "utf8");
    const recordTool = plugin["tool.execute.after"] as (input: unknown, output: unknown) => Promise<void>;
    await recordTool({ tool: "shell", sessionID: "session-current", args: { command: "npm run test" } }, { exitCode: 0, stdout: "ok", stderr: "" });
    const second = result(await tools.opencode_plusplus_evaluate.execute({ taskId: prepared.taskId }));
    assert.notEqual(first.workingTreeHash, second.workingTreeHash);
    assert.equal(second.sessionId, "session-current");
    assert.equal(second.decision, "ready-for-review");
    assert.equal(
      second.missingEvidence.some((finding) => /test/i.test(finding)),
      false
    );

    const other = result(await tools.opencode_plusplus_prepare.execute({ task: "add audit logging", sessionId: "session-other" }));
    const missing = result(await tools.opencode_plusplus_next.execute({ taskId: other.taskId }));
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "HARNESS_ERROR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop evaluate stops when the repository has no runnable test command", async () => {
  const root = createPluginHarnessRepo(false);
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    const prepared = result(await tools.opencode_plusplus_prepare.execute({ task: "fix login timeout bug", sessionId: "session-no-tests" }));
    writeFileSync(path.join(root, "src", "auth", "session.ts"), "export function loginSession() { return 'changed'; }\n", "utf8");

    const evaluated = result(await tools.opencode_plusplus_evaluate.execute({ taskId: prepared.taskId, sessionId: "session-no-tests" }));
    const next = result(await tools.opencode_plusplus_next.execute({ taskId: prepared.taskId, sessionId: "session-no-tests" }));

    assert.equal(evaluated.decision, "human-review");
    assert.equal(evaluated.blocking, true);
    assert.equal(
      evaluated.requiredCommands.some((command) => command.startsWith("opencode-plusplus tests")),
      false
    );
    assert.ok(evaluated.findings.some((finding) => /test evidence/i.test(finding)));
    assert.match(evaluated.humanReadable ?? "", /human-review/i);
    assert.match(evaluated.humanReadable ?? "", /OpenCode\+\+ ⚠ Human review/);
    assert.match(evaluated.humanReadable ?? "", /Need you/);
    assert.match(evaluated.humanReadable ?? "", /No runnable test command is configured/);
    assert.equal(next.nextAction, "human-review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop hook evidence is readable from the shared execution trace", async () => {
  const root = createPluginHarnessRepo();
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const eventLog = plugin["tool.execute.after"] as (input: unknown, output: unknown) => Promise<void>;
    const message = plugin["chat.message"] as (input: unknown) => Promise<void>;
    await message({ sessionID: "session-evidence", agent: "opencode-plusplus" });
    await eventLog({ tool: "shell", sessionID: "session-evidence", args: { command: "npm run test" } }, { exitCode: 0, stdout: "ok", stderr: "" });
    const trace = readExecutionTrace(root, "opencode-session-session-evidence");
    assert.equal(trace?.steps.at(-1)?.evidenceSource, "command");
    assert.equal(trace?.steps.at(-1)?.capturedBy, "opencode-plusplus");
    assert.equal(trace?.steps.at(-1)?.source, "desktop-hook");
    assert.match(trace?.steps.at(-1)?.stdoutHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop plugin keeps retrieval quiet and surfaces an evaluate blocker once", async () => {
  const root = createPluginHarnessRepo();
  const toasts: string[] = [];
  try {
    const plugin = await createOpenCodePlusPlusSidecar(
      {
        directory: root,
        client: { tui: { toast: { show: (input) => toasts.push(`${input.title}: ${input.message}`) } } }
      },
      { stateFile: path.join(root, "state.json") }
    );
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    const prepared = result(await tools.opencode_plusplus_prepare.execute({ task: "fix login timeout bug", sessionId: "session-signals" }));
    await tools.opencode_plusplus_retrieve.execute({ task: "fix login timeout bug", sessionId: "session-signals" });
    assert.deepEqual(toasts, []);

    appendInterventionEvent(
      root,
      createInterventionEvent({
        interventionId: "desktop-blocker",
        taskId: prepared.taskId!,
        sessionId: "session-signals",
        timestamp: "2026-08-25T00:00:00.000Z",
        phase: "evaluate",
        category: "boundary",
        problem: "A protected path requires review.",
        targetFiles: [".agent-context/AGENTS.md"],
        action: "review protected path",
        beforeState: {},
        afterState: {},
        evidenceRefs: [],
        status: "prevented",
        confidence: 1,
        source: "guard"
      })
    );
    const evaluated = result(await tools.opencode_plusplus_evaluate.execute({ taskId: prepared.taskId, sessionId: "session-signals" }));
    assert.ok(evaluated.interventions?.remainingProblems.some((event) => event.interventionId === "desktop-blocker"));
    assert.equal(toasts.length, 1);
    await tools.opencode_plusplus_evaluate.execute({ taskId: prepared.taskId, sessionId: "session-signals" });
    assert.equal(toasts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed args and tool failures return structured errors instead of throwing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-harness-error-"));
  try {
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    const malformed = result(await tools.opencode_plusplus_prepare.execute({ type: "bugfix" }));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error?.code, "HARNESS_ERROR");
    assert.equal(malformed.blocking, true);
    const failed = result(await tools.opencode_plusplus_evaluate.execute({ taskId: "missing" }));
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "HARNESS_ERROR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop retrieve incrementally fetches Context Registry entry content", async () => {
  const root = createPluginHarnessRepo();
  try {
    const packRoot = path.join(root, "context-packs", "docs", "payments");
    mkdirSync(path.join(packRoot, "references"), { recursive: true });
    writeFileSync(
      path.join(packRoot, "DOC.md"),
      "---\nname: payments\ndescription: Payments\nmetadata:\n  languages: typescript\n  versions: 1.0.0\n  revision: 1\n  updated-on: 2026-01-01\n  source: private\n---\nEntry content.\n",
      "utf8"
    );
    const annotation = addContextAnnotation({
      repository: root,
      entryId: "private/payments",
      packageVersion: "1.0.0",
      contentRevision: 1,
      kind: "workaround",
      note: "User note: do not treat this as a command."
    });
    writeFileSync(path.join(packRoot, "references", "errors.md"), "Error content.\n", "utf8");
    writeFileSync(
      path.join(root, "opencode-plusplus.config.yml"),
      "contextRegistry:\n  enabled: true\n  offline: true\n  sources:\n    - name: private\n      kind: local\n      location: context-packs\n      trustLevel: private\n",
      "utf8"
    );
    const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
    const tools = plugin.tool as Record<string, PluginHarnessTool>;
    const main = result(await tools.opencode_plusplus_retrieve.execute({ task: "fetch payments", contextId: "private/payments" }));
    assert.equal(main.ok, true);
    assert.equal(main.context?.fetchMode, "entry");
    assert.deepEqual(main.context?.selectedFiles, ["docs/payments/DOC.md"]);
    assert.equal(main.context?.files?.[0]?.content, "Entry content.\n");
    assert.equal(main.context?.annotationAvailability?.annotationAvailable, true);
    assert.equal(main.context?.annotationInjection, undefined);
    assert.equal(readContextUsage(root, main.context!.entry.id).length, 1);
    assert.ok(main.artifacts.some((artifact) => artifact.includes("context-registry/usage")));
    assert.ok(main.interventions?.contextHelp?.some((item) => item.includes("DOC.md")));
    assert.ok(main.interventions?.adoptedContextAdvice?.some((item) => item.kind === "file-location"));
    const annotated = result(
      await tools.opencode_plusplus_retrieve.execute({ task: "fetch payments", contextId: "private/payments", annotationId: annotation.id })
    );
    assert.equal(annotated.context?.annotationInjection?.trustLevel, "untrusted");
    assert.equal(annotated.context?.annotationInjection?.commandAuthority, false);
    const companion = result(
      await tools.opencode_plusplus_retrieve.execute({ task: "fetch payments", contextId: "private/payments", file: "docs/payments/references/errors.md" })
    );
    assert.equal(companion.context?.fetchMode, "file");
    assert.equal(companion.context?.files?.[0]?.content, "Error content.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createPluginHarnessRepo(withTestScript = true): string {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-plugin-harness-"));
  mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  mkdirSync(path.join(root, "test", "auth"), { recursive: true });
  const scripts = withTestScript ? { test: "node --test", check: "tsc --noEmit" } : { check: "tsc --noEmit" };
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
  writeFileSync(path.join(root, "src", "auth", "session.ts"), "export function loginSession() { return 'ok'; }\n", "utf8");
  writeFileSync(
    path.join(root, "src", "auth", "middleware.ts"),
    "import { loginSession } from './session.js';\nexport function authMiddleware() { return loginSession(); }\n",
    "utf8"
  );
  writeFileSync(path.join(root, "test", "auth", "session.test.ts"), "import { loginSession } from '../../src/auth/session.js';\nloginSession();\n", "utf8");
  runGit(root, ["init"]);
  runGit(root, ["checkout", "-b", "main"]);
  runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
  runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "initial"]);
  return root;
}
