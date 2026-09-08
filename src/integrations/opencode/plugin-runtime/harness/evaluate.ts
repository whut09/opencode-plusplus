import path from "node:path";
import { buildLoopControllerReport } from "../../../../harness/control-plane/loop-controller.js";
import { buildPolicyReport } from "../../../../harness/verification-plane/policy-engine.js";
import { resolveGitBase } from "../../../../core/git.js";
import { readJsonDiagnostic } from "../../../../core/atomic-store.js";
import type { TaskRunManifest } from "../../../../outputs/task-run.js";
import { traceIdForOpenCodeSession } from "../../sidecar-evidence-recorder.js";
import { runSidecarIncrementalVerifier } from "../../sidecar-incremental-verifier.js";
import { loadPluginHarnessContext } from "./context.js";
import { evaluateFindings, evaluateMissingEvidence, evaluateRequiredCommands } from "./findings.js";
import { createPluginHarnessResult } from "./protocol.js";
import { resolvePluginTask, taskRunExists, taskRunManifestPath, writePluginEvaluateState } from "./session.js";
import type { PluginEvaluateArgs, PluginEvaluateResult } from "./types.js";
import { readWorkflowState, updateWorkflowState } from "./workflow.js";
import { createPluginHarnessError } from "./protocol.js";
import { cacheStatusForStats, contextModeForStats, pluginPerformance, runPluginStage } from "./performance.js";
import { pluginInterventionSnapshot, recordPluginEvaluationInterventions } from "./interventions.js";
import { readExecutionTrace } from "../../../../harness/observability/execution-trace.js";
import { blockersFromGuardStack } from "../../sidecar-incremental-verifier.js";
import { PLUGIN_STAGE_TARGETS } from "./performance.js";
import { assessPluginEditBoundary } from "./edit-boundary.js";
import { classifyHumanReviewReason, humanReviewRequestPath, upsertHumanReviewRequest } from "./human-review.js";

const evaluations = new Map<string, Promise<PluginEvaluateResult | string>>();

export async function evaluatePluginHarness(root: string, args: PluginEvaluateArgs = {}): Promise<PluginEvaluateResult | string> {
  const evaluationKey = `${root}\0${args.sessionId ?? ""}\0${args.taskId ?? ""}`;
  let evaluation = evaluations.get(evaluationKey);
  if (!evaluation) {
    evaluation = evaluatePluginHarnessInternal(root, args);
    evaluations.set(evaluationKey, evaluation);
    void evaluation.then(
      () => evaluations.delete(evaluationKey),
      () => evaluations.delete(evaluationKey)
    );
  }
  const activeEvaluation = evaluation;
  const staged = await runPluginStage("evaluate", () => activeEvaluation);
  if (staged.status === "timeout") {
    const targetMs = PLUGIN_STAGE_TARGETS.evaluate;
    const message = `evaluate exceeded the ${targetMs}ms Desktop target. Do not retry, sleep, or poll in this turn; stop at human-review and inspect .agent-context/sidecar plus OpenCode logs.`;
    return createPluginHarnessError(
      root,
      "evaluate",
      message,
      args.taskId ?? null,
      args.sessionId ?? null,
      args.taskId ? "argument" : "none",
      pluginPerformance("evaluate", staged, "miss", "rebuilt", [], []),
      {
        code: "PLUGIN_EVALUATION_TIMEOUT",
        message,
        attribution: "opencode-plusplus",
        retryable: false,
        nextStep: "Stop this turn at human-review. Do not use Start-Sleep, sleep, or a polling loop."
      }
    );
  }
  const result = staged.value!;
  if (typeof result === "string") return result;
  return {
    ...result,
    performance: pluginPerformance(
      "evaluate",
      staged,
      result.performance?.cache ?? "miss",
      result.performance?.contextMode ?? "rebuilt",
      result.performance?.selectedFiles ?? [],
      result.performance?.rejectedFiles ?? []
    )
  };
}

async function evaluatePluginHarnessInternal(root: string, args: PluginEvaluateArgs = {}): Promise<PluginEvaluateResult | string> {
  const resolved = resolvePluginTask(root, args.taskId, args.sessionId);
  if (!resolved.taskId) return "evaluate needs a taskId or a previous prepare in this repository.";
  if (!taskRunExists(root, resolved.taskId)) return `evaluate could not find a task run for ${resolved.taskId}. Call prepare first.`;

  const workflow = resolved.sessionId ? readWorkflowState(root, resolved.sessionId) : undefined;
  if (resolved.source === "none" || (workflow && !workflow.taskId)) return "evaluate requires prepare before evaluating source changes.";
  const manifestResult = readJsonDiagnostic<TaskRunManifest>(taskRunManifestPath(root, resolved.taskId));
  const manifest = manifestResult.status === "ok" && manifestResult.value.id === resolved.taskId ? manifestResult.value : undefined;
  const boundary = {
    allowedEditGlobs: workflow?.editBoundary.allowedEditGlobs ?? manifest?.allowedEditGlobs ?? [],
    avoidEditGlobs: workflow?.editBoundary.avoidEditGlobs ?? manifest?.avoidEditGlobs ?? [],
    revision: workflow?.boundaryRevision ?? manifest?.boundaryRevision ?? 1
  };
  const context = await loadPluginHarnessContext(root);
  const task = resolved.task ?? resolved.taskId;
  const base = resolveGitBase(root);
  const guardStack = await runSidecarIncrementalVerifier(root, { base, changedFiles: [], context });
  const traceId = traceIdForOpenCodeSession(resolved.sessionId);
  const policy = buildPolicyReport(context, { base, traceId, failOn: "required", contextTaskId: resolved.taskId });
  const loop = buildLoopControllerReport(context, task, { phase: "after-edit", base, traceId });
  const trace = readExecutionTrace(root, traceId);
  const decision = loop.decisions[0]?.action ?? "ready-for-review";
  const requiredCommands = evaluateRequiredCommands({ loop, policy });
  const boundaryAssessment = assessPluginEditBoundary(policy.changedFiles, boundary);
  const noExecutableTest =
    policy.verification?.codeTestRequired === true &&
    policy.findings.some((finding) => finding.id === "policy.required.tests" && finding.status === "missing") &&
    !requiredCommands.some((command) => /^(npm|pnpm|yarn|bun|node|python|pytest|go|cargo|dotnet|mvn|gradle)\b/i.test(command));
  const reviewReason = classifyHumanReviewReason({
    boundaryExpansion: boundaryAssessment.expansionRequired,
    noExecutableTest,
    ambiguousRepositoryState: !guardStack.ran
  });
  const shouldCreateHumanReview = boundaryAssessment.expansionRequired || noExecutableTest || !guardStack.ran || decision === "human-review";
  const humanReview = shouldCreateHumanReview
    ? upsertHumanReviewRequest(root, {
        taskId: resolved.taskId,
        sessionId: resolved.sessionId,
        reasonCode: reviewReason,
        explanation: reviewExplanation({
          reasonCode: reviewReason,
          decision,
          boundaryAssessment,
          findings: [...policy.findings.filter((finding) => finding.status === "failed" || finding.status === "missing").map((finding) => finding.message), ...loop.runtime.missingEvidence],
          guardError: guardStack.error
        }),
        affectedFiles: boundaryAssessment.expansionRequired ? boundaryAssessment.outsideAllowed : policy.changedFiles,
        suggestedCommands: requiredCommands,
        currentBoundary: boundaryAssessment.allowedEditGlobs,
        requestedBoundary: boundaryAssessment.outsideAllowed,
        boundaryRevision: boundaryAssessment.boundaryRevision
      })
    : undefined;
  const effectiveDecision = humanReview ? "human-review" : decision;
  const findings = evaluateFindings({
    policy,
    guardStack,
    additionalFindings: boundaryAssessment.expansionRequired
      ? [`Task boundary expansion required for: ${boundaryAssessment.outsideAllowed.join(", ")}`]
      : []
  });
  const missingEvidence = evaluateMissingEvidence({ loop, policy });
  const blocking = Boolean(loop.decisions[0]?.blocking) || !policy.passed || !guardStack.passed || Boolean(humanReview);
  recordPluginEvaluationInterventions({
    root,
    taskId: resolved.taskId,
    sessionId: resolved.sessionId,
    policy,
    guardStack,
    blockers: blockersFromGuardStack(guardStack),
    decision: effectiveDecision,
    trace,
    changedFiles: policy.changedFiles
  });
  const interventions = pluginInterventionSnapshot(root, resolved.taskId, policy.changedFiles, []);
  const result = createPluginHarnessResult(root, {
    ok: true,
    tool: "evaluate",
    summary: humanReview
      ? `Evaluate ${resolved.taskId}: human review is required (${humanReview.reasonCode}).`
      : `Evaluate ${resolved.taskId}: ${blocking ? "blocking" : "ready for next decision"}.`,
    taskId: resolved.taskId,
    sessionId: resolved.sessionId,
    taskIdSource: resolved.source,
    currentPhase: "evaluate",
    decision: effectiveDecision,
    blocking,
    findings,
    missingEvidence,
    requiredCommands,
    verification: policy.verification ?? loop.verification,
    nextAction: humanReview ? "human-review" : "next",
    mustInspect: manifest?.mustInspect ?? [],
    allowedEditGlobs: boundaryAssessment.allowedEditGlobs,
    avoidEditGlobs: boundaryAssessment.avoidEditGlobs,
    boundaryRevision: boundaryAssessment.boundaryRevision,
    artifacts: [
      ".agent-context/sidecar/plugin-evaluate.json",
      ".agent-context/sidecar/latest.json",
      ...(humanReview ? [path.relative(root, humanReviewRequestPath(root, resolved.taskId, resolved.sessionId)).replaceAll("\\", "/")] : [])
    ],
    interventions,
    ...(humanReview ? { humanReview } : {}),
    performance: pluginPerformance(
      "evaluate",
      { status: "completed", durationMs: 0 },
      cacheStatusForStats(context.cacheStats),
      contextModeForStats(context.cacheStats),
      [],
      []
    )
  });
  if (resolved.sessionId)
    updateWorkflowState(root, resolved.sessionId, {
      phase: humanReview ? "blocked" : "evaluated",
      taskId: resolved.taskId,
      editBoundary: { allowedEditGlobs: boundaryAssessment.allowedEditGlobs, avoidEditGlobs: boundaryAssessment.avoidEditGlobs },
      boundaryRevision: boundaryAssessment.boundaryRevision,
      eventKey: `evaluate:${result.workingTreeHash}:${result.decision}`
    });
  writePluginEvaluateState(root, {
    schemaVersion: result.schemaVersion,
    taskId: resolved.taskId,
    sessionId: result.sessionId,
    taskIdSource: result.taskIdSource,
    workingTreeHash: result.workingTreeHash,
    currentPhase: result.currentPhase,
    decision: result.decision,
    blocking: result.blocking,
    findings: result.findings,
    missingEvidence: result.missingEvidence,
    requiredCommands: result.requiredCommands,
    mustInspect: result.mustInspect,
    allowedEditGlobs: result.allowedEditGlobs,
    avoidEditGlobs: result.avoidEditGlobs,
    boundaryRevision: result.boundaryRevision,
    artifacts: result.artifacts,
    nextAction: result.nextAction,
    summary: result.summary,
    interventions: result.interventions,
    humanReview: result.humanReview,
    verification: result.verification,
    updatedAt: new Date().toISOString()
  });
  return result;
}

function reviewExplanation(input: {
  reasonCode: ReturnType<typeof classifyHumanReviewReason>;
  decision: string;
  boundaryAssessment: ReturnType<typeof assessPluginEditBoundary>;
  findings: string[];
  guardError?: string;
}): string {
  if (input.reasonCode === "BOUNDARY_EXPANSION_REQUIRED") {
    return `The current task boundary does not include ${input.boundaryAssessment.outsideAllowed.join(", ")}. The requested files are outside the prepared edit surface, but they are not classified as protected paths.`;
  }
  if (input.reasonCode === "NO_EXECUTABLE_TEST") return "Source or configuration changes require test evidence, but no executable repository test command is available for this task.";
  if (input.reasonCode === "AMBIGUOUS_REPOSITORY_STATE") return `The OpenCode++ guard stack could not establish a reliable repository state: ${input.guardError ?? "guard evaluation failed"}.`;
  return input.findings[0] ?? `The current decision is ${input.decision}, and OpenCode++ cannot prove a safe automatic continuation.`;
}
