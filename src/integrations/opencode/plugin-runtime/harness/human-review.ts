import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readJsonDiagnostic, updateJsonAtomic } from "../../../../core/atomic-store.js";
import { taskSlug } from "../../../../core/task-id.js";
import type { HumanReviewReasonCode, HumanReviewRequest, HumanReviewStatus } from "../../../../harness/types.js";
import { hashText } from "../evidence.js";

export interface HumanReviewRequestDraft {
  taskId: string | null;
  sessionId: string | null;
  reasonCode: HumanReviewReasonCode;
  explanation: string;
  affectedFiles?: string[];
  suggestedCommands?: string[];
  currentBoundary?: string[];
  requestedBoundary?: string[];
  boundaryRevision?: number;
  now?: string;
}

export interface HumanReviewRequestUpdate {
  status: Extract<HumanReviewStatus, "approved" | "rejected" | "resumed" | "resolved">;
  explanation?: string;
  requiredUserAction?: string;
  resumeCondition?: string;
  boundaryRevision?: number;
  now?: string;
}

export interface HumanReviewRequestLocation {
  request: HumanReviewRequest;
  filePath: string;
}

export interface HumanReviewDiscovery {
  requests: HumanReviewRequestLocation[];
  issues: Array<{ path: string; message: string }>;
}

export function humanReviewRequestPath(root: string, taskId: string | null, sessionId: string | null): string {
  const task = taskId?.trim() ? taskSlug(taskId.trim()) : "unknown-task";
  const session = sessionId?.trim() ? `-${taskSlug(sessionId.trim())}` : "";
  return path.join(root, ".agent-context", "sidecar", `human-review-${task}${session}.json`);
}

export function readHumanReviewRequest(root: string, taskId: string | null, sessionId: string | null): HumanReviewRequest | undefined {
  const filePath = humanReviewRequestPath(root, taskId, sessionId);
  const result = readJsonDiagnostic<HumanReviewRequest>(filePath);
  if (result.status === "corrupt") throw new Error(`Human review JSON is corrupt: ${result.filePath}: ${result.error}`);
  return result.status === "ok" && result.value.schemaVersion === "opencode-plusplus.human-review.v1" ? result.value : undefined;
}

export function discoverHumanReviewRequests(root: string, taskId?: string | null): HumanReviewDiscovery {
  const directory = path.dirname(humanReviewRequestPath(root, null, null));
  if (!fsExists(directory)) return { requests: [], issues: [] };
  const normalizedTaskId = taskId?.trim() ? taskSlug(taskId.trim()) : undefined;
  const requests: HumanReviewRequestLocation[] = [];
  const issues: Array<{ path: string; message: string }> = [];
  for (const file of readDirectory(directory)
    .filter((item) => /^human-review-.+\.json$/i.test(item))
    .sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(directory, file);
    const result = readJsonDiagnostic<HumanReviewRequest>(filePath);
    if (result.status === "missing") continue;
    if (result.status === "corrupt") {
      issues.push({ path: filePath, message: result.error });
      continue;
    }
    if (result.value.schemaVersion !== "opencode-plusplus.human-review.v1") {
      issues.push({ path: filePath, message: `Unsupported human review schema: ${String(result.value.schemaVersion)}.` });
      continue;
    }
    if (normalizedTaskId && result.value.taskId !== normalizedTaskId) continue;
    requests.push({ request: result.value, filePath });
  }
  requests.sort((left, right) => right.request.updatedAt.localeCompare(left.request.updatedAt) || left.filePath.localeCompare(right.filePath));
  return { requests, issues };
}

export function locateHumanReviewRequest(
  root: string,
  taskId: string | null,
  sessionId: string | null,
  requestId?: string
): HumanReviewRequestLocation | undefined {
  const exactPath = humanReviewRequestPath(root, taskId, sessionId);
  const exact = readJsonDiagnostic<HumanReviewRequest>(exactPath);
  if (exact.status === "corrupt") throw new Error(`Human review JSON is corrupt: ${exact.filePath}: ${exact.error}`);
  if (exact.status === "ok" && exact.value.schemaVersion === "opencode-plusplus.human-review.v1" && (!requestId || exact.value.requestId === requestId)) {
    return { request: exact.value, filePath: exactPath };
  }
  const discovered = discoverHumanReviewRequests(root, taskId);
  if (requestId) return discovered.requests.find((item) => item.request.requestId === requestId);
  const pending = discovered.requests.filter((item) => item.request.status === "pending");
  const sameSession = pending.find((item) => !sessionId || !item.request.sessionId || item.request.sessionId === sessionId);
  return sameSession ?? pending[0] ?? discovered.requests[0];
}

export function buildHumanReviewRequest(draft: HumanReviewRequestDraft): HumanReviewRequest {
  const now = draft.now ?? new Date().toISOString();
  const affectedFiles = normalize(draft.affectedFiles);
  const currentBoundary = normalize(draft.currentBoundary);
  const requestedBoundary = normalize(draft.requestedBoundary ?? affectedFiles);
  const requestId = `human-review-${hashText(
    JSON.stringify({
      taskId: draft.taskId,
      sessionId: draft.sessionId,
      reasonCode: draft.reasonCode,
      explanation: draft.explanation,
      affectedFiles,
      currentBoundary,
      requestedBoundary
    })
  ).slice(0, 20)}`;
  const copy = copyForReason(draft.reasonCode, draft.explanation, draft.suggestedCommands ?? [], currentBoundary, requestedBoundary);
  return {
    schemaVersion: "opencode-plusplus.human-review.v1",
    revision: 1,
    requestId,
    taskId: draft.taskId,
    sessionId: draft.sessionId,
    reasonCode: draft.reasonCode,
    title: copy.title,
    explanation: copy.explanation,
    requiredUserAction: copy.requiredUserAction,
    suggestedCommands: normalize(copy.suggestedCommands),
    affectedFiles,
    resumeCondition: copy.resumeCondition,
    status: "pending",
    ...(currentBoundary.length ? { currentBoundary } : {}),
    ...(requestedBoundary.length ? { requestedBoundary } : {}),
    ...(draft.boundaryRevision !== undefined ? { boundaryRevision: draft.boundaryRevision } : {}),
    createdAt: now,
    updatedAt: now
  };
}

export function upsertHumanReviewRequest(root: string, draft: HumanReviewRequestDraft): HumanReviewRequest {
  const next = buildHumanReviewRequest(draft);
  return updateJsonAtomic<HumanReviewRequest>(humanReviewRequestPath(root, draft.taskId, draft.sessionId), (current) => {
    if (current?.requestId === next.requestId && current.status === "pending") return current;
    return {
      ...next,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? next.createdAt
    };
  });
}

export function updateHumanReviewRequest(
  root: string,
  taskId: string | null,
  sessionId: string | null,
  requestId: string,
  update: HumanReviewRequestUpdate
): HumanReviewRequest {
  return updateHumanReviewRequestAtPath(humanReviewRequestPath(root, taskId, sessionId), requestId, update);
}

export function updateHumanReviewRequestAtPath(filePath: string, requestId: string, update: HumanReviewRequestUpdate): HumanReviewRequest {
  return updateJsonAtomic<HumanReviewRequest>(filePath, (current) => {
    if (!current || current.requestId !== requestId) throw new Error(`Human review request ${requestId} is not current for this task.`);
    if (current.status !== "pending") return current;
    const now = update.now ?? new Date().toISOString();
    return {
      ...current,
      status: update.status,
      ...(update.explanation ? { explanation: update.explanation } : {}),
      ...(update.requiredUserAction ? { requiredUserAction: update.requiredUserAction } : {}),
      ...(update.resumeCondition ? { resumeCondition: update.resumeCondition } : {}),
      ...(update.boundaryRevision !== undefined ? { boundaryRevision: update.boundaryRevision } : {}),
      revision: (current.revision ?? 0) + 1,
      updatedAt: now
    };
  });
}

export function classifyHumanReviewReason(input: {
  boundaryExpansion?: boolean;
  noExecutableTest?: boolean;
  externalSideEffect?: boolean;
  pluginFailure?: boolean;
  ambiguousRepositoryState?: boolean;
}): HumanReviewReasonCode {
  if (input.boundaryExpansion) return "BOUNDARY_EXPANSION_REQUIRED";
  if (input.noExecutableTest) return "NO_EXECUTABLE_TEST";
  if (input.externalSideEffect) return "EXTERNAL_SIDE_EFFECT";
  if (input.pluginFailure) return "PLUGIN_FAILURE";
  if (input.ambiguousRepositoryState) return "AMBIGUOUS_REPOSITORY_STATE";
  return "UNVERIFIABLE_RESULT";
}

function copyForReason(
  reasonCode: HumanReviewReasonCode,
  explanation: string,
  suggestedCommands: string[],
  currentBoundary: string[],
  requestedBoundary: string[]
): Pick<HumanReviewRequest, "title" | "explanation" | "requiredUserAction" | "suggestedCommands" | "resumeCondition"> {
  if (reasonCode === "BOUNDARY_EXPANSION_REQUIRED") {
    return {
      title: "OpenCode++ needs permission to expand task scope.",
      explanation: `${explanation} Current: ${currentBoundary.join(", ") || "no explicit path"}. Requested: ${requestedBoundary.join(", ") || "new task paths"}.`,
      requiredUserAction:
        'Review the requested files and explicitly approve the scope expansion with opencode_plusplus_human_review action "approve" and confirmed true.',
      suggestedCommands,
      resumeCondition: "After approval, OpenCode++ increments the boundary revision and continues from the current task state; no prepare step is needed."
    };
  }
  if (reasonCode === "NO_EXECUTABLE_TEST") {
    return {
      title: "OpenCode++ needs an executable verification path.",
      explanation,
      requiredUserAction: "Configure an executable repository validation command or inspect and accept the diff as a human.",
      suggestedCommands,
      resumeCondition: "The task can continue after a current command or CI result is captured, or after the human review decision is recorded."
    };
  }
  if (reasonCode === "EXTERNAL_SIDE_EFFECT") {
    return {
      title: "OpenCode++ needs consent for an external side effect.",
      explanation,
      requiredUserAction: "Review the target and approve the native OpenCode permission request only if the side effect is intended.",
      suggestedCommands,
      resumeCondition: "The host permission result must be recorded before OpenCode++ evaluates the task again."
    };
  }
  if (reasonCode === "PLUGIN_FAILURE") {
    return {
      title: "OpenCode++ could not complete a plugin operation.",
      explanation,
      requiredUserAction: "Inspect the attributed OpenCode++ error and choose whether to continue with the recorded state or stop the task.",
      suggestedCommands,
      resumeCondition: "The task resumes from the last persisted phase after the plugin state is readable and the next explicit action is selected."
    };
  }
  if (reasonCode === "AMBIGUOUS_REPOSITORY_STATE") {
    return {
      title: "OpenCode++ needs the repository state clarified.",
      explanation,
      requiredUserAction:
        "Resolve the listed repository ambiguity, such as a stale context, unresolved diff, or conflicting state, then continue from the current phase.",
      suggestedCommands,
      resumeCondition: "OpenCode++ resumes when the repository state and its persisted evidence agree on the same working tree."
    };
  }
  return {
    title: "OpenCode++ cannot verify the result automatically.",
    explanation,
    requiredUserAction: "Review the affected files and decide how the missing verification or repository decision should be supplied.",
    suggestedCommands,
    resumeCondition: "The task resumes after the missing verification or explicit human decision is recorded."
  };
}

function normalize(items: string[] | undefined): string[] {
  return [...new Set((items ?? []).map((item) => item.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function fsExists(filePath: string): boolean {
  return existsSync(filePath);
}

function readDirectory(directory: string): string[] {
  return readdirSync(directory);
}
