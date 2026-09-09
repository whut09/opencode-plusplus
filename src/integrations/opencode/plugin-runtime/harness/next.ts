import { isFinalizeAction } from "./completion.js";
import { createPluginHarnessResult } from "./protocol.js";
import { readPluginEvaluateState, resolvePluginTask, taskRunExists } from "./session.js";
import type { PluginNextArgs, PluginNextResult } from "./types.js";
import { pluginInterventionSnapshot } from "./interventions.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import { updateTaskIdentityForWorkingTree } from "./task-resume.js";
import { updateWorkflowState } from "./workflow.js";

export async function nextPluginHarnessAction(root: string, args: PluginNextArgs = {}): Promise<PluginNextResult | string> {
  const resolved = resolvePluginTask(root, args.taskId, args.sessionId);
  if (!resolved.taskId) return "next needs a taskId or a previous prepare in this repository.";
  if (!taskRunExists(root, resolved.taskId)) return `next could not find a task run for ${resolved.taskId}. Call prepare first.`;
  const latest = readPluginEvaluateState(root, args.sessionId);
  if (!latest || latest.taskId !== resolved.taskId) return `next requires a current evaluate result for ${resolved.taskId}. Call evaluate first.`;

  const finalize = isFinalizeAction(latest.decision, latest.blocking, latest.missingEvidence, latest.requiredCommands);
  const nextAction = finalize ? "finalize" : latest.decision === "ready-for-review" ? "evaluate" : latest.decision;
  if (finalize && resolved.sessionId) {
    const workingTreeHash = currentSidecarWorkingTreeHash(root);
    updateTaskIdentityForWorkingTree(root, resolved.taskId, resolved.sessionId, "completed");
    updateWorkflowState(root, resolved.sessionId, {
      phase: "finalize",
      taskId: resolved.taskId,
      eventKey: `next:finalize:${workingTreeHash}`
    });
  }
  const interventions = pluginInterventionSnapshot(root, resolved.taskId, latest.interventions?.selectedFiles ?? [], latest.interventions?.excludedFiles ?? []);
  return createPluginHarnessResult(root, {
    ok: true,
    tool: "next",
    summary: finalize
      ? `Next for ${resolved.taskId}: finalize is allowed after the current evaluate.`
      : `Next for ${resolved.taskId}: ${nextAction}. Do not claim completion.`,
    taskId: resolved.taskId,
    sessionId: latest.sessionId ?? resolved.sessionId,
    taskIdSource: resolved.source,
    currentPhase: "next",
    decision: latest.decision,
    blocking: latest.blocking,
    findings: latest.findings,
    missingEvidence: latest.missingEvidence,
    requiredCommands: latest.requiredCommands,
    verification: latest.verification,
    mustInspect: latest.mustInspect,
    allowedEditGlobs: latest.allowedEditGlobs,
    avoidEditGlobs: latest.avoidEditGlobs,
    boundaryRevision: latest.boundaryRevision,
    artifacts: latest.artifacts,
    nextAction,
    error: undefined,
    interventions,
    humanReview: latest.humanReview
  });
}
