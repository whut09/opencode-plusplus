import assert from "node:assert/strict";
import test from "node:test";
import { completionRuleFor, isFinalizeAction } from "../src/integrations/opencode/plugin-runtime/harness/completion.js";
import {
  renderEvaluateText,
  renderHarnessError,
  renderNextText,
  renderPrepareText,
  renderRetrieveText
} from "../src/integrations/opencode/plugin-runtime/harness/format.js";
import type { PluginHarnessResult } from "../src/integrations/opencode/plugin-runtime/harness/types.js";
import { createPluginHarnessError, renderPluginHarnessResult } from "../src/integrations/opencode/plugin-runtime/harness/protocol.js";
import { buildPluginHarnessVisualization, renderPluginHarnessVisualization } from "../src/integrations/opencode/plugin-runtime/harness/visualization.js";
import { notifyPluginHarnessStatus } from "../src/integrations/opencode/plugin-runtime/events.js";

const base: PluginHarnessResult = {
  schemaVersion: "opencode-plusplus.desktop-harness.v1",
  ok: true,
  tool: "evaluate",
  summary: "stable result",
  taskId: "fix-login-timeout",
  sessionId: "session-1",
  taskIdSource: "argument",
  repository: "C:/repo",
  workingTreeHash: "hash",
  currentPhase: "evaluate",
  decision: "run-tests",
  blocking: true,
  findings: ["missing tests"],
  missingEvidence: ["command evidence"],
  requiredCommands: ["npm run test"],
  mustInspect: ["src/auth/session.ts"],
  allowedEditGlobs: ["src/auth/session.ts"],
  avoidEditGlobs: ["dist/**"],
  artifacts: [".agent-context/runs/fix-login-timeout/run.json"],
  nextAction: "run-tests"
};

test("Harness visualization exposes progress and auditable decision basis", () => {
  const visualization = buildPluginHarnessVisualization({
    taskStarted: true,
    currentPhase: "evaluate",
    decision: "run-tests",
    blocking: true,
    nextAction: "run-tests",
    workingTreeHash: "tree-hash",
    findings: ["tests missing"],
    missingEvidence: ["command evidence"],
    requiredCommands: ["npm test"],
    mustInspect: ["src/auth/session.ts"],
    interventions: {
      ledgerPath: ".agent-context/interventions/task.jsonl",
      eventCount: 1,
      selectedFiles: ["src/auth/session.ts"],
      excludedFiles: [{ path: "src/billing.ts", reason: "unrelated" }],
      interventions: [],
      problems: ["tests missing"],
      actions: ["npm test"],
      verifiedFixes: [],
      remainingProblems: [],
      humanReview: []
    }
  });
  assert.equal(visualization.evidence.status, "blocking");
  assert.equal(visualization.stages.find((stage) => stage.id === "evaluate")?.status, "blocked");
  assert.match(renderPluginHarnessVisualization(visualization), /Decision basis:/);
  assert.match(renderPluginHarnessVisualization(visualization), /not hidden model reasoning/);
});

test("plugin harness renderers expose the unified Desktop protocol fields", () => {
  for (const rendered of [
    renderPrepareText(base),
    renderRetrieveText({ ...base, tool: "retrieve", hits: [{ path: "src/auth/session.ts", score: 12, reason: "timeout" }] }),
    renderEvaluateText(base),
    renderNextText(base)
  ]) {
    const parsed = JSON.parse(rendered) as PluginHarnessResult;
    assert.equal(parsed.schemaVersion, "opencode-plusplus.desktop-harness.v1");
    assert.equal(parsed.taskId, "fix-login-timeout");
    assert.equal(parsed.sessionId, "session-1");
    assert.equal(parsed.repository, "C:/repo");
    assert.ok(Array.isArray(parsed.findings));
    assert.ok(typeof parsed.summary === "string");
    assert.equal(parsed.visualization?.view, "harness-progress");
    assert.match(parsed.humanReadable ?? "", /OpenCode\+\+ ✗ Repair required/);
    assert.doesNotMatch(parsed.humanReadable ?? "", /OpenCode\+\+ Harness Dashboard/);
    assert.doesNotMatch(parsed.humanReadable ?? "", /Prevented:\s*none/);
    assert.equal(parsed.displayMode, "compact");
    assert.equal(parsed.compactStatus?.label, "Repair required");
    assert.ok(parsed.actionSummary);
    assert.match(parsed.summary, /OpenCode\+\+ recorded: observed=/);
  }
  assert.match(
    renderRetrieveText({ ...base, tool: "retrieve", hits: [{ path: "src/auth/session.ts", score: 12, reason: "timeout" }] }),
    /src\/auth\/session\.ts/
  );
});

test("Desktop result separates recorded plugin actions from external task claims", () => {
  const parsed = JSON.parse(
    renderEvaluateText({
      ...base,
      findings: ["No runnable test command was configured."],
      missingEvidence: ["current working-tree test evidence"],
      requiredCommands: [],
      interventions: {
        ledgerPath: ".agent-context/interventions/task.jsonl",
        eventCount: 2,
        selectedFiles: ["src/auth/session.ts"],
        excludedFiles: [{ path: "src/generated.ts", reason: "generated file" }],
        interventions: [
          {
            interventionId: "guard-1",
            eventId: "event-1",
            status: "prevented",
            phase: "evaluate",
            category: "boundary",
            problem: "protected path edit",
            targetFiles: ["src/generated.ts"],
            action: "block edit",
            evidenceRefs: [],
            confidence: 1,
            source: "guard",
            timestamp: "2026-01-01T00:00:00.000Z"
          }
        ],
        problems: ["protected path edit"],
        actions: ["block edit"],
        verifiedFixes: [],
        remainingProblems: [],
        humanReview: []
      }
    })
  ) as PluginHarnessResult;

  assert.deepEqual(parsed.actionSummary?.prevented, ["protected path edit -> block edit [src/generated.ts]"]);
  assert.deepEqual(parsed.actionSummary?.repaired, []);
  assert.match(parsed.humanReadable ?? "", /OpenCode\+\+ ✗ Repair required/);
  assert.match(parsed.humanReadable ?? "", /Prevented:/);
  assert.match(parsed.humanReadable ?? "", /No runnable test command was configured/);
  assert.doesNotMatch(parsed.humanReadable ?? "", /please confirm.*tests passed/i);
});

test("Desktop prints OpenCode++ Harness status to the app log and status toast", () => {
  const toasts: string[] = [];
  const logs: string[] = [];
  const recorder = {
    eventLog: "events.jsonl",
    record: () => undefined,
    log: (_level: string, message: string) => logs.push(message)
  };
  const context = {
    directory: "C:/repo",
    client: {
      app: { log: ({ message }: { message: string }) => logs.push(message) },
      tui: { toast: { show: ({ title, message }: { title: string; message: string }) => toasts.push(`${title}: ${message}`) } }
    }
  };

  assert.equal(notifyPluginHarnessStatus(context, base, recorder), "toast");
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /repair required/);
  assert.match(toasts[0], /missing tests/);
  assert.match(logs.join("\n"), /OpenCode\+\+ Harness Dashboard/);
  assert.equal(notifyPluginHarnessStatus(context, base, recorder), "log");
  assert.equal(toasts.length, 1);

  assert.equal(notifyPluginHarnessStatus(context, { ...base, decision: "finalize", blocking: false, nextAction: "finalize" }, recorder), "toast");
  assert.match(toasts[1] ?? "", /verified/);

  toasts.length = 0;
  assert.equal(notifyPluginHarnessStatus(context, { ...base, tool: "retrieve" }, recorder), "log");
  assert.equal(toasts.length, 0);

  const verificationContext = { ...context, directory: "C:/verification-started" };
  assert.equal(
    notifyPluginHarnessStatus(verificationContext, { ...base, decision: "ready-for-review", blocking: false, nextAction: "evaluate" }, recorder),
    "toast"
  );
  assert.match(toasts[0] ?? "", /verification started/);
});

test("explicit dashboard rendering retains the detailed view", () => {
  const parsed = JSON.parse(renderPluginHarnessResult({ ...base, tool: "dashboard" })) as PluginHarnessResult;
  assert.equal(parsed.displayMode, "detailed");
  assert.equal(parsed.compactStatus?.transition, "repair-required");
  assert.match(parsed.humanReadable ?? "", /OpenCode\+\+ Harness Dashboard/);
  assert.match(parsed.dashboard ?? "", /Decision basis:/);
  assert.doesNotMatch(parsed.humanReadable ?? "", /Repair required/);
});

test("human review keeps compact status and exposes a separate dashboard", () => {
  const parsed = JSON.parse(
    renderEvaluateText({
      ...base,
      decision: "human-review",
      nextAction: "human-review",
      findings: ["No executable verification command was found for source changes."],
      requiredCommands: []
    })
  ) as PluginHarnessResult;
  assert.match(parsed.humanReadable ?? "", /OpenCode\+\+ ⚠ Human review/);
  assert.match(parsed.humanReadable ?? "", /Need you/);
  assert.match(parsed.humanReadable ?? "", /Suggested/);
  assert.match(parsed.dashboard ?? "", /OpenCode\+\+ Harness Dashboard/);
});

test("a blocking result cannot announce verified from a stale visualization", () => {
  const parsed = JSON.parse(
    renderEvaluateText({
      ...base,
      decision: "finalize",
      blocking: true,
      nextAction: "finalize",
      visualization: {
        schemaVersion: "opencode-plusplus.desktop-visualization.v1",
        view: "harness-progress",
        currentPhase: "evaluate",
        stages: [],
        decisionBasis: [],
        observed: { selectedFiles: [], rejectedFiles: [], findings: [], missingEvidence: [], requiredCommands: [] },
        evidence: {
          workingTreeHash: "hash",
          currentTreeHashCaptured: true,
          verifiedFixes: 1,
          staleEvidence: 0,
          status: "verified"
        },
        interventions: { observed: 0, prevented: 0, requested: 0, repaired: 0, verified: 1, unresolved: 0, "human-review": 0, stale: 0 },
        decision: { action: "finalize", blocking: true, nextAction: "finalize" },
        summary: "stale visualization"
      }
    })
  ) as PluginHarnessResult;
  assert.equal(parsed.compactStatus?.transition, "repair-required");
  assert.match(parsed.humanReadable ?? "", /Repair required/);
});

test("compact verified output reports only current command evidence", () => {
  const verifiedEvent = {
    interventionId: "verified-1",
    eventId: "event-verified-1",
    status: "verified" as const,
    phase: "evaluate",
    category: "evidence",
    problem: "test evidence is current",
    targetFiles: ["src/auth/session.ts", "test/auth/session.test.ts", "src/auth/token.ts"],
    action: "run verification",
    evidenceRefs: ["trace-1"],
    resolutionEvidence: [
      {
        kind: "command" as const,
        ref: "trace-1",
        workingTreeHash: "hash",
        currentWorkingTree: true,
        valid: true,
        details: ["npm test"]
      }
    ],
    confidence: 1,
    source: "policy",
    timestamp: "2026-01-01T00:00:00.000Z"
  };
  const parsed = JSON.parse(
    renderEvaluateText({
      ...base,
      decision: "finalize",
      blocking: false,
      nextAction: "finalize",
      requiredCommands: ["npm test"],
      interventions: {
        ledgerPath: "ledger.jsonl",
        eventCount: 1,
        selectedFiles: verifiedEvent.targetFiles,
        excludedFiles: [],
        interventions: [verifiedEvent],
        problems: [],
        actions: [verifiedEvent.action],
        verifiedFixes: [verifiedEvent],
        remainingProblems: [],
        humanReview: []
      }
    })
  ) as PluginHarnessResult;
  assert.match(parsed.humanReadable ?? "", /OpenCode\+\+ ✓ Verified/);
  assert.match(parsed.humanReadable ?? "", /Changed\n3 files/);
  assert.match(parsed.humanReadable ?? "", /Checks\n✓ npm test/);
  assert.match(parsed.humanReadable ?? "", /Ready to finalize/);
  assert.doesNotMatch(parsed.humanReadable ?? "", /Suggested checks/);
  assert.ok(parsed.actionSummary?.observed.length, "structured observations remain available");
});

test("compact repair output distinguishes failed checks from suggestions", () => {
  const failedEvent = {
    interventionId: "failed-1",
    eventId: "event-failed-1",
    status: "unresolved" as const,
    phase: "evaluate",
    category: "evidence",
    problem: "test command failed",
    targetFiles: ["test/auth/session.test.ts"],
    action: "repair test",
    evidenceRefs: ["trace-2"],
    resolutionEvidence: [
      {
        kind: "command" as const,
        ref: "trace-2",
        workingTreeHash: "hash",
        currentWorkingTree: true,
        valid: false,
        details: ["npm test"]
      }
    ],
    confidence: 1,
    source: "policy",
    timestamp: "2026-01-01T00:00:00.000Z"
  };
  const parsed = JSON.parse(
    renderEvaluateText({
      ...base,
      decision: "repair",
      nextAction: "repair",
      requiredCommands: ["npm test"],
      interventions: {
        ledgerPath: "ledger.jsonl",
        eventCount: 1,
        selectedFiles: failedEvent.targetFiles,
        excludedFiles: [],
        interventions: [failedEvent],
        problems: [failedEvent.problem],
        actions: [failedEvent.action],
        verifiedFixes: [],
        remainingProblems: [failedEvent],
        humanReview: []
      }
    })
  ) as PluginHarnessResult;
  assert.match(parsed.humanReadable ?? "", /OpenCode\+\+ ✗ Repair required/);
  assert.match(parsed.humanReadable ?? "", /Checks\n✗ npm test/);
  assert.match(parsed.humanReadable ?? "", /Next\nFix test\/auth\/session\.test\.ts/);
  assert.doesNotMatch(parsed.humanReadable ?? "", /Suggested checks/);
});

test("structured harness errors never become unparseable text", () => {
  const parsed = JSON.parse(renderHarnessError("evaluate", "missing task")) as PluginHarnessResult;
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error?.code, "HARNESS_ERROR");
  assert.equal(parsed.blocking, true);
  assert.equal(parsed.nextAction, "prepare");
});

test("non-retryable plugin errors stop at attributed human review", () => {
  const result = createPluginHarnessError(".", "evaluate", "evaluation timed out", "task-1", "session-1", "argument", undefined, {
    code: "PLUGIN_EVALUATION_TIMEOUT",
    message: "evaluation timed out",
    attribution: "opencode-plusplus",
    retryable: false,
    nextStep: "stop without polling"
  });
  const parsed = JSON.parse(renderPluginHarnessResult(result)) as PluginHarnessResult;
  assert.equal(parsed.decision, "human-review");
  assert.equal(parsed.nextAction, "human-review");
  assert.equal(parsed.error?.attribution, "opencode-plusplus");
  assert.equal(parsed.error?.retryable, false);
  assert.equal(parsed.humanReview?.reasonCode, "PLUGIN_FAILURE");
  assert.match(parsed.humanReview?.requiredUserAction ?? "", /Inspect/i);
});

test("next completion rule forbids claiming done unless finalize is unblocked", () => {
  assert.equal(isFinalizeAction("ready-for-review", false), false);
  assert.equal(isFinalizeAction("finalize", false, [], []), true);
  assert.equal(isFinalizeAction("finalize", true, [], []), false);
  assert.match(completionRuleFor("run-tests", true), /不得声称任务完成/);
  assert.match(completionRuleFor("finalize", false, [], []), /decision=finalize/);
});
