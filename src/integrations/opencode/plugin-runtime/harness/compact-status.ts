import type { ResolutionEvidence } from "../../../../harness/types.js";
import type { PluginHarnessResult, PluginInterventionRecord, PluginInterventionSnapshot } from "./types.js";

export type PluginHarnessDisplayMode = "compact" | "detailed";
export type HarnessToastTransition = "verification-started" | "repair-required" | "human-review-required" | "verified";

export interface PluginCompactStatus {
  transition: HarnessToastTransition;
  icon: "✓" | "✗" | "⚠" | "…";
  label: "Verified" | "Repair required" | "Human review" | "Verification started";
  changedFiles: string[];
  selectedFiles: string[];
  passedChecks: string[];
  failedChecks: string[];
  pendingChecks: string[];
  reason: string;
  suggestion: string;
  next: string;
  actionSummary: Array<{ status: string; items: string[] }>;
}

export function buildPluginCompactStatus(result: PluginHarnessResult): PluginCompactStatus {
  const transition = transitionForResult(result);
  const evidence = collectEvidence(result.interventions);
  const selectedFiles = unique(result.interventions?.selectedFiles ?? result.mustInspect);
  const changedFiles = result.tool === "evaluate" || result.tool === "next" || result.tool === "dashboard" ? selectedFiles : [];
  const pendingChecks = unique(result.requiredCommands.filter((command) => !evidence.passed.includes(command) && !evidence.failed.includes(command)));
  const reason = compactReason(result, evidence.failed, transition);
  const next = compactNext(result, selectedFiles, pendingChecks);
  const suggestion = compactSuggestion(result, pendingChecks, transition);

  return {
    transition,
    icon: transition === "verified" ? "✓" : transition === "repair-required" ? "✗" : transition === "human-review-required" ? "⚠" : "…",
    label:
      transition === "verified"
        ? "Verified"
        : transition === "repair-required"
          ? "Repair required"
          : transition === "human-review-required"
            ? "Human review"
            : "Verification started",
    changedFiles,
    selectedFiles,
    passedChecks: evidence.passed,
    failedChecks: evidence.failed,
    pendingChecks,
    reason,
    suggestion,
    next,
    actionSummary: compactActionSummary(result)
  };
}

export function renderPluginCompactStatus(result: PluginHarnessResult): string {
  const status = buildPluginCompactStatus(result);
  const lines = [`OpenCode++ ${status.icon} ${status.label}`];

  if (status.changedFiles.length) {
    lines.push("", "Changed", `${status.changedFiles.length} file${status.changedFiles.length === 1 ? "" : "s"}`);
  } else if (result.tool === "prepare" || result.tool === "retrieve") {
    if (status.selectedFiles.length) lines.push("", "Selected", `${status.selectedFiles.length} file${status.selectedFiles.length === 1 ? "" : "s"}`);
  }

  if (status.passedChecks.length || status.failedChecks.length) {
    lines.push("", "Checks");
    lines.push(...status.passedChecks.map((command) => `✓ ${command}`));
    lines.push(...status.failedChecks.map((command) => `✗ ${command}`));
  }
  if (status.pendingChecks.length) {
    lines.push("", "Suggested checks");
    lines.push(...status.pendingChecks.map((command) => `• ${command}`));
  }

  if (status.actionSummary.length) {
    lines.push("", "Action Summary");
    for (const item of status.actionSummary) lines.push(`${capitalize(item.status)}: ${item.items.join("; ")}`);
  }

  if (status.transition === "verified") {
    lines.push("", "Status", "Ready to finalize");
  } else if (status.transition === "repair-required") {
    if (!status.failedChecks.length && status.reason) lines.push("", "Reason", status.reason);
    lines.push("", "Next", status.next);
  } else if (status.transition === "human-review-required") {
    lines.push("", "Need you", status.reason, "", "Suggested", status.suggestion);
  } else {
    lines.push("", "Status", "Verification started");
    if (status.next) lines.push("", "Next", status.next);
  }

  return lines.join("\n");
}

export function transitionForResult(
  result: Pick<PluginHarnessResult, "decision" | "blocking" | "nextAction" | "tool" | "visualization">
): HarnessToastTransition {
  if (result.decision === "human-review" || result.nextAction === "human-review") return "human-review-required";
  if (result.decision === "finalize" || (result.nextAction === "finalize" && !result.blocking) || result.visualization?.evidence.status === "verified") {
    return "verified";
  }
  if (result.blocking || /^(block|repair|repack|rollback|run-tests|error|no-progress)$/i.test(result.decision)) return "repair-required";
  return "verification-started";
}

export function transitionForInterventions(snapshot: PluginInterventionSnapshot | undefined): HarnessToastTransition | null {
  if (!snapshot) return null;
  if (snapshot.humanReview.length || snapshot.interventions.some((event) => /no-progress/i.test(`${event.action} ${event.problem}`))) {
    return "human-review-required";
  }
  if (snapshot.remainingProblems.some((event) => ["prevented", "requested", "unresolved"].includes(event.status))) return "repair-required";
  if (snapshot.verifiedFixes.length) return "verified";
  return null;
}

function compactReason(result: PluginHarnessResult, failedChecks: string[], transition: HarnessToastTransition): string {
  if (failedChecks.length) return failedChecks[0]!;
  const important = [...result.findings, ...result.missingEvidence].find((item) => item.trim());
  if (important) return important;
  if (transition === "human-review-required") return result.summary;
  if (transition === "repair-required") return result.nextAction || result.summary;
  return result.summary;
}

function compactSuggestion(result: PluginHarnessResult, pendingChecks: string[], transition: HarnessToastTransition): string {
  if (transition !== "human-review-required") return pendingChecks[0] ? `Run ${pendingChecks[0]} and evaluate again.` : result.nextAction;
  if (!pendingChecks.length && !result.requiredCommands.length) return "Configure a test command or manually review the diff.";
  if (pendingChecks[0]) return `Run ${pendingChecks[0]} and call evaluate again.`;
  return "Review the Dashboard and resolve the remaining blocker.";
}

function compactNext(result: PluginHarnessResult, selectedFiles: string[], pendingChecks: string[]): string {
  if (pendingChecks.length) return `Run ${pendingChecks[0]} and evaluate again.`;
  const target = result.interventions?.remainingProblems.flatMap((event) => event.targetFiles).find(Boolean) ?? selectedFiles[0];
  if (target && result.blocking) return `Fix ${target}.`;
  if (result.nextAction === "human-review") return "Review the diff and verification evidence.";
  return result.nextAction || "Continue the current task.";
}

function compactActionSummary(result: PluginHarnessResult): Array<{ status: string; items: string[] }> {
  const summary = result.actionSummary;
  if (!summary) return [];
  return (["prevented", "requested", "repaired", "verified", "unresolved"] as const)
    .map((status) => ({ status, items: unique(summary[status]) }))
    .filter((item) => item.items.length);
}

function collectEvidence(snapshot: PluginInterventionSnapshot | undefined): { passed: string[]; failed: string[] } {
  const records = new Map<string, PluginInterventionRecord>();
  for (const event of snapshot?.interventions ?? []) records.set(event.eventId, event);
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const event of records.values()) {
    for (const evidence of event.resolutionEvidence ?? []) {
      const command = evidenceCommand(evidence);
      if (!command || !isCommandEvidence(evidence)) continue;
      if (evidence.valid && evidence.currentWorkingTree) passed.add(command);
      else if (!evidence.valid) failed.add(command);
    }
  }
  return { passed: [...passed].sort(compareText), failed: [...failed].sort(compareText) };
}

function evidenceCommand(evidence: ResolutionEvidence): string | undefined {
  const detail = evidence.details?.find((item) => item.trim());
  return detail?.trim() || (evidence.kind === "command" || evidence.kind === "ci" ? evidence.ref : undefined);
}

function isCommandEvidence(evidence: ResolutionEvidence): boolean {
  if (evidence.kind !== "command" && evidence.kind !== "ci") return false;
  const detail = evidence.details?.find((item) => item.trim());
  return Boolean(detail && isExecutableCommand(detail));
}

function isExecutableCommand(value: string): boolean {
  return /^(?:\.?[\\/]?\.?[\\w.-]+[\\/]?)?(?:npm(?:\.cmd)?|pnpm|yarn|bun|node|npx|python(?:\.exe)?|pytest|go|cargo|dotnet|mvn(?:w)?|gradle(?:w)?|opencode-plusplus)\b/i.test(
    value.trim()
  );
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
