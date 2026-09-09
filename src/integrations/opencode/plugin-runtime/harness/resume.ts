import path from "node:path";
import { readJsonDiagnostic } from "../../../../core/atomic-store.js";
import type { TaskRunManifest } from "../../../../outputs/task-run.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import { createPluginHarnessError, createPluginHarnessResult } from "./protocol.js";
import { preparePluginHarnessTask } from "./prepare.js";
import { locateHumanReviewRequest } from "./human-review.js";
import { pluginInterventionSnapshot } from "./interventions.js";
import {
  synchronizeTaskResumeCandidates,
  updateTaskIdentity,
  upsertTaskIdentityForState,
  type TaskResumeDiscoveryResult
} from "./task-resume.js";
import { readPluginHarnessSession, taskRunManifestPath, writePluginHarnessSession } from "./session.js";
import type { PluginResumeArgs, PluginResumeState, PluginResumeResult, TaskResumeCandidate } from "./types.js";
import { refreshWorkflowResumeCandidates, resumeWorkflowState } from "./workflow.js";

export async function resumePluginHarnessTask(root: string, args: PluginResumeArgs): Promise<PluginResumeResult> {
  const currentSessionId = args.sessionId?.trim() || undefined;
  const discovery = synchronizeTaskResumeCandidates(root, { currentSessionId });
  if (args.action === "inspect") return buildInspectionResult(root, args, discovery);
  if (!currentSessionId) {
    return createPluginHarnessError(
      root,
      "resume",
      "resume requires the current OpenCode session id so recovered state cannot leak across sessions.",
      null,
      null,
      "none",
      undefined,
      {
        code: "RESUME_SESSION_REQUIRED",
        message: "A current session id is required for explicit task recovery.",
        attribution: "opencode-plusplus",
        retryable: false,
        nextStep: "Call resume from the active OpenCode++ Desktop session with confirmed=true."
      }
    );
  }

  const candidate = selectCandidate(discovery.candidates, args);
  if (!candidate) {
    return createPluginHarnessError(
      root,
      "resume",
      "No compatible unfinished task was selected for recovery.",
      args.taskId ?? null,
      currentSessionId,
      args.taskId ? "argument" : "none",
      undefined,
      {
        code: "RESUME_CANDIDATE_NOT_FOUND",
        message: "No compatible unfinished task was selected for recovery.",
        attribution: "opencode-plusplus",
        retryable: false,
        nextStep: "Call resume with action inspect, then select a resume-verification candidate or rebuild a stale task explicitly."
      }
    );
  }
  if (candidate.compatibility === "mismatched-repository") {
    return createPluginHarnessError(
      root,
      "resume",
      candidate.reason,
      candidate.identity.taskId,
      currentSessionId,
      "argument",
      undefined,
      {
        code: "RESUME_REPOSITORY_MISMATCH",
        message: candidate.reason,
        attribution: "opencode-plusplus",
        retryable: false,
        nextStep: "Open the repository that owns this task or start a new task here."
      }
    );
  }
  if (candidate.identity.status === "human-review") return buildHumanReviewResumeResult(root, args, discovery, candidate);
  if (candidate.compatibility === "stale-task") return resumeStaleTask(root, args, discovery, candidate);
  return resumeCompatibleTask(root, args, discovery, candidate);
}

function buildInspectionResult(root: string, args: PluginResumeArgs, discovery: TaskResumeDiscoveryResult): PluginResumeResult {
  const resume = buildResumeState(discovery.candidates);
  const selected = discovery.candidates.find((candidate) => candidate.compatibility === "resume-verification");
  return createPluginHarnessResult(root, {
    ok: true,
    tool: "resume",
    summary: resume.message,
    taskId: selected?.identity.taskId ?? null,
    sessionId: args.sessionId ?? null,
    taskIdSource: selected ? "argument" : "none",
    currentPhase: "resume",
    decision: resume.status === "available" ? "resume-verification" : resume.status,
    blocking: resume.status !== "available",
    findings: discovery.issues.map((issue) => `${issue.path}: ${issue.message}`),
    missingEvidence: [],
    requiredCommands: [],
    mustInspect: [],
    allowedEditGlobs: [],
    avoidEditGlobs: [],
    artifacts: [".agent-context/sidecar"],
    nextAction: resume.status === "available" || resume.status === "stale-task" ? "resume" : "human-review",
    resume
  });
}

function resumeCompatibleTask(
  root: string,
  args: PluginResumeArgs,
  discovery: TaskResumeDiscoveryResult,
  candidate: TaskResumeCandidate
): PluginResumeResult {
  const sourceSessionId = candidate.identity.sessionId;
  const targetSessionId = args.sessionId!;
  const manifest = readManifest(root, candidate.identity.taskId);
  if (!manifest) return resumeFailure(root, candidate, targetSessionId, "RESUME_MANIFEST_UNAVAILABLE", "The persisted task manifest is unavailable.");
  if (sourceSessionId === targetSessionId) return resumeFailure(root, candidate, targetSessionId, "RESUME_SESSION_COLLISION", "A task cannot be resumed into its source session.");
  const existingTargetSession = readPluginHarnessSession(root, targetSessionId);
  if (existingTargetSession && existingTargetSession.taskId !== candidate.identity.taskId) {
    return resumeFailure(root, candidate, targetSessionId, "RESUME_SESSION_CONFLICT", `Session ${targetSessionId} is already associated with task ${existingTargetSession.taskId}.`);
  }

  const sourceSession = readPluginHarnessSession(root, sourceSessionId);
  writePluginHarnessSession(root, {
    taskId: candidate.identity.taskId,
    task: sourceSession?.task ?? manifest.task,
    type: sourceSession?.type ?? manifest.type,
    sessionId: targetSessionId,
    updatedAt: new Date().toISOString()
  });
  resumeWorkflowState(root, sourceSessionId, targetSessionId, candidate.identity);
  updateTaskIdentity(root, candidate.identity.taskId, sourceSessionId, {
    status: "abandoned",
    resumedToSessionId: targetSessionId
  });
  upsertTaskIdentityForState(root, {
    taskId: candidate.identity.taskId,
    sessionId: targetSessionId,
    baseWorkingTreeFingerprint: candidate.identity.baseWorkingTreeFingerprint,
    latestWorkingTreeFingerprint: discovery.currentWorkingTreeFingerprint,
    status: "verification-required"
  });
  refreshWorkflowResumeCandidates(root, targetSessionId);
  const resume: PluginResumeState = {
    status: "resumed",
    candidates: discovery.candidates,
    selectedTaskId: candidate.identity.taskId,
    sourceSessionId,
    message: `Resumed ${candidate.identity.taskId} into session ${targetSessionId}. The compatible working tree was preserved; run verification before finalizing.`
  };
  return createTaskResumeResult(root, manifest, targetSessionId, resume, "The task state was resumed without prepare; current verification is required.");
}

async function resumeStaleTask(
  root: string,
  args: PluginResumeArgs,
  discovery: TaskResumeDiscoveryResult,
  candidate: TaskResumeCandidate
): Promise<PluginResumeResult> {
  const targetSessionId = args.sessionId!;
  const manifest = readManifest(root, candidate.identity.taskId);
  if (!manifest) return resumeFailure(root, candidate, targetSessionId, "RESUME_MANIFEST_UNAVAILABLE", "The stale task manifest is unavailable for rebuilding.");
  const resume: PluginResumeState = {
    status: "stale-task",
    candidates: discovery.candidates,
    selectedTaskId: candidate.identity.taskId,
    sourceSessionId: candidate.identity.sessionId,
    message: `Task ${candidate.identity.taskId} was stale because the working tree changed. Context and the validation plan were rebuilt for the new session.`
  };
  if (candidate.identity.sessionId === targetSessionId) return resumeFailure(root, candidate, targetSessionId, "RESUME_SESSION_COLLISION", "A task cannot be rebuilt into its source session.");
  const existingTargetSession = readPluginHarnessSession(root, targetSessionId);
  if (existingTargetSession && existingTargetSession.taskId !== candidate.identity.taskId) {
    return resumeFailure(root, candidate, targetSessionId, "RESUME_SESSION_CONFLICT", `Session ${targetSessionId} is already associated with task ${existingTargetSession.taskId}.`);
  }
  const sourceSession = readPluginHarnessSession(root, candidate.identity.sessionId);
  const prepared = await preparePluginHarnessTask(root, {
    task: sourceSession?.task ?? manifest.task,
    type: sourceSession?.type === "auto" ? undefined : sourceSession?.type ?? manifest.type,
    sessionId: targetSessionId,
    forceRebuild: true
  });
  updateTaskIdentity(root, candidate.identity.taskId, candidate.identity.sessionId, {
    status: "abandoned",
    resumedToSessionId: targetSessionId
  });
  refreshWorkflowResumeCandidates(root, targetSessionId);
  return {
    ...prepared,
    tool: "resume",
    summary: `${resume.message} The existing task was not restarted; its persisted task id was retained.`,
    resume
  };
}

function buildHumanReviewResumeResult(
  root: string,
  args: PluginResumeArgs,
  discovery: TaskResumeDiscoveryResult,
  candidate: TaskResumeCandidate
): PluginResumeResult {
  const humanReview = locateHumanReviewRequest(root, candidate.identity.taskId, candidate.identity.sessionId)?.request;
  const resume: PluginResumeState = {
    status: "human-review",
    candidates: discovery.candidates,
    selectedTaskId: candidate.identity.taskId,
    sourceSessionId: candidate.identity.sessionId,
    message: `Task ${candidate.identity.taskId} is waiting for human review in session ${candidate.identity.sessionId}; recovery will not bypass that decision.`
  };
  return createPluginHarnessResult(root, {
    ok: true,
    tool: "resume",
    summary: resume.message,
    taskId: candidate.identity.taskId,
    sessionId: args.sessionId ?? null,
    taskIdSource: "argument",
    currentPhase: "resume",
    decision: "human-review",
    blocking: true,
    findings: [candidate.reason],
    missingEvidence: [],
    requiredCommands: [],
    mustInspect: [],
    allowedEditGlobs: [],
    avoidEditGlobs: [],
    artifacts: [".agent-context/sidecar"],
    nextAction: "human-review",
    resume,
    ...(humanReview ? { humanReview } : {})
  });
}

function createTaskResumeResult(
  root: string,
  manifest: TaskRunManifest,
  sessionId: string,
  resume: PluginResumeState,
  summary: string,
  options: { stale?: boolean } = {}
): PluginResumeResult {
  const selectedFiles = manifest.mustInspect;
  return createPluginHarnessResult(root, {
    ok: true,
    tool: "resume",
    summary,
    taskId: manifest.id,
    sessionId,
    taskIdSource: "argument",
    currentPhase: "resume",
    decision: options.stale ? "repack" : "resume-verification",
    blocking: true,
    findings: [options.stale ? "The persisted task is stale and requires a rebuilt context and validation plan." : "Resume is not completion evidence; current verification is required."],
    missingEvidence: manifest.requiredCommands.length ? ["Current-session verification evidence"] : [],
    requiredCommands: manifest.requiredCommands,
    verification: manifest.verification,
    mustInspect: selectedFiles,
    allowedEditGlobs: manifest.allowedEditGlobs,
    avoidEditGlobs: manifest.avoidEditGlobs,
    boundaryRevision: manifest.boundaryRevision ?? 1,
    artifacts: [
      ...manifest.files,
      path.relative(root, taskRunManifestPath(root, manifest.id)).replaceAll("\\", "/")
    ],
    nextAction: options.stale ? "prepare" : "evaluate",
    interventions: pluginInterventionSnapshot(root, manifest.id, selectedFiles, []),
    resume
  });
}

function resumeFailure(root: string, candidate: TaskResumeCandidate, sessionId: string, code: string, message: string): PluginResumeResult {
  return createPluginHarnessError(root, "resume", message, candidate.identity.taskId, sessionId, "argument", undefined, {
    code,
    message,
    attribution: "opencode-plusplus",
    retryable: false,
    nextStep: "Call resume with action inspect and review the persisted candidate diagnostics."
  });
}

function buildResumeState(candidates: TaskResumeCandidate[]): PluginResumeState {
  const compatible = candidates.find((candidate) => candidate.compatibility === "resume-verification" && candidate.identity.status !== "human-review");
  if (compatible) {
    return {
      status: "available",
      candidates,
      selectedTaskId: compatible.identity.taskId,
      sourceSessionId: compatible.identity.sessionId,
      message: `A compatible unfinished task is available: ${compatible.identity.taskId}. Explicit confirmation is required before recovery.`
    };
  }
  const humanReview = candidates.find((candidate) => candidate.identity.status === "human-review");
  if (humanReview) return { status: "human-review", candidates, selectedTaskId: humanReview.identity.taskId, sourceSessionId: humanReview.identity.sessionId, message: humanReview.reason };
  if (candidates.some((candidate) => candidate.compatibility === "stale-task")) {
    return { status: "stale-task", candidates, message: "Unfinished tasks were found, but their working tree fingerprints are stale; explicit rebuild is required." };
  }
  return { status: "none", candidates, message: "No unfinished task is eligible for recovery in this repository." };
}

function selectCandidate(candidates: TaskResumeCandidate[], args: PluginResumeArgs): TaskResumeCandidate | undefined {
  const taskId = args.taskId?.trim().toLowerCase();
  return candidates.find(
    (candidate) =>
      (!taskId || candidate.identity.taskId === taskId) &&
      (!args.sourceSessionId || candidate.identity.sessionId === args.sourceSessionId) &&
      candidate.compatibility !== "not-resumable"
  );
}

function readManifest(root: string, taskId: string): TaskRunManifest | undefined {
  const result = readJsonDiagnostic<TaskRunManifest>(taskRunManifestPath(root, taskId));
  if (result.status === "corrupt") throw new Error(`Task manifest JSON is corrupt: ${result.filePath}: ${result.error}`);
  return result.status === "ok" && result.value.id === taskId ? result.value : undefined;
}
