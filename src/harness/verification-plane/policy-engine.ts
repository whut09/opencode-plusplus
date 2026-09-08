import type { ContextPackage, EvidencePolicyMode, IndexedFile } from "../../core/types.js";
import { changedFilesSince, runGit } from "../../core/git.js";
import { assessDrift, assessFreshness } from "../../core/freshness.js";
import { buildChangeImpactReport } from "../../outputs/impact.js";
import { validateContracts } from "../../outputs/contract-validator.js";
import { buildTestSelection } from "../../outputs/test-selector.js";
import { currentWorkingTreeHash, readExecutionTrace } from "../observability/execution-trace.js";
import { evidenceSatisfies } from "../../outputs/evidence.js";
import { buildHallucinationReport } from "./guards/hallucination.js";
import { buildRegressionReport } from "./guards/regression.js";
import { bullet, code, heading, table } from "../../outputs/renderers/markdown.js";
import type { GuardResult } from "../types.js";
import { createGuardResult } from "../types.js";
import { assessExternalContextPolicy, type ContextPolicyAssessment } from "../knowledge/context-policy.js";
import type { ContextUsageRecord } from "../../context-registry/types.js";
import { firstTestExecutionCommand } from "../../core/test-command.js";
import { buildVerificationPlan } from "../../core/verification/planner.js";
import { requiresSourceVerification } from "../../core/verification/classifier.js";
import type { VerificationPlan } from "../../core/verification/types.js";

export type PolicyKind = "forbidden" | "risk" | "required";
export type PolicyStatus = "failed" | "warning" | "missing" | "satisfied";
export type PolicySeverity = "error" | "warning" | "required" | "info";
export type PolicyFailOn = "forbidden" | "required" | "risk";

export interface PolicyEngineOptions {
  base?: string;
  traceId?: string;
  strict?: boolean;
  failOn?: PolicyFailOn;
  evidencePolicy?: EvidencePolicyMode;
  contextTaskId?: string;
  contextUsage?: ContextUsageRecord[];
}

export interface PolicyFinding extends Partial<
  Pick<GuardResult, "blocking" | "confidence" | "reasons" | "requiredCommands" | "artifacts" | "interventionIds">
> {
  id: string;
  kind: PolicyKind;
  status: PolicyStatus;
  severity: PolicySeverity;
  message: string;
  file?: string;
  evidence: string[];
  requiredAction?: string;
}

export interface PolicyEngineReport {
  passed: boolean;
  base: string;
  traceId?: string;
  traceLoaded: boolean;
  failOn: PolicyFailOn;
  evidencePolicy?: EvidencePolicyMode;
  changedFiles: string[];
  generatedContextFiles: string[];
  summary: {
    forbidden: number;
    risks: number;
    requiredMissing: number;
    requiredSatisfied: number;
  };
  findings: PolicyFinding[];
  results: GuardResult[];
  contextPolicy?: ContextPolicyAssessment;
  verification?: VerificationPlan;
}

export function buildPolicyReport(context: ContextPackage, options: PolicyEngineOptions = {}): PolicyEngineReport {
  const base = options.base ?? "main";
  const failOn = normalizeFailOn(options);
  const evidencePolicy = options.evidencePolicy ?? context.config.evidencePolicy;
  const trace = options.traceId ? readExecutionTrace(context.scan.root, options.traceId) : null;
  const changed = changedFilesForPolicy(context, base);
  const indexed = new Map(context.index.files.map((file) => [file.path, file]));
  const changedIndexed = changed.actionable.map((file) => indexed.get(file)).filter((file): file is IndexedFile => Boolean(file));
  const verification = buildVerificationPlan(context, { changedFiles: changed.actionable });
  const sourceOrConfigChanged = requiresSourceVerification(verification.classification);
  const contracts = validateContracts(context, { base, diff: true });
  const freshness = assessFreshness(context);
  const drift = assessDrift(context);
  const impact = buildChangeImpactReport(context, { base });
  const tests = buildTestSelection(context, { diff: true, base });
  const hallucination = buildHallucinationReport(context, { base, traceId: options.traceId, task: trace?.task });
  const regression = buildRegressionReport(context, {
    base,
    traceId: options.traceId,
    task: trace?.task,
    changedFiles: changed.actionable,
    evidencePolicy
  });
  const currentRepoHash = currentWorkingTreeHash(context.scan.root);
  const contextPolicy = assessExternalContextPolicy(context.scan.root, {
    taskId: options.contextTaskId,
    records: options.contextUsage,
    currentWorkingTreeHash: currentRepoHash
  });
  const testEvidence = evidenceSatisfies(
    {
      kind: "tests",
      currentRepoHash,
      requiredCommands: verification.commands.filter((command) => command.kind === "test").map((command) => command.command),
      policy: evidencePolicy,
      sourceChanged: sourceOrConfigChanged
    },
    trace
  );
  const contractEvidence = evidenceSatisfies(
    {
      kind: "contract-validation",
      currentRepoHash,
      requiredCommands: [`opencode-plusplus validate-contracts . --base ${base}`],
      policy: evidencePolicy,
      sourceChanged: sourceOrConfigChanged
    },
    trace
  );
  const findings: PolicyFinding[] = [];

  for (const finding of contextPolicy.findings.filter((item) => item.status !== "passed")) {
    findings.push({
      id: finding.status === "blocked" ? `policy.required.${finding.id}` : `policy.risk.${finding.id}`,
      kind: finding.status === "blocked" ? "required" : "risk",
      status: finding.status === "blocked" ? "missing" : "warning",
      severity: finding.status === "blocked" ? "required" : "warning",
      message: finding.message,
      evidence: finding.evidence,
      requiredAction: finding.requiredAction
    });
  }

  for (const file of changedIndexed.filter((item) => item.isGenerated || item.kind === "generated")) {
    if (isGeneratedContextState(file.path)) continue;
    findings.push({
      id: "policy.forbidden.generated-source",
      kind: "forbidden",
      status: "failed",
      severity: "error",
      file: file.path,
      message: "Generated source output changed directly.",
      evidence: [`${file.path} is classified as generated output.`],
      requiredAction: "Regenerate it from its source inputs or exclude build artifacts from the diff."
    });
  }

  for (const file of changed.actionable.filter(isBuildOutputPath)) {
    findings.push({
      id: "policy.forbidden.build-output",
      kind: "forbidden",
      status: "failed",
      severity: "error",
      file,
      message: "Build output changed directly.",
      evidence: [`${file} matches a generated build output path.`],
      requiredAction: "Do not commit generated build output; regenerate locally when needed."
    });
  }

  for (const violation of contracts.violations.filter((item) => !isGeneratedContextState(item.file))) {
    findings.push({
      id: `policy.${violation.severity === "error" ? "forbidden" : "risk"}.contract`,
      kind: violation.severity === "error" ? "forbidden" : "risk",
      status: violation.severity === "error" ? "failed" : "warning",
      severity: violation.severity,
      file: violation.file,
      message: violation.message,
      evidence: [violation.reason, `Rule: ${violation.rule}`],
      requiredAction: violation.severity === "error" ? `Run opencode-plusplus validate-contracts . --base ${base} and repair the violating edit.` : undefined
    });
  }

  for (const file of changed.actionable.filter(isSensitivePath)) {
    findings.push({
      id: "policy.risk.sensitive-area",
      kind: "risk",
      status: "warning",
      severity: "warning",
      file,
      message: "Sensitive area changed.",
      evidence: [`${file} matches auth, payment, billing, checkout, invoice, security, or session risk terms.`],
      requiredAction: "Inspect callers, related tests, and runtime configuration before closing the loop."
    });
  }

  if (changed.actionable.length >= 10) {
    findings.push({
      id: "policy.risk.large-diff",
      kind: "risk",
      status: "warning",
      severity: "warning",
      message: "Large diff detected.",
      evidence: [`${changed.actionable.length} non-generated-context files changed.`],
      requiredAction: "Split the task or run broader verification before review."
    });
  }

  if (impact.risk === "High") {
    findings.push({
      id: "policy.risk.high-impact",
      kind: "risk",
      status: "warning",
      severity: "warning",
      message: "High impact change detected.",
      evidence: impact.riskFactors,
      requiredAction: `Run opencode-plusplus impact . --base ${base} and include dependents in the next agent context.`
    });
  }

  if (sourceOrConfigChanged) {
    findings.push(
      requiredFinding("policy.required.tests", testEvidence.satisfied, {
        message: "Changed source or config requires passed test evidence.",
        evidence: [
          `${changedIndexed.filter((file) => isPolicyRelevantFile(file)).length} source/config file(s) changed.`,
          trace ? `Trace loaded: ${trace.id}.` : "No execution trace was provided.",
          ...testEvidence.evidence,
          ...verification.commands.slice(0, 5).map((command) => `Suggested: ${command.command}`),
          ...tests.fullConfidenceCommands.slice(0, 2).map((command) => `Existing selector suggestion: ${command}`)
        ],
        requiredAction:
          firstTestExecutionCommand(verification.commands.filter((command) => command.kind === "test").map((command) => command.command)) ??
          "No runnable test command is configured; choose or configure the repository test command before finalizing."
      })
    );

    findings.push(
      requiredFinding("policy.required.contract-validation", contractEvidence.satisfied, {
        message: "Changed source or config requires contract validation evidence.",
        evidence: [trace ? `Trace loaded: ${trace.id}.` : "No execution trace was provided.", ...contractEvidence.evidence],
        requiredAction: `opencode-plusplus validate-contracts . --base ${base}`
      })
    );

    if (testEvidence.claimed && !testEvidence.verified) {
      findings.push({
        id: "policy.risk.manual-test-evidence",
        kind: "risk",
        status: "warning",
        severity: "warning",
        message: "Test evidence is manually reported instead of harness-captured.",
        evidence: [
          "Manual evidence can document agent intent, but command evidence includes exit code, output hashes, and working-tree hashes.",
          `Preferred: opencode-plusplus trace run ${trace?.id ?? "<trace-id>"} . --action run-test --command "<test-command>"`
        ],
        requiredAction: `Record command evidence with opencode-plusplus trace run ${trace?.id ?? "<trace-id>"} . --action run-test --command "<test-command>".`
      });
    }
  }

  if (freshness.status !== "fresh" || drift.status !== "clean") {
    findings.push({
      id: "policy.required.context-refresh",
      kind: "required",
      status: "missing",
      severity: "required",
      message: "Generated context is stale or drifted.",
      evidence: [...freshness.reasons, ...drift.reasons].slice(0, 8),
      requiredAction: "opencode-plusplus update ."
    });
  } else {
    findings.push({
      id: "policy.required.context-refresh",
      kind: "required",
      status: "satisfied",
      severity: "info",
      message: "Generated context is fresh.",
      evidence: ["Freshness is fresh and drift is clean."]
    });
  }

  if (requiresContractRegeneration(changed.actionable) && !changed.generatedContextFiles.some((file) => file.startsWith(".agent-context/contracts/"))) {
    findings.push({
      id: "policy.required.contract-regeneration",
      kind: "required",
      status: "missing",
      severity: "required",
      message: "Policy or contract generator changed without regenerated contract artifacts.",
      evidence: changed.actionable.filter(isContractGeneratorPath),
      requiredAction: "opencode-plusplus update ."
    });
  }

  if (regression.summary.matches > 0) {
    findings.push(
      requiredFinding("policy.required.regression-tests", regression.summary.missingRequiredTestEvidence === 0, {
        message: "Matched regression memory requires passed anti-regression test evidence.",
        evidence: [
          `${regression.summary.matches} regression memory entr${regression.summary.matches === 1 ? "y" : "ies"} matched.`,
          ...regression.matches.map((match) => `${match.id}: ${match.pattern}`),
          ...regression.evidence.evidence
        ],
        requiredAction: regression.requiredTests[0] ?? `opencode-plusplus regression . --base ${base}${options.traceId ? ` --trace ${options.traceId}` : ""}`
      })
    );
  }

  for (const result of hallucination.results) {
    findings.push(policyFindingFromGuardResult(result));
  }

  const summary = {
    forbidden: findings.filter((finding) => finding.kind === "forbidden" && finding.status === "failed").length,
    risks: findings.filter((finding) => finding.kind === "risk").length,
    requiredMissing: findings.filter((finding) => finding.kind === "required" && finding.status === "missing").length,
    requiredSatisfied: findings.filter((finding) => finding.kind === "required" && finding.status === "satisfied").length
  };
  const results = findings.map(policyFindingToResult);

  return {
    passed: policyPassed(summary, failOn),
    base,
    traceId: options.traceId,
    traceLoaded: Boolean(trace),
    failOn,
    evidencePolicy,
    changedFiles: changed.actionable,
    generatedContextFiles: changed.generatedContextFiles,
    summary,
    findings,
    results,
    contextPolicy,
    verification
  };
}

export function renderPolicyReport(report: PolicyEngineReport): string {
  return [
    heading(1, "Policy Engine"),
    "",
    `Policy check: ${report.passed ? "passed" : "failed"}`,
    `Base: ${report.base}`,
    `Fail on: ${report.failOn}`,
    `Evidence policy: ${report.evidencePolicy ?? "advisory"}`,
    `Verification plan: ${report.verification?.classification.primaryKind ?? "legacy selector"}`,
    report.traceId ? `Trace: ${report.traceId} (${report.traceLoaded ? "loaded" : "missing"})` : "Trace: none",
    "",
    heading(2, "Summary"),
    table(
      ["Signal", "Count"],
      [
        ["Forbidden failures", String(report.summary.forbidden)],
        ["Risks", String(report.summary.risks)],
        ["Missing required actions", String(report.summary.requiredMissing)],
        ["Satisfied required actions", String(report.summary.requiredSatisfied)]
      ]
    ),
    "",
    heading(2, "Changed Files"),
    bullet(report.changedFiles.map(code)),
    "",
    heading(2, "Generated Context Changes"),
    bullet(report.generatedContextFiles.map(code)),
    "",
    heading(2, "Verification Plan"),
    bullet(
      report.verification?.commands.map(
        (command) => `${command.command} (${command.scope}, ${command.estimatedCost}, ${command.confidence}) — ${command.reason}`
      ) ?? []
    ),
    "",
    heading(2, "External Context Provenance"),
    bullet(
      (report.contextPolicy?.provenance ?? []).map(
        (item) =>
          `${item.entryId} from ${item.sourceName} (${item.sourceTrustLevel}), revision ${item.contentRevision}, verified=${item.verified ? "yes" : "no"}`
      )
    ),
    "",
    heading(2, "External Context Intervention"),
    bullet([
      ...(report.contextPolicy?.intervention.providedHelp ?? []).map((item) => `Help: ${item}`),
      ...(report.contextPolicy?.intervention.adoptedSuggestions ?? []).map((item) => `Adopted: ${item.summary} Reason: ${item.reason}`),
      ...(report.contextPolicy?.intervention.availableSuggestions ?? []).map((item) => `Available: ${item.summary} Reason: ${item.reason}`),
      ...(report.contextPolicy?.intervention.rejectedSuggestions ?? []).map((item) => `Rejected: ${item.summary} Reason: ${item.reason}`)
    ]),
    "",
    heading(2, "Findings"),
    bullet(report.findings.map(formatPolicyFinding))
  ].join("\n");
}

function policyFindingToResult(finding: PolicyFinding): GuardResult {
  const blocking =
    finding.blocking ?? ((finding.kind === "forbidden" && finding.status === "failed") || (finding.kind === "required" && finding.status === "missing"));
  return createGuardResult({
    id: finding.id,
    source: "policy",
    kind: finding.kind,
    status: finding.status,
    severity: finding.severity,
    message: finding.message,
    file: finding.file,
    blocking,
    confidence: finding.confidence ?? confidenceForPolicyFinding(finding),
    reasons: finding.reasons ?? [finding.message, ...finding.evidence],
    requiredCommands: finding.requiredCommands ?? commandFromRequiredAction(finding.requiredAction),
    artifacts: finding.artifacts ?? [],
    evidence: finding.evidence,
    interventionIds: finding.interventionIds
  });
}

function confidenceForPolicyFinding(finding: PolicyFinding): number {
  if (finding.kind === "forbidden") return 0.95;
  if (finding.kind === "required" && finding.status === "missing") return 0.86;
  if (finding.kind === "risk") return 0.68;
  return 0.6;
}

function commandFromRequiredAction(action: string | undefined): string[] {
  if (!action) return [];
  return /^(opencode-plusplus|opencode-plusplus|opencode-plusplus|npm|pnpm|yarn|bun|npx)\b/.test(action) ? [action] : [];
}

function requiredFinding(
  id: string,
  satisfied: boolean,
  input: {
    message: string;
    evidence: string[];
    requiredAction: string;
  }
): PolicyFinding {
  return {
    id,
    kind: "required",
    status: satisfied ? "satisfied" : "missing",
    severity: satisfied ? "info" : "required",
    message: input.message,
    evidence: input.evidence,
    requiredAction: satisfied ? undefined : input.requiredAction
  };
}

function normalizeFailOn(options: PolicyEngineOptions): PolicyFailOn {
  if (options.failOn) return options.failOn;
  return options.strict ? "risk" : "required";
}

function policyPassed(summary: PolicyEngineReport["summary"], failOn: PolicyFailOn): boolean {
  if (summary.forbidden > 0) return false;
  if ((failOn === "required" || failOn === "risk") && summary.requiredMissing > 0) return false;
  if (failOn === "risk" && summary.risks > 0) return false;
  return true;
}

function changedFilesForPolicy(context: ContextPackage, base: string): { actionable: string[]; generatedContextFiles: string[] } {
  const files = new Set<string>();
  for (const file of changedFilesSince(context.scan.root, base)) files.add(file);

  try {
    for (const line of runGit(context.scan.root, ["status", "--porcelain", "--untracked-files=all"]).split(/\r?\n/)) {
      if (line.length <= 3) continue;
      const file = line.slice(3).trim().replace(/\\/g, "/").split(" -> ").pop();
      if (file) files.add(file);
    }
  } catch {
    // Diff-only policy is still useful in non-git or partially configured repos.
  }

  const generatedContextFiles = [...files].filter(isGeneratedContextState).sort();
  const actionable = [...files]
    .filter((file) => !isGeneratedContextState(file))
    .filter((file) => !file.startsWith(".agent-context/cache/"))
    .sort();
  return { actionable, generatedContextFiles };
}

function isPolicyRelevantFile(file: IndexedFile): boolean {
  return !file.isTest && (file.kind === "source" || file.kind === "config" || file.kind === "lockfile");
}

function isGeneratedContextState(file: string): boolean {
  return file.startsWith(".agent-context/") || file === "AGENTS.md";
}

function isBuildOutputPath(file: string): boolean {
  return /(^|\/)(dist|build|coverage|\.next|out)\//.test(file);
}

function isSensitivePath(file: string): boolean {
  return /(^|\/)(auth|session|security|payment|payments|billing|checkout|invoice|invoices)(\/|\.|-|_)/i.test(file);
}

function isContractGeneratorPath(file: string): boolean {
  return /(^|\/)(contracts|contract-validator|policy-engine|loop-controller)\.ts$/.test(file) || file.startsWith("src/outputs/contracts/");
}

function requiresContractRegeneration(files: string[]): boolean {
  return files.some(isContractGeneratorPath);
}

function policyFindingFromGuardResult(result: GuardResult): PolicyFinding {
  if (result.status === "missing") {
    return {
      id: `policy.required.${result.id}`,
      kind: "required",
      status: "missing",
      severity: "required",
      message: result.message,
      evidence: result.evidence,
      requiredAction: actionFromGuardResult(result)
    };
  }

  if (result.status === "failed") {
    return {
      id: `policy.forbidden.${result.id}`,
      kind: "forbidden",
      status: "failed",
      severity: "error",
      message: result.message,
      evidence: result.evidence,
      requiredAction: actionFromGuardResult(result)
    };
  }

  return {
    id: `policy.risk.${result.id}`,
    kind: "risk",
    status: "warning",
    severity: "warning",
    message: result.message,
    evidence: result.evidence,
    requiredAction: actionFromGuardResult(result)
  };
}

function actionFromGuardResult(result: GuardResult): string | undefined {
  return result.requiredCommands[0] ?? result.reasons[1] ?? result.reasons[0];
}

function formatPolicyFinding(finding: PolicyFinding): string {
  const file = finding.file ? ` ${code(finding.file)}` : "";
  const action = finding.requiredAction ? ` Required: ${code(finding.requiredAction)}.` : "";
  const evidence = finding.evidence.length ? ` Evidence: ${finding.evidence.join("; ")}` : "";
  return `${finding.status.toUpperCase()} ${finding.id}${file} - ${finding.message}.${action}${evidence}`;
}
