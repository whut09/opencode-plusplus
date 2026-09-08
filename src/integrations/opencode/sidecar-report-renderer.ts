import path from "node:path";

interface Check {
  status: string;
  name: string;
  details: string;
}

interface GuardStack {
  ran: boolean;
  passed: boolean;
  base: string;
  error?: string;
  contracts?: { passed: boolean; violations: number };
  hallucination?: { errors: number; warnings: number };
  regression?: { matches: number; missingRequiredTestEvidence: number };
  impact?: { risk: string; changedFiles: number; relatedTests: number };
  tests?: { minimalCommands: number; recommendedCommands: number; fullConfidenceCommands: number };
  verification?: { classification: string; commands: number; codeTestRequired: boolean; verificationRequired: boolean };
  policy?: { passed: boolean; forbidden: number; requiredMissing: number; risks: number };
}

export function renderCommandCheck(result: {
  command: string | null;
  paths: string[];
  disposition?: "allowed" | "approval-required" | "policy-blocked";
  allowed: boolean;
  approvalRequired?: boolean;
  findings: Array<{
    severity: string;
    message: string;
    evidence?: string[];
    doInstead?: string;
    disposition?: "allowed" | "approval-required" | "policy-blocked";
  }>;
}): string {
  const findingLines = result.findings.length
    ? result.findings.flatMap((finding) => {
        const label = finding.disposition === "approval-required" ? "APPROVAL REQUIRED" : finding.severity === "warning" ? "WARNING" : "BLOCKED";
        const lines = [
          `${label}: ${finding.message}`,
          `Evidence: ${(finding.evidence ?? []).join(" | ") || "n/a"}`
        ];
        if (finding.doInstead) lines.push(`Do instead: ${finding.doInstead}`);
        return lines;
      })
    : ["- none"];
  return [
    "OpenCode++ Sidecar Command Check",
    "",
    `Command: ${result.command ?? "none"}`,
    `Paths: ${result.paths.length ? result.paths.join(", ") : "none"}`,
    `Result: ${result.disposition ?? (result.allowed ? "allowed" : "policy-blocked")}`,
    `Native approval: ${result.approvalRequired ? "required" : "not required"}`,
    "",
    "Findings:",
    ...findingLines
  ].join("\n");
}

export function renderToolRecord(result: {
  repo: string;
  tracePath: string;
  eventLogPath: string;
  event: { tool: string; command: string | null; exitCode: number | null; filesTouched: string[] };
}): string {
  return [
    "OpenCode++ Sidecar Tool Record",
    "",
    `Tool: ${result.event.tool}`,
    `Command: ${result.event.command ?? "none"}`,
    `Exit code: ${result.event.exitCode ?? "unknown"}`,
    `Trace: ${path.relative(result.repo, result.tracePath).replaceAll("\\", "/")}`,
    `Event log: ${path.relative(result.repo, result.eventLogPath).replaceAll("\\", "/")}`,
    "",
    "Files touched:",
    ...(result.event.filesTouched.length ? result.event.filesTouched.map((file) => `- ${file}`) : ["- none"])
  ].join("\n");
}

export function renderVerifyReport(result: {
  repo: string;
  pluginPath: string;
  eventLogPath: string;
  checks: Check[];
  changedFiles: string[];
  blockers: string[];
  warnings: string[];
  guardStack: GuardStack;
  ok: boolean;
  interventions?: InterventionReport;
}): string {
  return [
    "OpenCode++ OpenCode Sidecar Verify",
    "",
    `Repo: ${result.repo}`,
    `Plugin: ${path.relative(result.repo, result.pluginPath)}`,
    `Event log: ${path.relative(result.repo, result.eventLogPath)}`,
    "",
    "Checks:",
    ...result.checks.map((check) => `- [${check.status.toUpperCase()}] ${check.name}: ${check.details}`),
    "",
    "Changed files:",
    ...(result.changedFiles.length ? result.changedFiles.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Blockers:",
    ...(result.blockers.length ? result.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "",
    "Warnings:",
    ...(result.warnings.length ? result.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    ...renderInterventionSections(result.interventions),
    "",
    "Guard stack:",
    ...formatGuardStackLines(result.guardStack),
    "",
    result.ok ? "Result: ready" : "Result: failed"
  ].join("\n");
}

export function renderLatestMarkdown(result: {
  generatedAt: string;
  ok: boolean;
  changedFiles: string[];
  blockers: string[];
  warnings: string[];
  guardStack: GuardStack;
  checks: Check[];
  interventions?: InterventionReport;
}): string {
  return [
    "# OpenCode++ Sidecar Latest",
    "",
    `Generated: ${result.generatedAt}`,
    `Result: ${result.ok ? "ready" : "blocked"}`,
    "",
    "## Changed Files",
    ...(result.changedFiles.length ? result.changedFiles.map((file) => `- \`${file}\``) : ["- none"]),
    "",
    "## Blockers",
    ...(result.blockers.length ? result.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "",
    "## Warnings",
    ...(result.warnings.length ? result.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    ...renderInterventionSections(result.interventions),
    "",
    "## Guard Stack",
    ...formatGuardStackLines(result.guardStack),
    "",
    "## Checks",
    ...result.checks.map((check) => `- **${check.status.toUpperCase()}** ${check.name}: ${check.details}`)
  ].join("\n");
}

interface InterventionReport {
  selectedFiles: string[];
  excludedFiles: Array<{ path: string; reason: string }>;
  verifiedFixes: Array<{ problem: string; action: string; targetFiles: string[] }>;
  remainingProblems: Array<{ problem: string; action: string; status: string; targetFiles: string[] }>;
  humanReview: Array<{ problem: string; action: string; targetFiles: string[] }>;
  contextHelp?: string[];
  adoptedContextAdvice?: Array<{ summary: string; reason: string }>;
  rejectedContextAdvice?: Array<{ summary: string; reason: string }>;
  feedback?: {
    localOnly: boolean;
    networkEnabled: boolean;
    total: number;
    labels: Array<{ label: string; count: number }>;
    annotationSeparate: true;
    evidenceAuthority: false;
  };
}

function renderInterventionSections(interventions: InterventionReport | undefined): string[] {
  if (!interventions) {
    return [
      "## Intervention Summary",
      "- none recorded",
      "",
      "## Verified Fixes",
      "- none recorded",
      "",
      "## Remaining Problems",
      "- none recorded",
      "",
      "## Human Review",
      "- none recorded",
      "",
      "## Context Help",
      "- none recorded",
      "",
      "## Context Advice Adopted",
      "- none recorded",
      "",
      "## Context Advice Rejected",
      "- none recorded",
      "",
      "## Context Feedback",
      "- none recorded",
      "- Maintainer feedback is separate from local annotations and verification evidence."
    ];
  }
  return [
    "## Intervention Summary",
    ...(interventions.selectedFiles.length ? [`- selected: ${interventions.selectedFiles.join(", ")}`] : ["- selected: none"]),
    ...(interventions.excludedFiles.length ? interventions.excludedFiles.map((file) => `- excluded: ${file.path} (${file.reason})`) : ["- excluded: none"]),
    "",
    "## Verified Fixes",
    ...formatInterventions(interventions.verifiedFixes),
    "",
    "## Remaining Problems",
    ...formatInterventions(interventions.remainingProblems, true),
    "",
    "## Human Review",
    ...formatInterventions(interventions.humanReview),
    "",
    "## Context Help",
    ...(interventions.contextHelp?.length ? interventions.contextHelp.map((item) => `- ${item}`) : ["- none recorded"]),
    "",
    "## Context Advice Adopted",
    ...(interventions.adoptedContextAdvice?.length
      ? interventions.adoptedContextAdvice.map((item) => `- ${item.summary} (${item.reason})`)
      : ["- none recorded"]),
    "",
    "## Context Advice Rejected",
    ...(interventions.rejectedContextAdvice?.length
      ? interventions.rejectedContextAdvice.map((item) => `- ${item.summary} (${item.reason})`)
      : ["- none recorded"]),
    "",
    "## Context Feedback",
    `- local feedback: ${interventions.feedback?.total ?? 0}`,
    `- labels: ${interventions.feedback?.labels.length ? interventions.feedback.labels.map((item) => `${item.label}=${item.count}`).join(", ") : "none"}`,
    `- network submission: ${interventions.feedback?.networkEnabled ? "enabled" : "disabled"}`,
    "- Maintainer feedback is separate from local annotations and cannot satisfy verification evidence."
  ];
}

function formatInterventions(items: Array<{ problem: string; action: string; status?: string; targetFiles: string[] }>, includeStatus = false): string[] {
  return items.length
    ? items.map(
        (item) =>
          `- ${includeStatus && item.status ? `[${item.status}] ` : ""}${item.problem} -> ${item.action}${item.targetFiles.length ? ` (${item.targetFiles.join(", ")})` : ""}`
      )
    : ["- none recorded"];
}

export function formatGuardStackLines(summary: GuardStack): string[] {
  if (!summary.ran) return [`- failed to run: ${summary.error ?? "unknown error"}`];
  return [
    `- passed: ${summary.passed ? "yes" : "no"}`,
    `- base: ${summary.base}`,
    `- contracts: ${summary.contracts?.passed ? "passed" : "failed"} (${summary.contracts?.violations ?? 0} violation(s))`,
    `- hallucination: ${summary.hallucination?.errors ?? 0} error(s), ${summary.hallucination?.warnings ?? 0} warning(s)`,
    `- regression: ${summary.regression?.matches ?? 0} match(es), ${summary.regression?.missingRequiredTestEvidence ?? 0} missing evidence`,
    `- impact: ${summary.impact?.risk ?? "unknown"} (${summary.impact?.changedFiles ?? 0} changed file(s), ${summary.impact?.relatedTests ?? 0} related test(s))`,
    `- tests: ${summary.tests?.minimalCommands ?? 0} minimal, ${summary.tests?.recommendedCommands ?? 0} recommended, ${summary.tests?.fullConfidenceCommands ?? 0} full-confidence command(s)`,
    `- smart verification: ${summary.verification?.classification ?? "unknown"} (${summary.verification?.commands ?? 0} recommended, code tests ${summary.verification?.codeTestRequired ? "required" : "not required"}, verification ${summary.verification?.verificationRequired ? "required" : "not required"})`,
    `- policy: ${summary.policy?.passed ? "passed" : "failed"} (${summary.policy?.forbidden ?? 0} forbidden, ${summary.policy?.requiredMissing ?? 0} required missing, ${summary.policy?.risks ?? 0} risk(s))`
  ];
}
