import type { HumanReviewRequest, InterventionStatus } from "../../../../harness/types.js";
import { writeJsonAtomic } from "../../../../core/atomic-store.js";
import path from "node:path";
import type { PluginInterventionSnapshot } from "./types.js";

export const PLUGIN_HARNESS_VISUALIZATION_SCHEMA_VERSION = "opencode-plusplus.desktop-visualization.v1";

export type PluginVisualizationStageStatus = "completed" | "active" | "blocked" | "pending";

export interface PluginVisualizationStage {
  id: string;
  label: string;
  status: PluginVisualizationStageStatus;
}

export interface PluginHarnessVisualization {
  schemaVersion: typeof PLUGIN_HARNESS_VISUALIZATION_SCHEMA_VERSION;
  view: "harness-progress";
  currentPhase: string;
  stages: PluginVisualizationStage[];
  decisionBasis: string[];
  observed: {
    selectedFiles: string[];
    rejectedFiles: Array<{ path: string; reason: string }>;
    findings: string[];
    missingEvidence: string[];
    requiredCommands: string[];
  };
  evidence: {
    workingTreeHash: string;
    currentTreeHashCaptured: boolean;
    verifiedFixes: number;
    staleEvidence: number;
    status: "verified" | "blocking" | "pending" | "not-started";
  };
  interventions: Record<InterventionStatus, number>;
  decision: {
    action: string;
    blocking: boolean;
    nextAction: string;
  };
  humanReview?: HumanReviewRequest;
  summary: string;
}

export interface PluginVisualizationInput {
  taskStarted: boolean;
  currentPhase: string;
  decision: string;
  blocking: boolean;
  nextAction: string;
  workingTreeHash: string;
  findings?: string[];
  missingEvidence?: string[];
  requiredCommands?: string[];
  mustInspect?: string[];
  interventions?: PluginInterventionSnapshot;
  humanReview?: HumanReviewRequest;
}

const STAGES = [
  ["plan", "Plan"],
  ["prepare", "Prepare"],
  ["retrieve", "Retrieve"],
  ["execute", "Execute"],
  ["collect", "Collect"],
  ["evaluate", "Evaluate"],
  ["decide", "Decide"],
  ["persist", "Persist"],
  ["finalize", "Finalize"]
] as const;

export function buildPluginHarnessVisualization(input: PluginVisualizationInput): PluginHarnessVisualization {
  const findings = unique(input.findings ?? []);
  const missingEvidence = unique(input.missingEvidence ?? []);
  const requiredCommands = unique(input.requiredCommands ?? []);
  const interventions = input.interventions;
  const currentStage = visualizationStageFor(input.currentPhase, input.decision, input.nextAction);
  const currentIndex = Math.max(
    0,
    STAGES.findIndex(([id]) => id === currentStage)
  );
  const stages = STAGES.map(([id, label], index) => ({
    id,
    label,
    status: stageStatus(id, index, currentStage, currentIndex, input.blocking)
  }));
  const interventionCounts = countInterventions(interventions?.interventions ?? []);
  const verifiedFixes = interventions?.verifiedFixes.length ?? 0;
  const staleEvidence = interventionCounts.stale;
  const evidenceStatus = !input.taskStarted
    ? "not-started"
    : verifiedFixes > 0 && !input.blocking
      ? "verified"
      : input.blocking || missingEvidence.length > 0
        ? "blocking"
        : "pending";

  return {
    schemaVersion: PLUGIN_HARNESS_VISUALIZATION_SCHEMA_VERSION,
    view: "harness-progress",
    currentPhase: input.currentPhase,
    stages,
    decisionBasis: decisionBasis(input, findings, missingEvidence, requiredCommands),
    observed: {
      selectedFiles: unique([...(input.mustInspect ?? []), ...(interventions?.selectedFiles ?? [])]),
      rejectedFiles: interventions?.excludedFiles ?? [],
      findings,
      missingEvidence,
      requiredCommands
    },
    evidence: {
      workingTreeHash: input.workingTreeHash,
      currentTreeHashCaptured: Boolean(input.workingTreeHash),
      verifiedFixes,
      staleEvidence,
      status: evidenceStatus
    },
    interventions: interventionCounts,
    decision: { action: input.decision, blocking: input.blocking, nextAction: input.nextAction },
    ...(input.humanReview ? { humanReview: input.humanReview } : {}),
    summary: visualizationSummary(input, evidenceStatus, verifiedFixes, missingEvidence.length)
  };
}

export function persistPluginHarnessVisualization(root: string, view: PluginHarnessVisualization): void {
  try {
    writeJsonAtomic(path.join(root, ".agent-context", "sidecar", "visualization.json"), { schemaVersion: 1, revision: Date.now(), visualization: view });
  } catch {
    // Visualization is diagnostic output; tool results remain available when persistence fails.
  }
}

export function renderPluginHarnessVisualization(view: PluginHarnessVisualization): string {
  const progress = view.stages.map((stage) => `${marker(stage.status)} ${stage.label}`).join("  ");
  const interventionSummary = Object.entries(view.interventions)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  return [
    "OpenCode++ Harness Dashboard",
    `Summary: ${view.summary}`,
    `Progress: ${progress}`,
    `Phase: ${view.currentPhase}`,
    `Decision: ${view.decision.action}${view.decision.blocking ? " (blocking)" : ""}`,
    `Next: ${view.decision.nextAction}`,
    `Evidence: ${view.evidence.status}; working-tree hash ${view.evidence.currentTreeHashCaptured ? "captured" : "not captured"}`,
    `Verified fixes: ${view.evidence.verifiedFixes}; stale evidence: ${view.evidence.staleEvidence}`,
    `Selected files: ${view.observed.selectedFiles.length ? view.observed.selectedFiles.join(", ") : "none"}`,
    `Rejected files: ${view.observed.rejectedFiles.length ? view.observed.rejectedFiles.map((item) => `${item.path} (${item.reason})`).join(", ") : "none"}`,
    `Interventions: ${interventionSummary || "none"}`,
    ...(view.humanReview
      ? [
          `Human review reason: ${view.humanReview.reasonCode}`,
          `Human review why: ${view.humanReview.explanation}`,
          `Human review action: ${view.humanReview.requiredUserAction}`,
          `Human review resume: ${view.humanReview.resumeCondition}`
        ]
      : []),
    "Decision basis:",
    ...(view.decisionBasis.length ? view.decisionBasis.map((item) => `- ${item}`) : ["- no blocking signal recorded"]),
    "Note: this dashboard shows recorded system facts and decision inputs, not hidden model reasoning."
  ].join("\n");
}

function visualizationStageFor(phase: string, decision: string, nextAction: string): string {
  if (decision === "finalize" || nextAction === "finalize") return "finalize";
  if (phase === "next") return "decide";
  if (phase === "dashboard") return decision === "idle" ? "plan" : visualizationStageFor("evaluate", decision, nextAction);
  return STAGES.some(([id]) => id === phase) ? phase : "plan";
}

function stageStatus(id: string, index: number, currentStage: string, currentIndex: number, blocking: boolean): PluginVisualizationStageStatus {
  if (id === currentStage) return blocking ? "blocked" : "active";
  if (index < currentIndex) return "completed";
  return "pending";
}

function decisionBasis(input: PluginVisualizationInput, findings: string[], missingEvidence: string[], requiredCommands: string[]): string[] {
  const basis = [`Current phase is ${input.currentPhase}.`, `Harness decision is ${input.decision}.`];
  if (findings.length) basis.push(`${findings.length} finding(s) were recorded.`);
  if (missingEvidence.length) basis.push(`Missing evidence: ${missingEvidence.join("; ")}`);
  if (requiredCommands.length) basis.push(`Required commands: ${requiredCommands.join(" | ")}`);
  if (input.blocking) basis.push("The decision is blocking, so completion is not allowed.");
  else basis.push("No blocking decision signal is recorded for this result.");
  if (input.workingTreeHash) basis.push("The current working-tree hash was captured for freshness comparison.");
  return basis;
}

function visualizationSummary(
  input: PluginVisualizationInput,
  evidenceStatus: PluginHarnessVisualization["evidence"]["status"],
  verifiedFixes: number,
  missingEvidenceCount: number
): string {
  if (input.decision === "finalize" && !input.blocking)
    return verifiedFixes ? `${verifiedFixes} fix(es) verified on the current working tree.` : "Ready to finalize; no verified fix was recorded.";
  if (input.blocking) return `Blocked at ${input.currentPhase}; ${missingEvidenceCount} evidence item(s) remain missing.`;
  if (evidenceStatus === "pending") return `In progress at ${input.currentPhase}; verification is still pending.`;
  return `Harness is at ${input.currentPhase}; next action is ${input.nextAction}.`;
}

function countInterventions(events: PluginInterventionSnapshot["interventions"]): Record<InterventionStatus, number> {
  const statuses: InterventionStatus[] = ["observed", "prevented", "requested", "repaired", "verified", "unresolved", "human-review", "stale"];
  return Object.fromEntries(statuses.map((status) => [status, events.filter((event) => event.status === status).length])) as Record<InterventionStatus, number>;
}

function marker(status: PluginVisualizationStageStatus): string {
  if (status === "completed") return "[x]";
  if (status === "active") return "[>]";
  if (status === "blocked") return "[!]";
  return "[ ]";
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
