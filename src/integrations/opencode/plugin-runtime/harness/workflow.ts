import { readJsonDiagnostic, updateJsonAtomic } from "../../../../core/atomic-store.js";
import { hashText } from "../evidence.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import type { PluginWorkflowState } from "./types.js";
import path from "node:path";

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
  if (existing) return existing;
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
