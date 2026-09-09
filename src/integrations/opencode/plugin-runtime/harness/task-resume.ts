import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readJsonDiagnostic, updateJsonAtomic, type JsonReadResult } from "../../../../core/atomic-store.js";
import { taskSlug } from "../../../../core/task-id.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import { TASK_RESUME_SCHEMA_VERSION, type TaskIdentity, type TaskResumeCandidate, type TaskResumeStatus } from "./types.js";

export interface TaskIdentityUpdate {
  baseWorkingTreeFingerprint?: string;
  latestWorkingTreeFingerprint?: string;
  status?: TaskResumeStatus;
  updatedAt?: string;
  repositoryRoot?: string;
}

export interface TaskIdentityDiscovery {
  identities: TaskIdentity[];
  issues: Array<{ path: string; message: string }>;
}

export function taskIdentityPath(root: string, taskId: string, sessionId: string): string {
  return path.join(root, ".agent-context", "sidecar", `task-identity-${taskSlug(taskId)}-${taskSlug(sessionId)}.json`);
}

export function readTaskIdentityDiagnostic(root: string, taskId: string, sessionId: string): JsonReadResult<TaskIdentity> {
  return readJsonDiagnostic<TaskIdentity>(taskIdentityPath(root, taskId, sessionId));
}

export function readTaskIdentity(root: string, taskId: string, sessionId: string): TaskIdentity | undefined {
  const result = readTaskIdentityDiagnostic(root, taskId, sessionId);
  if (result.status === "missing") return undefined;
  if (result.status === "corrupt") throw new Error(`Task identity JSON is corrupt: ${result.filePath}: ${result.error}`);
  assertTaskIdentity(result.value, taskIdentityPath(root, taskId, sessionId));
  return normalizeTaskIdentity(result.value);
}

export function writeTaskIdentity(root: string, identity: TaskIdentity): TaskIdentity {
  const filePath = taskIdentityPath(root, identity.taskId, identity.sessionId);
  const normalized = normalizeTaskIdentity(identity);
  return updateJsonAtomic<TaskIdentity>(filePath, (current) => {
    if (current) assertTaskIdentity(current, filePath);
    return {
      ...(current ?? normalized),
      ...normalized,
      schemaVersion: TASK_RESUME_SCHEMA_VERSION,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: normalized.updatedAt
    };
  });
}

export function updateTaskIdentity(root: string, taskId: string, sessionId: string, update: TaskIdentityUpdate): TaskIdentity | undefined {
  const filePath = taskIdentityPath(root, taskId, sessionId);
  const result = readJsonDiagnostic<TaskIdentity>(filePath);
  if (result.status === "missing") return undefined;
  if (result.status === "corrupt") throw new Error(`Task identity JSON is corrupt: ${result.filePath}: ${result.error}`);
  assertTaskIdentity(result.value, filePath);
  return updateJsonAtomic<TaskIdentity>(filePath, (current) => {
    if (!current) throw new Error(`Task identity disappeared for ${taskId} and session ${sessionId}.`);
    assertTaskIdentity(current, filePath);
    return {
      ...current,
      ...update,
      repositoryRoot: normalizeRepositoryRoot(update.repositoryRoot ?? current.repositoryRoot),
      schemaVersion: TASK_RESUME_SCHEMA_VERSION,
      revision: (current.revision ?? 0) + 1,
      updatedAt: update.updatedAt ?? new Date().toISOString()
    };
  });
}

export function discoverTaskIdentities(root: string): TaskIdentityDiscovery {
  const directory = path.dirname(taskIdentityPath(root, "task", "session"));
  if (!existsSync(directory)) return { identities: [], issues: [] };
  const identities: TaskIdentity[] = [];
  const issues: Array<{ path: string; message: string }> = [];
  for (const file of readdirSync(directory)
    .filter((item) => /^task-identity-.+\.json$/i.test(item))
    .sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(directory, file);
    const result = readJsonDiagnostic<TaskIdentity>(filePath);
    if (result.status === "missing") continue;
    if (result.status === "corrupt") {
      issues.push({ path: filePath, message: result.error });
      continue;
    }
    try {
      assertTaskIdentity(result.value, filePath);
      identities.push(normalizeTaskIdentity(result.value));
    } catch (error) {
      issues.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { identities, issues };
}

export function taskIdentityForCurrentTree(
  root: string,
  input: Pick<TaskIdentity, "sessionId" | "taskId" | "baseWorkingTreeFingerprint" | "status"> & Partial<Pick<TaskIdentity, "repositoryRoot">>
): TaskIdentity {
  const current = currentSidecarWorkingTreeHash(root);
  return {
    schemaVersion: TASK_RESUME_SCHEMA_VERSION,
    sessionId: input.sessionId,
    repositoryRoot: normalizeRepositoryRoot(input.repositoryRoot ?? root),
    taskId: input.taskId,
    baseWorkingTreeFingerprint: input.baseWorkingTreeFingerprint,
    latestWorkingTreeFingerprint: current,
    status: input.status,
    updatedAt: new Date().toISOString()
  };
}

export function isUnfinishedTaskStatus(status: TaskResumeStatus): boolean {
  return status !== "completed" && status !== "abandoned";
}

export function normalizeRepositoryRoot(repositoryRoot: string): string {
  const resolved = path.resolve(repositoryRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeTaskIdentity(identity: TaskIdentity): TaskIdentity {
  return {
    ...identity,
    schemaVersion: TASK_RESUME_SCHEMA_VERSION,
    repositoryRoot: normalizeRepositoryRoot(identity.repositoryRoot),
    taskId: taskSlug(identity.taskId),
    sessionId: identity.sessionId.trim(),
    baseWorkingTreeFingerprint: identity.baseWorkingTreeFingerprint.trim(),
    latestWorkingTreeFingerprint: identity.latestWorkingTreeFingerprint.trim(),
    updatedAt: identity.updatedAt
  };
}

export function assertTaskIdentity(value: unknown, filePath = "task identity"): asserts value is TaskIdentity {
  if (!value || typeof value !== "object") throw new Error(`Invalid task identity in ${filePath}: expected an object.`);
  const identity = value as Partial<TaskIdentity>;
  const required: Array<keyof TaskIdentity> = [
    "schemaVersion",
    "sessionId",
    "repositoryRoot",
    "taskId",
    "baseWorkingTreeFingerprint",
    "latestWorkingTreeFingerprint",
    "status",
    "updatedAt"
  ];
  for (const key of required) {
    if (typeof identity[key] !== "string" || !String(identity[key]).trim()) throw new Error(`Invalid task identity in ${filePath}: ${key} is required.`);
  }
  if (identity.schemaVersion !== TASK_RESUME_SCHEMA_VERSION) {
    throw new Error(`Unsupported task identity schema in ${filePath}: ${String(identity.schemaVersion)}.`);
  }
  if (!["active", "dirty", "verification-required", "human-review", "stale-task", "completed", "abandoned"].includes(identity.status as string)) {
    throw new Error(`Invalid task identity status in ${filePath}: ${String(identity.status)}.`);
  }
  if (identity.revision !== undefined && typeof identity.revision !== "number") {
    throw new Error(`Invalid task identity revision in ${filePath}: expected a number.`);
  }
}

export function classifyTaskIdentity(root: string, identity: TaskIdentity): TaskResumeCandidate {
  const repositoryMatches = normalizeRepositoryRoot(root) === normalizeRepositoryRoot(identity.repositoryRoot);
  const currentWorkingTreeFingerprint = currentSidecarWorkingTreeHash(root);
  const workingTreeCompatible = currentWorkingTreeFingerprint === identity.latestWorkingTreeFingerprint;
  const unfinished = isUnfinishedTaskStatus(identity.status);
  if (!repositoryMatches) {
    return {
      identity,
      currentWorkingTreeFingerprint,
      repositoryMatches,
      workingTreeCompatible,
      compatibility: "mismatched-repository",
      reason: "The persisted task belongs to a different repository root and is not eligible for recovery."
    };
  }
  if (!unfinished) {
    return {
      identity,
      currentWorkingTreeFingerprint,
      repositoryMatches,
      workingTreeCompatible,
      compatibility: "not-resumable",
      reason: `The persisted task is already ${identity.status}.`
    };
  }
  if (workingTreeCompatible && identity.status !== "stale-task") {
    return {
      identity,
      currentWorkingTreeFingerprint,
      repositoryMatches,
      workingTreeCompatible,
      compatibility: "resume-verification",
      reason: "The repository root and latest working-tree fingerprint match; verification can resume."
    };
  }
  return {
    identity,
    currentWorkingTreeFingerprint,
    repositoryMatches,
    workingTreeCompatible,
    compatibility: "stale-task",
    reason: "The working tree differs from the last persisted task state; context and the validation plan must be rebuilt."
  };
}
