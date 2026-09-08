import path from "node:path";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import { buildPluginCompactStatus, renderPluginCompactStatus, type PluginHarnessDisplayMode } from "./compact-status.js";
import {
  emptyPluginInterventions,
  type PluginActionSummary,
  type PluginHarnessResult,
  type PluginHarnessToolKind,
  type PluginPerformance,
  type PluginTaskIdSource
} from "./types.js";
import { buildPluginHarnessVisualization, persistPluginHarnessVisualization, renderPluginHarnessVisualization } from "./visualization.js";

export const PLUGIN_HARNESS_SCHEMA_VERSION = "opencode-plusplus.desktop-harness.v1";

export function createPluginHarnessResult(
  root: string,
  input: Omit<
    PluginHarnessResult,
    | "schemaVersion"
    | "repository"
    | "workingTreeHash"
    | "findings"
    | "missingEvidence"
    | "requiredCommands"
    | "mustInspect"
    | "allowedEditGlobs"
    | "avoidEditGlobs"
    | "artifacts"
    | "interventions"
    | "visualization"
  > &
    Partial<
      Pick<
        PluginHarnessResult,
        | "findings"
        | "missingEvidence"
        | "requiredCommands"
        | "mustInspect"
        | "allowedEditGlobs"
        | "avoidEditGlobs"
        | "artifacts"
        | "interventions"
        | "visualization"
      >
    >
): PluginHarnessResult {
  const result: PluginHarnessResult = {
    ...input,
    schemaVersion: PLUGIN_HARNESS_SCHEMA_VERSION,
    repository: path.resolve(root),
    workingTreeHash: currentSidecarWorkingTreeHash(root),
    findings: normalize(input.findings),
    missingEvidence: normalize(input.missingEvidence),
    requiredCommands: normalize(input.requiredCommands),
    mustInspect: normalize(input.mustInspect),
    allowedEditGlobs: normalize(input.allowedEditGlobs),
    avoidEditGlobs: normalize(input.avoidEditGlobs),
    artifacts: normalize(input.artifacts),
    interventions:
      input.interventions ??
      emptyPluginInterventions(
        path.relative(root, path.join(root, ".agent-context", "interventions", `${input.taskId ?? "unknown"}.jsonl`)).replaceAll("\\", "/")
      ),
    visualization:
      input.visualization ??
      buildPluginHarnessVisualization({
        currentPhase: input.currentPhase,
        taskStarted: Boolean(input.taskId),
        decision: input.decision,
        blocking: input.blocking,
        nextAction: input.nextAction,
        workingTreeHash: currentSidecarWorkingTreeHash(root),
        findings: input.findings,
        missingEvidence: input.missingEvidence,
        requiredCommands: input.requiredCommands,
        mustInspect: input.mustInspect,
        interventions: input.interventions
      })
  };
  const actionSummary = buildPluginActionSummary(result);
  return { ...result, summary: `${result.summary} OpenCode++ recorded: ${summaryCounts(actionSummary)}.`, actionSummary };
}

export function createPluginHarnessError(
  root: string,
  tool: PluginHarnessToolKind,
  message: string,
  taskId: string | null = null,
  sessionId: string | null = null,
  taskIdSource: PluginTaskIdSource = "none",
  performance?: PluginPerformance,
  error: NonNullable<PluginHarnessResult["error"]> = { code: "HARNESS_ERROR", message }
): PluginHarnessResult {
  const stopForReview = error.retryable === false;
  return createPluginHarnessResult(root, {
    ok: false,
    tool,
    summary: `OpenCode++ ${tool} failed: ${message}`,
    error,
    taskId,
    sessionId,
    taskIdSource,
    currentPhase: tool,
    decision: stopForReview ? "human-review" : "error",
    blocking: true,
    nextAction: stopForReview ? "human-review" : "prepare",
    performance
  });
}

export interface RenderPluginHarnessResultOptions {
  displayMode?: PluginHarnessDisplayMode;
}

export function renderPluginHarnessResult(result: PluginHarnessResult, options: RenderPluginHarnessResultOptions = {}): string {
  const visualization =
    result.visualization ??
    buildPluginHarnessVisualization({
      taskStarted: Boolean(result.taskId),
      currentPhase: result.currentPhase,
      decision: result.decision,
      blocking: result.blocking,
      nextAction: result.nextAction,
      workingTreeHash: result.workingTreeHash,
      findings: result.findings,
      missingEvidence: result.missingEvidence,
      requiredCommands: result.requiredCommands,
      mustInspect: result.mustInspect,
      interventions: result.interventions
    });
  const normalized = { ...result, visualization };
  const actionSummary = normalized.actionSummary ?? buildPluginActionSummary(normalized);
  const withSummary = {
    ...normalized,
    summary: normalized.actionSummary ? normalized.summary : `${normalized.summary} OpenCode++ recorded: ${summaryCounts(actionSummary)}.`,
    actionSummary
  };
  persistPluginHarnessVisualization(withSummary.repository, visualization);
  const displayMode = options.displayMode ?? (withSummary.tool === "dashboard" ? "detailed" : "compact");
  const compactStatus = buildPluginCompactStatus(withSummary);
  const dashboard = renderPluginHarnessVisualization(visualization);
  const humanReadable = displayMode === "detailed" ? detailedHumanReadableSummary(withSummary) : renderPluginCompactStatus(withSummary);
  const payload = {
    ...withSummary,
    compactStatus,
    displayMode,
    humanReadable,
    ...(withSummary.tool === "dashboard" || withSummary.decision === "human-review" ? { dashboard } : {})
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function detailedHumanReadableSummary(result: PluginHarnessResult): string {
  const actionSummary = result.actionSummary ?? buildPluginActionSummary(result);
  const lines = [
    "OpenCode++ action summary / OpenCode++ 执行总结",
    "The following is recorded by the OpenCode++ plugin, not a model-generated task summary. / 以下内容由 OpenCode++ 插件记录，不是模型生成的任务总结。",
    `Observed / 检测到: ${formatSummaryItems(actionSummary.observed)}`,
    `Prevented / 已阻止: ${formatSummaryItems(actionSummary.prevented)}`,
    `Requested / 已要求: ${formatSummaryItems(actionSummary.requested)}`,
    `Repaired, not yet verified / 已修正但未验证: ${formatSummaryItems(actionSummary.repaired)}`,
    `Verified / 已验证: ${formatSummaryItems(actionSummary.verified)}`,
    `Unresolved / 未解决: ${formatSummaryItems(actionSummary.unresolved)}`,
    `Evidence / 证据: ${formatSummaryItems(actionSummary.evidence)}`,
    "",
    `OpenCode++ ${result.tool}: ${result.summary}`,
    `Decision: ${result.decision}${result.blocking ? " (blocking)" : ""}`,
    `Next: ${result.nextAction}`
  ];
  if (result.mustInspect.length) lines.push(`Selected files: ${result.mustInspect.join(", ")}`);
  if (result.interventions?.excludedFiles.length) {
    lines.push(`Excluded files: ${result.interventions.excludedFiles.map((file) => `${file.path} (${file.reason})`).join(", ")}`);
  }
  if (result.interventions?.verifiedFixes.length) lines.push(`Verified fixes: ${result.interventions.verifiedFixes.map((event) => event.problem).join("; ")}`);
  if (result.interventions?.contextHelp?.length) lines.push(`Context help: ${result.interventions.contextHelp.join("; ")}`);
  if (result.interventions?.adoptedContextAdvice?.length)
    lines.push(`Context advice adopted: ${result.interventions.adoptedContextAdvice.map((item) => item.summary).join("; ")}`);
  if (result.interventions?.rejectedContextAdvice?.length)
    lines.push(`Context advice rejected: ${result.interventions.rejectedContextAdvice.map((item) => `${item.summary} (${item.reason})`).join("; ")}`);
  if (result.interventions?.feedback?.total) {
    lines.push(
      `Context feedback: ${result.interventions.feedback.total} local rating(s); network ${result.interventions.feedback.networkEnabled ? "enabled" : "disabled"}.`
    );
  }
  if (result.interventions?.remainingProblems.length)
    lines.push(`Remaining problems: ${result.interventions.remainingProblems.map((event) => event.problem).join("; ")}`);
  if (result.interventions?.humanReview.length) lines.push(`Human review: ${result.interventions.humanReview.map((event) => event.problem).join("; ")}`);
  if (result.requiredCommands.length) lines.push(`Required commands: ${result.requiredCommands.join(" | ")}`);
  if (result.visualization) lines.push(renderPluginHarnessVisualization(result.visualization));
  return lines.join("\n");
}

function buildPluginActionSummary(result: PluginHarnessResult): PluginActionSummary {
  const events = latestInterventions(result.interventions?.interventions ?? []);
  const selected = result.mustInspect.length ? [`Selected ${result.mustInspect.length} file(s) for inspection: ${result.mustInspect.join(", ")}`] : [];
  const excluded = (result.interventions?.excludedFiles ?? []).map((file) => `Excluded ${file.path}: ${file.reason}`);
  const observed = [...selected, ...excluded, ...result.findings.map((finding) => `Recorded finding: ${finding}`)];
  const prevented = events.filter((event) => event.status === "prevented").map((event) => describeIntervention(event));
  const requested = events.filter((event) => event.status === "requested").map((event) => describeIntervention(event));
  const repaired = events.filter((event) => event.status === "repaired").map((event) => describeIntervention(event));
  const verified = (result.interventions?.verifiedFixes ?? []).map((event) => describeIntervention(event));
  const unresolved = (result.interventions?.remainingProblems ?? []).map((event) => describeIntervention(event));
  const evidence = [
    result.workingTreeHash ? `Current working-tree hash captured: ${result.workingTreeHash}` : "Current working-tree hash was not captured",
    ...(result.requiredCommands.length ? [`Required commands: ${result.requiredCommands.join(" | ")}`] : []),
    ...(result.missingEvidence.length ? result.missingEvidence.map((item) => `Missing evidence: ${item}`) : []),
    ...(result.blocking ? ["Completion was not marked verified because the decision is blocking"] : ["No blocking decision was recorded"])
  ];
  return {
    observed: uniqueSummaryItems(observed),
    prevented: uniqueSummaryItems(prevented),
    requested: uniqueSummaryItems(requested),
    repaired: uniqueSummaryItems(repaired),
    verified: uniqueSummaryItems(verified),
    unresolved: uniqueSummaryItems(unresolved),
    evidence: uniqueSummaryItems(evidence)
  };
}

function latestInterventions(events: NonNullable<PluginHarnessResult["interventions"]>["interventions"]): typeof events {
  const latest = new Map<string, (typeof events)[number]>();
  for (const event of events) latest.set(event.interventionId, event);
  return [...latest.values()];
}

function describeIntervention(event: { problem: string; action: string; targetFiles: string[] }): string {
  const target = event.targetFiles.length ? ` [${event.targetFiles.join(", ")}]` : "";
  return `${event.problem} -> ${event.action}${target}`;
}

function formatSummaryItems(items: string[]): string {
  return items.length ? items.join("; ") : "none recorded / 未记录";
}

function summaryCounts(summary: PluginActionSummary): string {
  return [
    `observed=${summary.observed.length}`,
    `prevented=${summary.prevented.length}`,
    `requested=${summary.requested.length}`,
    `repaired=${summary.repaired.length}`,
    `verified=${summary.verified.length}`,
    `unresolved=${summary.unresolved.length}`
  ].join(", ");
}

function uniqueSummaryItems(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function normalize(items: string[] | undefined): string[] {
  return [...new Set((items ?? []).map((item) => item.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
