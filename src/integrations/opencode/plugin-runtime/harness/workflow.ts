import { readJsonDiagnostic, updateJsonAtomic } from "../../../../core/atomic-store.js";
import { hashText } from "../evidence.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import type { PluginWorkflowState, TaskIdentity } from "./types.js";
import path from "node:path";
import { synchronizeTaskResumeCandidates } from "./task-resume.js";

export function workflowStatePath(root: string, sessionId: string): string {
  return path.join(root, ".agent-context", "sidecar", `plugin-workflow-${hashText(sessionId).slice(0, 16)}.json`);
}

export function readWorkflowState(root: string, sessionId: string): PluginWorkflowState | undefined {
  const result = readJsonDiagnostic<PluginWorkflowState>(workflowStatePath(root, sessionId));
  if (result.status === "corrupt") throw new Error(`Plugin workflow JSON is corrupt: ${result.filePath}: ${result.error}`);
  return result.status === "ok" ? result.value : undefined;
}

export function initializeWorkflowState(root: string, sessionId: string): PluginWorkflowState {
  const current = currentSidecarWorkingTreeHash(root);
  const existing = readWorkflowState(root, sessionId);
  if (existing) {
    if (existing.boundaryRevision !== undefined) return existing;
    return updateJsonAtomic<PluginWorkflowState>(workflowStatePath(root, sessionId), (state) => ({
      ...(state ?? existing),
      schemaVersion: 1,
      boundaryRevision: 1,
      updatedAt: new Date().toISOString()
    }));
  }
  const state: PluginWorkflowState = {
    schemaVersion: 1,
    revision: 1,
    sessionId,
    phase: "created",
    taskId: null,
    contextFingerprint: null,
    initialWorkingTreeHash: current,
    currentWorkingTreeHash: current,
    editBoundary: { allowedEditGlobs: [], avoidEditGlobs: [] },
    boundaryRevision: 1,
    requiredTests: [],
    lastEventKey: null,
    sourceChanged: false,
    updatedAt: new Date().toISOString()
  };
  return updateJsonAtomic<PluginWorkflowState>(workflowStatePath(root, sessionId), (current) => current ?? state);
}

export function refreshWorkflowResumeCandidates(root: string, sessionId: string): PluginWorkflowState | undefined {
  const existing = readWorkflowState(root, sessionId);
  if (!existing) return undefined;
  const discovered = synchronizeTaskResumeCandidates(root, { currentSessionId: sessionId });
  const nextCandidates = discovered.candidates;
  const previousCandidates = existing.resumeCandidates ?? [];
  if (JSON.stringify(previousCandidates) === JSON.stringify(nextCandidates)) return existing;
  return updateJsonAtomic<PluginWorkflowState>(workflowStatePath(root, sessionId), (state) => {
    if (!state) throw new Error(`Plugin workflow state disappeared for session ${sessionId}.`);
    return {
      ...state,
      schemaVersion: 1,
      revision: (state.revision ?? 0) + 1,
      resumeCandidates: nextCandidates,
      updatedAt: new Date().toISOString()
    };
  });
}

export function resumeWorkflowState(root: string, sourceSessionId: string, targetSessionId: string, identity: TaskIdentity): PluginWorkflowState {
  const source = readWorkflowState(root, sourceSessionId);
  const current = currentSidecarWorkingTreeHash(root);
  const candidates = synchronizeTaskResumeCandidates(root, { currentSessionId: targetSessionId }).candidates;
  const resumed: PluginWorkflowState = {
    schemaVersion: 1,
    revision: 1,
    sessionId: targetSessionId,
    phase: "evaluated",
    taskId: identity.taskId,
    contextFingerprint: source?.contextFingerprint ?? contextFingerprint(root, identity.taskId),
    initialWorkingTreeHash: source?.initialWorkingTreeHash ?? identity.baseWorkingTreeFingerprint,
    currentWorkingTreeHash: current,
    editBoundary: source?.editBoundary ?? { allowedEditGlobs: [], avoidEditGlobs: [] },
    boundaryRevision: source?.boundaryRevision ?? 1,
    resumeCandidates: candidates,
    requiredTests: source?.requiredTests ?? [],
    lastEventKey: `resume:${sourceSessionId}:${targetSessionId}:${current}`,
    sourceChanged: current !== (source?.initialWorkingTreeHash ?? identity.baseWorkingTreeFingerprint),
    resumedFromSessionId: sourceSessionId,
    updatedAt: new Date().toISOString()
  };
  return updateJsonAtomic<PluginWorkflowState>(workflowStatePath(root, targetSessionId), (existing) => {
    if (existing) {
      if (existing.taskId && existing.taskId !== identity.taskId) {
        throw new Error(`Session ${targetSessionId} is already associated with task ${existing.taskId}.`);
      }
      if (existing.taskId === identity.taskId && existing.resumedFromSessionId === sourceSessionId) return existing;
      return { ...resumed, revision: (existing.revision ?? 0) + 1 };
    }
    return resumed;
  });
}

export function updateWorkflowState(root: string, sessionId: string, update: Partial<PluginWorkflowState> & { eventKey?: string }): PluginWorkflowState {
  initializeWorkflowState(root, sessionId);
  return updateJsonAtomic<PluginWorkflowState>(workflowStatePath(root, sessionId), (state) => {
    if (!state) throw new Error(`Plugin workflow state disappeared for session ${sessionId}.`);
    if (update.eventKey && update.eventKey === state.lastEventKey) return state;
    const current = currentSidecarWorkingTreeHash(root);
    return {
      ...state,
      ...update,
      schemaVersion: 1,
      revision: (state.revision ?? 0) + 1,
      currentWorkingTreeHash: current,
      sourceChanged: state.sourceChanged || current !== state.initialWorkingTreeHash,
      lastEventKey: update.eventKey ?? state.lastEventKey,
      updatedAt: new Date().toISOString()
    };
  });
}

export function contextFingerprint(root: string, taskId: string): string {
  return hashText(`${path.resolve(root)}:${taskId}`);
}
