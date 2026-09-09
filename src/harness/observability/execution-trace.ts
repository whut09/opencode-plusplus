import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readJsonDiagnostic, updateJsonAtomic, writeJsonAtomicWithRevision } from "../../core/atomic-store.js";
import { runSafeCommand } from "../../core/safe-command.js";
import { bullet, code, heading, table } from "../../outputs/renderers/markdown.js";
import { traceIdForTask as sharedTraceIdForTask } from "../../core/task-id.js";
import { currentWorkingTreeFingerprint } from "../../core/working-tree.js";

export type ExecutionFinalState = "planned" | "in_progress" | "partial_success" | "success" | "failed" | "blocked";
export type ExecutionStepResult = "passed" | "failed" | "skipped" | "unknown";
export type ExecutionEvidenceSource = "manual" | "command" | "ci";
export type ExecutionCapturedBy = "opencode-plusplus" | "external";
export type ExecutionEvidenceSourceName = "desktop-hook" | "cli" | "ci" | "manual";

export interface ExecutionTraceStep {
  id: string;
  at: string;
  eventId?: string;
  sequence?: number;
  sessionId?: string;
  taskId?: string;
  timestamp?: string;
  schemaVersion?: 1;
  agent?: string;
  action: string;
  files: string[];
  reason?: string;
  command?: string;
  test?: string;
  result?: ExecutionStepResult;
  output?: string;
  evidenceSource?: ExecutionEvidenceSource;
  source?: ExecutionEvidenceSourceName;
  capturedBy?: ExecutionCapturedBy;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string;
  stdoutHash?: string;
  stderrHash?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutRedacted?: boolean;
  stderrRedacted?: boolean;
  workingTreeHashBefore?: string;
  workingTreeHashAfter?: string;
  interventionIds?: string[];
}

export interface ExecutionTrace {
  schemaVersion: 1;
  revision?: number;
  id: string;
  task: string;
  agent?: string;
  createdAt: string;
  updatedAt: string;
  finalState: ExecutionFinalState;
  steps: ExecutionTraceStep[];
}

export interface TraceStartOptions {
  id?: string;
  agent?: string;
}

export interface TraceStepInput {
  eventId?: string;
  sessionId?: string;
  taskId?: string;
  at?: string;
  agent?: string;
  action: string;
  files?: string[];
  reason?: string;
  command?: string;
  test?: string;
  result?: ExecutionStepResult;
  output?: string;
  source?: ExecutionEvidenceSourceName;
  finalState?: ExecutionFinalState;
  evidenceSource?: ExecutionEvidenceSource;
  capturedBy?: ExecutionCapturedBy;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string;
  stdoutHash?: string;
  stderrHash?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutRedacted?: boolean;
  stderrRedacted?: boolean;
  workingTreeHashBefore?: string;
  workingTreeHashAfter?: string;
  interventionIds?: string[];
}

export interface TraceCommandRunInput {
  agent?: string;
  action?: string;
  command: string;
  files?: string[];
  reason?: string;
  test?: string;
  finalState?: ExecutionFinalState;
}

export interface TraceCommandRunResult {
  trace: ExecutionTrace;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function startExecutionTrace(root: string, task: string, options: TraceStartOptions = {}): ExecutionTrace {
  const now = new Date().toISOString();
  const traceId = options.id ?? traceIdForTask(task);
  const trace: ExecutionTrace = {
    schemaVersion: 1,
    revision: 0,
    id: traceId,
    task,
    agent: options.agent,
    createdAt: now,
    updatedAt: now,
    finalState: "planned",
    steps: [
      {
        id: "step-001",
        at: now,
        eventId: `${traceId}:step-001`,
        sequence: 1,
        sessionId: traceId,
        taskId: traceId,
        timestamp: now,
        schemaVersion: 1,
        agent: options.agent ?? "opencode-plusplus",
        action: "context-run-created",
        files: [],
        evidenceSource: "manual",
        reason: "Task execution context was created before agent editing."
      }
    ]
  };
  return updateJsonAtomic<ExecutionTrace>(executionTracePath(root, trace.id), (current) => (current ? { ...current, revision: current.revision ?? 0 } : trace));
}

export function appendExecutionTraceStep(root: string, traceId: string, input: TraceStepInput): ExecutionTrace {
  const filePath = executionTracePath(root, traceId);
  return updateJsonAtomic<ExecutionTrace>(filePath, (current) => {
    const trace = current ? { ...current, revision: current.revision ?? 0 } : null;
    if (!trace) throw new Error(`Execution trace not found: ${traceId}`);
    const eventId = input.eventId ?? traceEventId(traceId, input);
    const duplicate = trace.steps.find((step) => step.eventId === eventId || traceStepFingerprint(step) === traceStepFingerprint(input));
    if (duplicate) return trace;
    const now = input.at ?? new Date().toISOString();
    trace.steps.push({
      id: `step-${String(trace.steps.length + 1).padStart(3, "0")}`,
      at: now,
      eventId,
      sequence: trace.steps.reduce((max, step) => Math.max(max, step.sequence ?? 0), 0) + 1,
      sessionId: input.sessionId ?? trace.id,
      taskId: input.taskId ?? trace.id,
      timestamp: now,
      schemaVersion: 1,
      agent: input.agent ?? trace.agent,
      action: input.action,
      files: input.files ?? [],
      reason: input.reason,
      command: input.command,
      test: input.test,
      result: input.result,
      output: input.output,
      evidenceSource: input.evidenceSource ?? "manual",
      source: input.source,
      capturedBy: input.capturedBy,
      exitCode: input.exitCode,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      stdoutHash: input.stdoutHash,
      stderrHash: input.stderrHash,
      stdoutPreview: input.stdoutPreview,
      stderrPreview: input.stderrPreview,
      stdoutTruncated: input.stdoutTruncated,
      stderrTruncated: input.stderrTruncated,
      stdoutRedacted: input.stdoutRedacted,
      stderrRedacted: input.stderrRedacted,
      workingTreeHashBefore: input.workingTreeHashBefore,
      workingTreeHashAfter: input.workingTreeHashAfter,
      interventionIds: input.interventionIds ? [...new Set(input.interventionIds)].sort((a, b) => a.localeCompare(b)) : undefined
    });
    trace.updatedAt = now;
    trace.revision = (trace.revision ?? 0) + 1;
    if (input.finalState) trace.finalState = input.finalState;
    else if (trace.finalState === "planned") trace.finalState = "in_progress";
    return trace;
  });
}

function traceEventId(traceId: string, input: TraceStepInput): string {
  return `${traceId}:${createHash("sha256").update(traceStepFingerprint(input)).digest("hex").slice(0, 24)}`;
}

function traceStepFingerprint(
  step: Pick<ExecutionTraceStep, "action" | "command" | "test" | "startedAt" | "finishedAt" | "exitCode" | "stdoutHash" | "stderrHash">
): string {
  return JSON.stringify([
    step.action,
    step.command ?? "",
    step.test ?? "",
    step.startedAt ?? "",
    step.finishedAt ?? "",
    step.exitCode ?? null,
    step.stdoutHash ?? "",
    step.stderrHash ?? ""
  ]);
}

export function runTraceCommand(root: string, traceId: string, input: TraceCommandRunInput): TraceCommandRunResult {
  const startedAt = new Date().toISOString();
  const workingTreeHashBefore = currentWorkingTreeHash(root);
  let result: ReturnType<typeof runSafeCommand>;
  try {
    result = runSafeCommand(input.command, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    result = {
      command: input.command,
      file: "",
      args: [],
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      status: 2,
      error: error instanceof Error ? error : undefined
    };
  }
  const finishedAt = new Date().toISOString();
  const stdout = result.stdout;
  const stderr = result.stderr;
  const exitCode = result.status;
  const workingTreeHashAfter = currentWorkingTreeHash(root);
  const trace = appendExecutionTraceStep(root, traceId, {
    agent: input.agent,
    action: input.action ?? "run-test",
    files: input.files,
    reason: input.reason,
    command: input.command,
    test: input.test,
    result: exitCode === 0 ? "passed" : "failed",
    output: summarizeCommandOutput(stdout, stderr),
    finalState: input.finalState,
    evidenceSource: "command",
    capturedBy: "opencode-plusplus",
    exitCode,
    startedAt,
    finishedAt,
    stdoutHash: hashText(stdout),
    stderrHash: hashText(stderr),
    workingTreeHashBefore,
    workingTreeHashAfter
  });

  return { trace, exitCode, stdout, stderr };
}

export function readExecutionTrace(root: string, traceId: string): ExecutionTrace | null {
  const filePath = executionTracePath(root, traceId);
  if (!existsSync(filePath)) return null;
  const result = readJsonDiagnostic<ExecutionTrace>(filePath);
  if (result.status === "corrupt") throw new Error(`Unable to read execution trace ${traceId}: ${result.error}`);
  if (result.status !== "ok") return null;
  return { ...result.value, revision: result.value.revision ?? 0 };
}

export function writeExecutionTrace(root: string, trace: ExecutionTrace): string {
  const filePath = executionTracePath(root, trace.id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const persisted = writeJsonAtomicWithRevision(filePath, trace, trace.revision ?? 0);
  trace.revision = persisted.revision;
  return filePath;
}

export function executionTracePath(root: string, traceId: string): string {
  return path.join(root, ".agent-context", "traces", `${traceId}.json`);
}

export function renderExecutionTrace(trace: ExecutionTrace): string {
  return [
    heading(1, "Execution Trace"),
    "",
    `Trace: ${trace.id}`,
    `Task: ${trace.task}`,
    `Agent: ${trace.agent ?? "unknown"}`,
    `Final state: ${trace.finalState}`,
    `Created: ${trace.createdAt}`,
    `Updated: ${trace.updatedAt}`,
    "",
    heading(2, "Steps"),
    table(
      ["Step", "Agent", "Action", "Evidence", "Files", "Result", "Reason"],
      trace.steps.map((step) => [
        step.id,
        step.agent ?? "unknown",
        step.action,
        formatEvidenceSource(step),
        step.files.map(code).join(", ") || "none",
        step.result ?? "unknown",
        (step.reason ?? step.command ?? step.test ?? "").replace(/\|/g, "\\|")
      ])
    ),
    "",
    heading(2, "Commands"),
    bullet(trace.steps.filter((step) => step.command).map(formatCommandStep))
  ].join("\n");
}

export function traceIdForTask(task: string): string {
  return sharedTraceIdForTask(task);
}

function formatEvidenceSource(step: ExecutionTraceStep): string {
  const source = step.evidenceSource ?? "manual";
  if (source === "command" && step.capturedBy === "opencode-plusplus") return "command";
  if (source === "ci") return "ci";
  return "manual";
}

function formatCommandStep(step: ExecutionTraceStep): string {
  const details = [
    typeof step.exitCode === "number" ? `exit ${step.exitCode}` : undefined,
    step.stdoutHash ? `stdout ${step.stdoutHash.slice(0, 12)}` : undefined,
    step.stderrHash ? `stderr ${step.stderrHash.slice(0, 12)}` : undefined,
    step.workingTreeHashBefore && step.workingTreeHashAfter
      ? `tree ${step.workingTreeHashBefore.slice(0, 12)} -> ${step.workingTreeHashAfter.slice(0, 12)}`
      : undefined
  ].filter(Boolean);
  return `${step.id}: ${code(step.command ?? "")}${details.length ? ` (${details.join(", ")})` : ""}`;
}

function summarizeCommandOutput(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
  if (!combined) return "";
  return combined.length > 2000 ? `${combined.slice(0, 2000)}\n... truncated ...` : combined;
}

export function currentWorkingTreeHash(root: string): string {
  return currentWorkingTreeFingerprint(root);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
