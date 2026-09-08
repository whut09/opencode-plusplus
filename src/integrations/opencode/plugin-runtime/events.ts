import { createHash } from "node:crypto";
import path from "node:path";
import { appendJsonLineLocked } from "../../../core/atomic-store.js";
import { transitionForInterventions, transitionForResult, type HarnessToastTransition } from "./harness/compact-status.js";
import type { PluginHarnessResult, PluginInterventionSnapshot } from "./harness/types.js";

export interface OpenCodeSidecarRuntimeContext {
  directory: string;
  worktree?: string;
  client?: {
    app?: {
      log?: (input: { service: string; level: string; message: string; extra?: Record<string, unknown> }) => void;
    };
    tui?: {
      toast?: {
        show?: (input: { title: string; message: string }) => void;
      };
    };
  };
}

export function notifyOpenCodePlusPlusToast(context: OpenCodeSidecarRuntimeContext, title: string, message: string): "toast" | "log" {
  const toast = context.client?.tui?.toast?.show;
  if (typeof toast === "function") {
    try {
      toast.call(context.client?.tui?.toast, { title, message });
      return "toast";
    } catch {
      // Fall through to structured logging; a toast failure must never break the session.
    }
  }
  try {
    context.client?.app?.log?.({
      service: "opencode-plusplus",
      level: "info",
      message: `${title}: ${message}`,
      extra: { toast: true }
    });
  } catch {
    // Structured logging is best-effort and must never interrupt OpenCode.
  }
  return "log";
}

export function notifyPluginHarnessStatus(
  context: OpenCodeSidecarRuntimeContext,
  result: Pick<
    PluginHarnessResult,
    | "tool"
    | "summary"
    | "currentPhase"
    | "decision"
    | "blocking"
    | "nextAction"
    | "mustInspect"
    | "findings"
    | "missingEvidence"
    | "requiredCommands"
    | "visualization"
    | "actionSummary"
    | "workingTreeHash"
  >,
  recorder?: OpenCodeSidecarRecorder,
  showToast = true
): "toast" | "log" {
  const visualization = result.visualization;
  const selectedFiles = visualization?.observed.selectedFiles ?? result.mustInspect;
  const message = [
    `${result.tool} | phase=${result.currentPhase}`,
    `decision=${result.decision}${result.blocking ? " (blocking)" : ""}`,
    `next=${result.nextAction}`,
    `selected=${selectedFiles.length}`,
    `findings=${result.findings.length}`,
    `missingEvidence=${result.missingEvidence.length}`,
    `evidence=${visualization?.evidence.status ?? "pending"}`,
    `prevented=${result.actionSummary?.prevented.length ?? 0}`,
    `repaired=${result.actionSummary?.repaired.length ?? 0}`,
    `verified=${result.actionSummary?.verified.length ?? 0}`,
    `unresolved=${result.actionSummary?.unresolved.length ?? 0}`
  ].join(" | ");
  const extra = {
    harnessDashboard: true,
    tool: result.tool,
    phase: result.currentPhase,
    decision: result.decision,
    blocking: result.blocking,
    nextAction: result.nextAction,
    selectedFiles,
    findings: result.findings,
    missingEvidence: result.missingEvidence,
    summary: result.summary,
    actionSummary: result.actionSummary
  };

  try {
    recorder?.log("info", `OpenCode++ Harness Dashboard: ${message}`, extra);
  } catch {
    // Dashboard logging is diagnostic output and must never break a tool call.
  }

  if (result.tool === "evaluate" || result.tool === "next") {
    const transition = transitionForResult(result);
    const key = `${path.resolve(context.directory)}:harness-transition:${transition}:${result.currentPhase}:${result.decision}:${result.blocking}:${result.nextAction}:${result.workingTreeHash}:${result.summary}:${result.findings.join("|")}`;
    if (notifiedHarnessStatuses.has(key)) return "log";
    notifiedHarnessStatuses.add(key);
    if (!showToast) return "log";
    return notifyOpenCodePlusPlusToast(context, transitionTitle(transition), transitionMessage(transition, result));
  }
  return "log";
}

const notifiedInterventionSignals = new Set<string>();
const notifiedHarnessStatuses = new Set<string>();

function transitionTitle(transition: HarnessToastTransition): string {
  if (transition === "verification-started") return "OpenCode++ verification started";
  if (transition === "repair-required") return "OpenCode++ repair required";
  if (transition === "human-review-required") return "OpenCode++ human review required";
  return "OpenCode++ verified";
}

function transitionMessage(
  transition: HarnessToastTransition,
  result: Pick<PluginHarnessResult, "findings" | "missingEvidence" | "nextAction" | "requiredCommands" | "summary">
): string {
  if (transition === "verification-started") return "Checking the current working tree and recorded evidence.";
  if (transition === "verified") return "Current working-tree verification is complete.";
  const reason = [...result.findings, ...result.missingEvidence].find((item) => item.trim());
  if (reason) return reason;
  if (result.requiredCommands[0]) return `Next: run ${result.requiredCommands[0]}.`;
  return result.nextAction || result.summary;
}

function transitionMessageForSnapshot(transition: HarnessToastTransition, snapshot: PluginInterventionSnapshot): string {
  if (transition === "verified") return "A recorded fix now has current working-tree evidence.";
  if (transition === "human-review-required") return snapshot.humanReview[0]?.problem ?? "Manual review is required.";
  return snapshot.remainingProblems[0]?.problem ?? "The current task needs repair before it can be finalized.";
}

export function notifyPluginInterventionSignals(
  context: OpenCodeSidecarRuntimeContext,
  snapshot: PluginInterventionSnapshot | undefined,
  tool: "prepare" | "retrieve" | "evaluate" | "next" | "dashboard" | "human-review",
  recorder?: OpenCodeSidecarRecorder
): number {
  if (!snapshot || tool === "prepare" || tool === "retrieve" || tool === "dashboard") return 0;
  const scope = path.resolve(context.directory);
  const transition = transitionForInterventions(snapshot);
  if (!transition) return 0;
  const fingerprint = [
    transition,
    ...snapshot.remainingProblems.map((event) => `${event.interventionId}:${event.status}:${event.problem}`),
    ...snapshot.humanReview.map((event) => `${event.interventionId}:${event.status}:${event.problem}`),
    ...snapshot.verifiedFixes.map((event) => `${event.interventionId}:${event.status}:${event.problem}`)
  ]
    .sort()
    .join("|");
  const key = `${scope}:transition:${transition}:${fingerprint}`;
  if (notifiedInterventionSignals.has(key)) return 0;
  notifiedInterventionSignals.add(key);
  try {
    const channel = notifyOpenCodePlusPlusToast(context, transitionTitle(transition), transitionMessageForSnapshot(transition, snapshot));
    recorder?.record("sidecar.intervention-signal", { signal: transitionTitle(transition), interventionId: key, channel, tool });
  } catch (error) {
    recorder?.log("debug", "intervention signal notification failed", { message: error instanceof Error ? error.message : String(error) });
  }
  return 1;
}

export interface OpenCodeSidecarRecorder {
  eventLog: string;
  record: (type: string, payload?: Record<string, unknown>) => void;
  log: (level: string, message: string, extra?: Record<string, unknown>) => void;
}

export interface OpenCodeSidecarEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  sessionId: string;
  taskId: string | null;
  timestamp: string;
  type: string;
  ts: string;
  directory: string;
  worktree?: string;
  [key: string]: unknown;
}

export function createSidecarRecorder(context: OpenCodeSidecarRuntimeContext): OpenCodeSidecarRecorder {
  const eventLog = path.join(context.directory, ".agent-context", "traces", "opencode-sidecar-events.jsonl");

  function record(type: string, payload: Record<string, unknown> = {}): void {
    try {
      const timestamp = new Date().toISOString();
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : typeof payload.sessionID === "string" ? payload.sessionID : "default";
      const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
      const eventId = typeof payload.eventId === "string" && payload.eventId.trim() ? payload.eventId : eventIdFor(type, payload, timestamp);
      appendJsonLineLocked(eventLog, {
        schemaVersion: 1,
        eventId,
        sequence: 0,
        sessionId,
        taskId,
        timestamp,
        type,
        ts: timestamp,
        directory: context.directory,
        worktree: context.worktree,
        ...payload
      });
    } catch {
      // The sidecar must never break OpenCode. Verification can still run manually.
    }
  }

  function log(level: string, message: string, extra: Record<string, unknown> = {}): void {
    record("sidecar.log", { level, message, ...extra });
    try {
      context.client?.app?.log?.({
        service: "opencode-plusplus",
        level,
        message,
        extra
      });
    } catch {
      // Structured logging is best-effort and must never interrupt OpenCode.
    }
  }

  return { eventLog, record, log };
}

function eventIdFor(type: string, payload: Record<string, unknown>, timestamp: string): string {
  const callId = typeof payload.callId === "string" ? payload.callId : undefined;
  if (callId) return `${type}:${callId}`;
  return `${type}:${timestamp}:${createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
