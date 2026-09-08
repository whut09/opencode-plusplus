import { unique } from "../../../../core/collections.js";
import type { LoopControllerReport } from "../../../../harness/control-plane/loop-controller.js";
import type { PolicyEngineReport } from "../../../../harness/verification-plane/policy-engine.js";
import type { OpenCodeSidecarGuardStackSummary } from "../../sidecar.js";
import { isTestSelectorCommand } from "../../../../core/test-command.js";

export function evaluateFindings(input: { policy: PolicyEngineReport; guardStack: OpenCodeSidecarGuardStackSummary; additionalFindings?: string[] }): string[] {
  return unique([
    ...input.policy.findings
      .filter((finding) => finding.status === "failed" || finding.status === "missing")
      .map((finding) => `${finding.id}: ${finding.message}`),
    ...(input.guardStack.ran ? [] : [`guard-stack: ${input.guardStack.error ?? "failed to run"}`]),
    ...(input.guardStack.contracts && !input.guardStack.contracts.passed ? [`contracts: ${input.guardStack.contracts.violations} violation(s)`] : []),
    ...(input.guardStack.hallucination?.errors ? [`hallucination errors: ${input.guardStack.hallucination.errors}`] : []),
    ...(input.guardStack.regression?.missingRequiredTestEvidence
      ? [`missing regression test evidence: ${input.guardStack.regression.missingRequiredTestEvidence}`]
      : []),
    ...(input.additionalFindings ?? [])
  ]).slice(0, 12);
}

export function evaluateMissingEvidence(input: { loop: LoopControllerReport; policy: PolicyEngineReport }): string[] {
  return unique([
    ...input.loop.runtime.missingEvidence,
    ...input.policy.findings.filter((finding) => finding.status === "missing").map((finding) => `${finding.id}: ${finding.message}`)
  ]);
}

export function evaluateRequiredCommands(input: { loop: LoopControllerReport; policy: PolicyEngineReport }): string[] {
  return unique([
    ...input.loop.decisions.map((decision) => decision.command).filter((command): command is string => Boolean(command)),
    ...input.policy.findings.map((finding) => finding.requiredAction).filter((action): action is string => Boolean(action))
  ]).filter(isExecutableRequiredCommand);
}

function isExecutableRequiredCommand(command: string): boolean {
  if (isTestSelectorCommand(command)) return false;
  return /^(opencode-plusplus|npm|pnpm|yarn|bun|npx|node|python|pytest|go|cargo|dotnet|mvn|mvnw|gradle|gradlew)\b/i.test(command);
}
