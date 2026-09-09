import { readJsonDiagnostic, updateJsonAtomic } from "../../../../core/atomic-store.js";
import type { TaskRunManifest } from "../../../../outputs/task-run.js";
import { createPluginHarnessResult } from "./protocol.js";
import { humanReviewRequestPath, locateHumanReviewRequest, updateHumanReviewRequestAtPath } from "./human-review.js";
import { matchesPathGlob } from "./edit-boundary.js";
import {
  readPluginEvaluateState,
  readPluginHarnessSession,
  resolvePluginTask,
  taskRunExists,
  taskRunManifestPath,
  writePluginEvaluateState,
  writePluginHarnessSession
} from "./session.js";
import type { HumanReviewRequest } from "../../../../harness/types.js";
import type { PluginHumanReviewArgs, PluginHumanReviewResult } from "./types.js";
import { initializeWorkflowState, readWorkflowState, resumeWorkflowState, updateWorkflowState } from "./workflow.js";
import { pluginInterventionSnapshot } from "./interventions.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import { readTaskIdentity, updateTaskIdentity, upsertTaskIdentityForState } from "./task-resume.js";
import path from "node:path";

export async function reviewPluginHarnessTask(root: string, args: PluginHumanReviewArgs): Promise<PluginHumanReviewResult | string> {
  const resolved = resolvePluginTask(root, args.taskId, args.sessionId);
  if (!resolved.taskId) return `human review needs a taskId or a prepared Desktop session.`;
  if (!taskRunExists(root, resolved.taskId)) return `human review could not find a task run for ${resolved.taskId}.`;

  const sessionId = resolved.sessionId;
  const located = locateHumanReviewRequest(root, resolved.taskId, sessionId, args.requestId);
  const request = located?.request;
  if (!request)
    return reviewFailure(root, resolved.taskId, sessionId, "HUMAN_REVIEW_NOT_FOUND", "No pending OpenCode++ human review request exists for this task.");
  if (args.requestId && args.requestId !== request.requestId) {
    return reviewFailure(
      root,
      resolved.taskId,
      sessionId,
      "HUMAN_REVIEW_REQUEST_MISMATCH",
      "The supplied human review request is not the current persisted request.",
      request
    );
  }
  if (request.status !== "pending") {
    return reviewFailure(root, resolved.taskId, sessionId, "HUMAN_REVIEW_ALREADY_RESOLVED", `The human review request is already ${request.status}.`, request);
  }

  if (args.action === "reject") {
    const rejected = updateHumanReviewRequestAtPath(located!.filePath, request.requestId, {
      status: "rejected",
      explanation: `${request.explanation} The requested continuation was declined by the user.`,
      requiredUserAction: "Choose a different in-boundary implementation or create a new task with an explicitly approved scope.",
      resumeCondition: "This task remains paused until a new task boundary or implementation decision is supplied.",
      now: new Date().toISOString()
    });
    updateTaskIdentityIfPresent(root, resolved.taskId, request.sessionId, "abandoned");
    updateTaskIdentityIfPresent(root, resolved.taskId, sessionId, "abandoned");
    return reviewResult(
      root,
      resolved.taskId,
      sessionId,
      resolved.source,
      rejected,
      "The requested scope expansion was declined; the task remains paused.",
      true,
      "human-review",
      {},
      located!.filePath
    );
  }

  if (request.reasonCode !== "BOUNDARY_EXPANSION_REQUIRED") {
    return reviewFailure(
      root,
      resolved.taskId,
      sessionId,
      "HUMAN_REVIEW_ACTION_NOT_ALLOWED",
      `Approval is only available for a boundary expansion request. This request is ${request.reasonCode}.`,
      request
    );
  }

  const manifestResult = readJsonDiagnostic<TaskRunManifest>(taskRunManifestPath(root, resolved.taskId));
  if (manifestResult.status !== "ok") {
    return reviewFailure(
      root,
      resolved.taskId,
      sessionId,
      "HUMAN_REVIEW_STATE_UNAVAILABLE",
      "The task manifest is unavailable, so the boundary cannot be revised safely.",
      request
    );
  }
  const manifest = manifestResult.value;
  const targetSessionId = sessionId ?? request.sessionId;
  const sourceIdentity = request.sessionId ? readTaskIdentity(root, resolved.taskId, request.sessionId) : undefined;
  const requested = [...new Set([...(request.requestedBoundary ?? []), ...request.affectedFiles])].sort((left, right) => left.localeCompare(right));
  const avoided = requested.filter((file) => (manifest.avoidEditGlobs ?? []).some((glob) => matchesPathGlob(file, glob)));
  if (avoided.length) {
    return reviewFailure(
      root,
      resolved.taskId,
      sessionId,
      "HUMAN_REVIEW_PROTECTED_PATH",
      `The requested expansion includes protected paths: ${avoided.join(", ")}. OpenCode++ will not approve those paths through scope expansion.`,
      request
    );
  }

  if (targetSessionId && request.sessionId && targetSessionId !== request.sessionId) {
    const targetSession = readPluginHarnessSession(root, targetSessionId);
    if (targetSession && targetSession.taskId !== resolved.taskId) {
      return reviewFailure(root, resolved.taskId, targetSessionId, "HUMAN_REVIEW_SESSION_CONFLICT", `Session ${targetSessionId} is already associated with task ${targetSession.taskId}.`, request);
    }
    if (sourceIdentity) resumeWorkflowState(root, request.sessionId, targetSessionId, sourceIdentity);
    else initializeWorkflowState(root, targetSessionId);
    writePluginHarnessSession(root, {
      taskId: resolved.taskId,
      task: manifest.task,
      type: manifest.type,
      sessionId: targetSessionId,
      updatedAt: new Date().toISOString()
    });
    if (sourceIdentity) updateTaskIdentity(root, resolved.taskId, request.sessionId, { status: "abandoned", resumedToSessionId: targetSessionId });
  }

  const nextRevision = Math.max(manifest.boundaryRevision ?? request.boundaryRevision ?? 1, request.boundaryRevision ?? 1) + 1;
  const allowedEditGlobs = [...new Set([...(manifest.allowedEditGlobs ?? []), ...requested])].sort((left, right) => left.localeCompare(right));
  const nextManifest = updateJsonAtomic<TaskRunManifest>(taskRunManifestPath(root, resolved.taskId), (current) => {
    if (!current) throw new Error(`Task manifest disappeared for ${resolved.taskId}.`);
    return { ...current, allowedEditGlobs, boundaryRevision: nextRevision };
  });

  if (targetSessionId) {
    const workflow = readWorkflowState(root, targetSessionId) ?? initializeWorkflowState(root, targetSessionId);
    if (workflow) {
      updateWorkflowState(root, targetSessionId, {
        phase: "editing",
        taskId: resolved.taskId,
        editBoundary: { allowedEditGlobs, avoidEditGlobs: nextManifest.avoidEditGlobs ?? [] },
        boundaryRevision: nextRevision,
        eventKey: `human-review-approved:${request.requestId}:${nextRevision}`
      });
    }
  }

  const resumed = updateHumanReviewRequestAtPath(located!.filePath, request.requestId, {
    status: "resumed",
    explanation: `${request.explanation} The user approved the requested task scope expansion.`,
    requiredUserAction: "No further boundary action is required; continue the current task and run evaluate after the edit or verification step.",
    resumeCondition: "The expanded boundary is active at the new revision; call opencode_plusplus_evaluate to continue without prepare.",
    boundaryRevision: nextRevision,
    now: new Date().toISOString()
  });
  if (targetSessionId) {
    upsertTaskIdentityForState(root, {
      taskId: resolved.taskId,
      sessionId: targetSessionId,
      baseWorkingTreeFingerprint: sourceIdentity?.baseWorkingTreeFingerprint ?? currentSidecarWorkingTreeHash(root),
      latestWorkingTreeFingerprint: currentSidecarWorkingTreeHash(root),
      status: "dirty"
    });
  }
  return reviewResult(
    root,
    resolved.taskId,
    targetSessionId,
    resolved.source,
    resumed,
    "Scope expansion approved; the existing task state was resumed without prepare.",
    false,
    "evaluate",
    {
      allowedEditGlobs,
      avoidEditGlobs: nextManifest.avoidEditGlobs ?? [],
      boundaryRevision: nextRevision
    },
    located!.filePath
  );

}

function reviewResult(
  root: string,
  taskId: string,
  sessionId: string | null,
  taskIdSource: "argument" | "session" | "created" | "none",
  humanReview: HumanReviewRequest,
  summary: string,
  blocking: boolean,
  nextAction: string,
  boundary: { allowedEditGlobs?: string[]; avoidEditGlobs?: string[]; boundaryRevision?: number } = {},
  requestPath = humanReviewRequestPath(root, taskId, sessionId)
): PluginHumanReviewResult {
  const latest = readPluginEvaluateState(root, sessionId) ?? readPluginEvaluateState(root, humanReview.sessionId);
  const allowedEditGlobs = boundary.allowedEditGlobs ?? latest?.allowedEditGlobs ?? [];
  const avoidEditGlobs = boundary.avoidEditGlobs ?? latest?.avoidEditGlobs ?? [];
  const boundaryRevision = boundary.boundaryRevision ?? latest?.boundaryRevision ?? humanReview.boundaryRevision ?? 1;
  const interventions = latest?.interventions ?? pluginInterventionSnapshot(root, taskId, [], []);
  const result = createPluginHarnessResult(root, {
    ok: true,
    tool: "human-review",
    summary,
    taskId,
    sessionId,
    taskIdSource,
    currentPhase: "human-review",
    decision: blocking ? "human-review" : "ready-for-review",
    blocking,
    findings: blocking ? [humanReview.explanation] : [`Human review ${humanReview.status}; boundary revision ${boundaryRevision} is active.`],
    missingEvidence: latest?.missingEvidence ?? [],
    requiredCommands: latest?.requiredCommands ?? [],
    mustInspect: latest?.mustInspect ?? [],
    allowedEditGlobs,
    avoidEditGlobs,
    boundaryRevision,
    artifacts: [".agent-context/sidecar/plugin-evaluate.json", path.relative(root, requestPath).replaceAll("\\", "/")],
    nextAction,
    interventions,
    humanReview,
    verification: latest?.verification
  });
  writePluginEvaluateState(root, {
    schemaVersion: result.schemaVersion,
    taskId,
    sessionId,
    taskIdSource,
    workingTreeHash: currentSidecarWorkingTreeHash(root),
    currentPhase: result.currentPhase,
    decision: result.decision,
    blocking: result.blocking,
    findings: result.findings,
    missingEvidence: result.missingEvidence,
    requiredCommands: result.requiredCommands,
    mustInspect: result.mustInspect,
    allowedEditGlobs: result.allowedEditGlobs,
    avoidEditGlobs: result.avoidEditGlobs,
    boundaryRevision,
    artifacts: result.artifacts,
    nextAction,
    summary: result.summary,
    interventions: result.interventions,
    humanReview: result.humanReview,
    verification: result.verification,
    updatedAt: new Date().toISOString()
  });
  return result;
}

function updateTaskIdentityIfPresent(
  root: string,
  taskId: string,
  sessionId: string | null,
  status: "abandoned"
): void {
  if (!sessionId) return;
  updateTaskIdentity(root, taskId, sessionId, { status });
}

function reviewFailure(
  root: string,
  taskId: string,
  sessionId: string | null,
  code: string,
  message: string,
  humanReview?: HumanReviewRequest
): PluginHumanReviewResult {
  return createPluginHarnessResult(root, {
    ok: false,
    tool: "human-review",
    summary: `OpenCode++ human review could not continue: ${message}`,
    error: {
      code,
      message,
      attribution: "opencode-plusplus",
      retryable: false,
      nextStep: "Inspect the persisted human review request and select a valid user action."
    },
    taskId,
    sessionId,
    taskIdSource: "argument",
    currentPhase: "human-review",
    decision: "human-review",
    blocking: true,
    findings: [message],
    nextAction: "human-review",
    humanReview
  });
}
