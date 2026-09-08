import path from "node:path";
import { appendJsonLineLocked } from "../../../../core/atomic-store.js";
import {
  appendInterventionEvent,
  interventionIdFor,
  interventionLedgerJsonlPath,
  listInterventionEvents
} from "../../../../harness/observability/intervention-ledger.js";
import type { PolicyEngineReport } from "../../../../harness/verification-plane/policy-engine.js";
import type { InterventionStatus } from "../../../../harness/types.js";
import type { OpenCodeSidecarGuardStackSummary } from "../../sidecar.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import { readExecutionTrace, type ExecutionTrace } from "../../../../harness/observability/execution-trace.js";
import { emptyPluginInterventions, type PluginInterventionRecord, type PluginInterventionSnapshot } from "./types.js";
import { getApplicationInterventions } from "../../../../application/intervention-service.js";

export function pluginInterventionSnapshot(
  root: string,
  taskId: string | null,
  selectedFiles: string[] = [],
  excludedFiles: Array<{ path: string; reason: string }> = []
): PluginInterventionSnapshot {
  if (!taskId) return { ...emptyPluginInterventions(), selectedFiles: uniqueSorted(selectedFiles), excludedFiles: normalizeExcluded(excludedFiles) };
  const application = getApplicationInterventions(root, taskId);
  const events = application.events;
  syncJsonlLedger(root, taskId, events);
  const summary = application.summary;
  const interventions = events.map(toPluginIntervention);
  const latest = [...summary.active, ...summary.verified];
  return {
    ledgerPath: path.relative(root, interventionLedgerJsonlPath(root, taskId)).replaceAll("\\", "/"),
    eventCount: events.length,
    selectedFiles: uniqueSorted(selectedFiles),
    excludedFiles: normalizeExcluded(excludedFiles),
    interventions,
    problems: uniqueSorted(latest.filter((event) => event.status !== "verified").map((event) => event.problem)),
    actions: uniqueSorted(latest.map((event) => event.action)),
    verifiedFixes: summary.verified.map(toPluginIntervention),
    remainingProblems: summary.active.filter((event) => !["observed", "repaired"].includes(event.status)).map(toPluginIntervention),
    humanReview: summary.active.filter((event) => event.status === "human-review").map(toPluginIntervention),
    contextHelp: application.context.help,
    adoptedContextAdvice: application.context.adoptedAdvice,
    rejectedContextAdvice: application.context.rejectedAdvice,
    feedback: {
      kind: "maintainer-feedback",
      localOnly: application.feedback.localOnly,
      networkEnabled: application.feedback.networkEnabled,
      total: application.feedback.stats.total,
      labels: application.feedback.stats.labels.filter((item) => item.count > 0),
      annotationSeparate: true,
      evidenceAuthority: false
    }
  };
}

export function recordPluginContextSelection(input: {
  root: string;
  taskId: string;
  sessionId?: string | null;
  phase: "prepare" | "retrieve";
  selectedFiles: string[];
  excludedFiles: Array<{ path: string; reason: string }>;
}): void {
  try {
    const problem = `${input.phase} selected ${input.selectedFiles.length} context file(s) and excluded ${input.excludedFiles.length}.`;
    appendInterventionEvent(input.root, {
      interventionId: interventionIdFor({ taskId: input.taskId, category: "context", problem }),
      taskId: input.taskId,
      sessionId: input.sessionId ?? "default",
      timestamp: new Date().toISOString(),
      phase: input.phase,
      category: "context",
      problem,
      targetFiles: input.selectedFiles,
      action: `select context files for ${input.phase}`,
      beforeState: {},
      afterState: { selectedFiles: input.selectedFiles, excludedFiles: input.excludedFiles },
      evidenceRefs: input.excludedFiles.map((file) => `${file.path}: ${file.reason}`),
      status: "observed",
      confidence: 0.8,
      source: "system"
    });
  } catch {
    // Selection telemetry is best effort and must never fail the Desktop tool.
  }
}

export function recordPluginEvaluationInterventions(input: {
  root: string;
  taskId: string;
  sessionId: string | null;
  policy: PolicyEngineReport;
  guardStack: OpenCodeSidecarGuardStackSummary;
  blockers?: string[];
  decision: string;
  currentWorkingTreeHash?: string;
  trace?: ExecutionTrace | null;
  changedFiles?: string[];
}): void {
  const currentHash = input.currentWorkingTreeHash ?? currentSidecarWorkingTreeHash(input.root);
  const trace = input.trace ?? readExecutionTrace(input.root, input.taskId);
  for (const finding of input.policy.findings) {
    const category = finding.kind === "forbidden" ? "boundary" : finding.id.includes("context") ? "context" : "evidence";
    const interventionId = interventionIdFor({ taskId: input.taskId, findingId: finding.id, category, problem: finding.message });
    const status = statusForPolicyFinding(finding.status, finding.kind, trace, currentHash);
    safeAppend(input, {
      interventionId,
      findingId: finding.id,
      category,
      problem: finding.message,
      action: finding.requiredAction ?? "inspect policy finding",
      targetFiles: finding.file ? [finding.file] : (input.changedFiles ?? []),
      evidenceRefs: finding.evidence,
      status,
      source: finding.kind === "forbidden" ? "guard" : "policy",
      resolutionEvidence: resolutionEvidenceForTrace(finding.id, trace, currentHash)
    });
  }
  for (const blocker of input.blockers ?? []) {
    const interventionId = interventionIdFor({ taskId: input.taskId, findingId: undefined, category: "boundary", problem: blocker });
    safeAppend(input, {
      interventionId,
      category: "boundary",
      problem: blocker,
      action: "resolve sidecar blocker",
      targetFiles: input.changedFiles ?? [],
      evidenceRefs: [blocker],
      status: "prevented",
      source: "guard"
    });
  }
  const decisionId = `plugin-decision:${input.taskId}:${input.decision}`;
  safeAppend(input, {
    interventionId: interventionIdFor({ taskId: input.taskId, findingId: decisionId, category: "decision", problem: input.decision }),
    findingId: decisionId,
    category: "decision",
    problem: `Desktop Harness decision: ${input.decision}.`,
    action: input.decision,
    targetFiles: input.changedFiles ?? [],
    evidenceRefs: [],
    status: decisionStatus(input.decision, trace, currentHash),
    source: "decision",
    decisionRefs: [decisionId],
    resolutionEvidence: resolutionEvidenceForTrace("tests", trace, currentHash)
  });
}

function safeAppend(
  input: Parameters<typeof recordPluginEvaluationInterventions>[0],
  event: {
    interventionId: string;
    findingId?: string;
    category: "boundary" | "context" | "evidence" | "decision";
    problem: string;
    action: string;
    targetFiles: string[];
    evidenceRefs: string[];
    status: InterventionStatus;
    source: "guard" | "policy" | "decision";
    decisionRefs?: string[];
    resolutionEvidence?: Array<{
      kind: "command" | "ci" | "manual" | "trace";
      ref: string;
      workingTreeHash?: string;
      currentWorkingTree?: boolean;
      valid: boolean;
      details?: string[];
    }>;
  }
): void {
  try {
    const previous = listInterventionEvents(input.root, input.taskId)
      .filter((item) => item.interventionId === event.interventionId)
      .at(-1);
    const statuses = transitionStatuses(previous?.status, event.status);
    for (const status of statuses) {
      appendInterventionEvent(input.root, {
        ...event,
        eventId: `plugin:${event.interventionId}:${status}`,
        taskId: input.taskId,
        sessionId: input.sessionId ?? "default",
        timestamp: new Date().toISOString(),
        phase: "evaluate",
        confidence: 0.85,
        beforeState: { status: previous?.status ?? "none" },
        afterState: { status },
        traceRefs: input.trace ? [input.trace.id] : undefined
      });
    }
  } catch {
    // Plugin reporting is best effort and must never crash OpenCode Desktop.
  }
}

function transitionStatuses(previous: InterventionStatus | undefined, next: InterventionStatus): InterventionStatus[] {
  if (previous === next) return [];
  if (next === "verified" && ["requested", "stale", "unresolved", "human-review"].includes(previous ?? "")) return ["repaired", "verified"];
  if (next === "verified" && !previous) return ["requested", "repaired", "verified"];
  if (next === "stale" && !previous) return ["requested", "stale"];
  return [next];
}

function statusForPolicyFinding(status: string, kind: string, trace: ExecutionTrace | null, hash: string): InterventionStatus {
  if (status === "failed" && kind === "forbidden") return "prevented";
  if (status === "satisfied" && resolutionEvidenceForTrace("tests", trace, hash).some((item) => item.valid && item.currentWorkingTree)) return "verified";
  if (status === "failed" || status === "missing") return "requested";
  if (status === "warning") return "human-review";
  return "observed";
}

function decisionStatus(decision: string, trace: ExecutionTrace | null, hash: string): InterventionStatus {
  if (/rollback|block/i.test(decision)) return "prevented";
  if (/human-review|no-progress|max-loops/i.test(decision)) return "human-review";
  if (/finalize|ready/i.test(decision) && resolutionEvidenceForTrace("tests", trace, hash).some((item) => item.valid && item.currentWorkingTree))
    return "verified";
  if (/repair|test|repack/i.test(decision)) return "requested";
  return "observed";
}

function resolutionEvidenceForTrace(kind: string, trace: ExecutionTrace | null, hash: string) {
  return (trace?.steps ?? [])
    .filter((step) => /test|verify|check|lint|typecheck|contract/i.test(`${kind} ${step.action} ${step.command ?? ""}`))
    .map((step) => ({
      kind: step.evidenceSource === "ci" ? ("ci" as const) : ("command" as const),
      ref: step.id,
      workingTreeHash: step.workingTreeHashAfter,
      currentWorkingTree: step.workingTreeHashAfter === hash,
      valid: step.exitCode === 0,
      details: step.command ? [step.command] : [step.action]
    }));
}

function toPluginIntervention(event: ReturnType<typeof listInterventionEvents>[number]): PluginInterventionRecord {
  return {
    interventionId: event.interventionId,
    eventId: event.eventId,
    status: event.status,
    phase: event.phase,
    category: event.category,
    findingId: event.findingId,
    problem: event.problem,
    targetFiles: event.targetFiles,
    action: event.action,
    evidenceRefs: event.evidenceRefs,
    confidence: event.confidence,
    source: event.source,
    timestamp: event.timestamp,
    resolutionEvidence: event.resolutionEvidence,
    traceRefs: event.traceRefs,
    decisionRefs: event.decisionRefs
  };
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeExcluded(items: Array<{ path: string; reason: string }>): Array<{ path: string; reason: string }> {
  return [...new Map(items.filter((item) => item.path).map((item) => [item.path, { path: item.path, reason: item.reason || "not selected" }])).values()].sort(
    (left, right) => left.path.localeCompare(right.path)
  );
}

function syncJsonlLedger(root: string, taskId: string, events: ReturnType<typeof listInterventionEvents>): void {
  try {
    for (const event of events) appendJsonLineLocked(interventionLedgerJsonlPath(root, taskId), event);
  } catch {
    // A report path is diagnostic only; tool results remain available when persistence is unavailable.
  }
}
