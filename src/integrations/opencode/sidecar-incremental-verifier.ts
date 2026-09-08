import path from "node:path";
import { buildApplicationContext } from "../../application/context-service.js";
import { writeTextAtomic } from "../../core/atomic-store.js";
import { buildPolicyReport, renderPolicyReport, type PolicyEngineReport } from "../../harness/verification-plane/policy-engine.js";
import { buildHallucinationReport, renderHallucinationReport, type HallucinationGuardReport } from "../../harness/verification-plane/guards/hallucination.js";
import { buildRegressionReport, renderRegressionReport, type RegressionGuardReport } from "../../harness/verification-plane/guards/regression.js";
import { buildChangeImpactReport, type ChangeImpactReport } from "../../outputs/impact.js";
import { validateContracts, type ContractValidationReport } from "../../outputs/contract-validator.js";
import { buildTestSelection, type TestSelectionReport } from "../../outputs/test-selector.js";
import { renderTaskVerify } from "../../outputs/task-harness.js";
import type { OpenCodeSidecarGuardStackSummary } from "./sidecar.js";
import type { ContextPackage } from "../../core/types.js";
import { buildVerificationPlan } from "../../core/verification/planner.js";

export async function runSidecarIncrementalVerifier(
  root: string,
  input: { base: string; changedFiles: string[]; context?: ContextPackage }
): Promise<OpenCodeSidecarGuardStackSummary> {
  try {
    const context = input.context ?? (await buildApplicationContext(root));
    const contracts = validateContracts(context, { base: input.base, diff: true });
    const hallucination = buildHallucinationReport(context, { base: input.base });
    const regression = buildRegressionReport(context, { base: input.base, changedFiles: input.changedFiles });
    const impact = buildChangeImpactReport(context, { base: input.base });
    const tests = buildTestSelection(context, { diff: true, base: input.base });
    const verification = buildVerificationPlan(context, { changedFiles: input.changedFiles });
    const policy = buildPolicyReport(context, { base: input.base, failOn: "required" });
    writeGuardStackArtifacts(root, {
      policyMarkdown: renderPolicyReport(policy),
      taskVerifyMarkdown: renderTaskVerify(context, { base: input.base, diff: true }),
      hallucinationMarkdown: renderHallucinationReport(hallucination),
      regressionMarkdown: renderRegressionReport(regression)
    });
    return summarizeGuardStack({ base: input.base, contracts, hallucination, regression, impact, tests, verification, policy });
  } catch (error) {
    return { ran: false, passed: false, base: input.base, artifacts: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

export function blockersFromGuardStack(summary: OpenCodeSidecarGuardStackSummary): string[] {
  const blockers: string[] = [];
  if (!summary.ran) return [`Guard stack failed to run: ${summary.error ?? "unknown error"}`];
  if (summary.contracts && !summary.contracts.passed) blockers.push(`Contract violations: ${summary.contracts.violations}`);
  if (summary.hallucination?.errors) blockers.push(`Hallucination errors: ${summary.hallucination.errors}`);
  if (summary.regression?.missingRequiredTestEvidence) blockers.push(`Missing regression test evidence: ${summary.regression.missingRequiredTestEvidence}`);
  if (summary.policy && !summary.policy.passed) {
    if (summary.policy.forbidden) blockers.push(`Policy forbidden failures: ${summary.policy.forbidden}`);
    if (summary.policy.requiredMissing) blockers.push(`Policy required evidence missing: ${summary.policy.requiredMissing}`);
  }
  return blockers;
}

export function warningsFromGuardStack(summary: OpenCodeSidecarGuardStackSummary): string[] {
  const warnings: string[] = [];
  if (summary.hallucination?.warnings) warnings.push(`Hallucination warnings: ${summary.hallucination.warnings}`);
  if (summary.policy?.risks) warnings.push(`Policy risks: ${summary.policy.risks}`);
  if (summary.impact?.risk === "High") warnings.push("Impact risk is High");
  return warnings;
}

function summarizeGuardStack(input: {
  base: string;
  contracts: ContractValidationReport;
  hallucination: HallucinationGuardReport;
  regression: RegressionGuardReport;
  impact: ChangeImpactReport;
  tests: TestSelectionReport;
  verification: ReturnType<typeof buildVerificationPlan>;
  policy: PolicyEngineReport;
}): OpenCodeSidecarGuardStackSummary {
  return {
    ran: true,
    passed:
      input.contracts.passed && input.hallucination.summary.errors === 0 && input.regression.summary.missingRequiredTestEvidence === 0 && input.policy.passed,
    base: input.base,
    artifacts: { policyMarkdown: ".agent-context/sidecar/policy.md", taskVerifyMarkdown: ".agent-context/sidecar/task-verify.md" },
    contracts: { passed: input.contracts.passed, violations: input.contracts.violations.length },
    hallucination: { errors: input.hallucination.summary.errors, warnings: input.hallucination.summary.warnings },
    regression: { matches: input.regression.summary.matches, missingRequiredTestEvidence: input.regression.summary.missingRequiredTestEvidence },
    impact: { risk: input.impact.risk, changedFiles: input.impact.changedFiles.length, relatedTests: input.impact.relatedTests.length },
    tests: {
      minimalCommands: input.tests.minimalCommands.length,
      recommendedCommands: input.tests.recommendedCommands.length,
      fullConfidenceCommands: input.tests.fullConfidenceCommands.length
    },
    verification: {
      classification: input.verification.classification.primaryKind,
      commands: input.verification.commands.length,
      codeTestRequired: input.verification.codeTestRequired,
      verificationRequired: input.verification.verificationRequired
    },
    policy: {
      passed: input.policy.passed,
      forbidden: input.policy.summary.forbidden,
      requiredMissing: input.policy.summary.requiredMissing,
      risks: input.policy.summary.risks
    }
  };
}

function writeGuardStackArtifacts(
  root: string,
  artifacts: { policyMarkdown: string; taskVerifyMarkdown: string; hallucinationMarkdown: string; regressionMarkdown: string }
): void {
  const dir = path.join(root, ".agent-context", "sidecar");
  writeTextAtomic(path.join(dir, "policy.md"), `${artifacts.policyMarkdown}\n`);
  writeTextAtomic(path.join(dir, "task-verify.md"), `${artifacts.taskVerifyMarkdown}\n`);
  writeTextAtomic(path.join(dir, "hallucination.md"), `${artifacts.hallucinationMarkdown}\n`);
  writeTextAtomic(path.join(dir, "regression.md"), `${artifacts.regressionMarkdown}\n`);
}
