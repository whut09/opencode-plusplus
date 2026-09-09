import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/core/git.js";
import {
  classifyTaskIdentity,
  discoverTaskIdentities,
  discoverTaskResumeCandidates,
  readTaskIdentity,
  synchronizeTaskResumeCandidates,
  taskIdentityPath,
  writeTaskIdentity
} from "../src/integrations/opencode/plugin-runtime/harness/task-resume.js";
import { TASK_RESUME_SCHEMA_VERSION, type TaskIdentity } from "../src/integrations/opencode/plugin-runtime/harness/types.js";
import { currentSidecarWorkingTreeHash } from "../src/integrations/opencode/plugin-runtime/worktree-hash.js";

test("task identity persistence is revisioned and deterministic", () => {
  const root = createGitFixture("identity");
  try {
    const fingerprint = currentSidecarWorkingTreeHash(root);
    const identity: TaskIdentity = {
      schemaVersion: TASK_RESUME_SCHEMA_VERSION,
      sessionId: "session-a",
      repositoryRoot: root,
      taskId: "fix-login",
      baseWorkingTreeFingerprint: fingerprint,
      latestWorkingTreeFingerprint: fingerprint,
      status: "verification-required",
      updatedAt: "2026-09-09T00:00:00.000Z"
    };
    const first = writeTaskIdentity(root, identity);
    const second = writeTaskIdentity(root, { ...identity, updatedAt: "2026-09-09T00:01:00.000Z" });
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(readTaskIdentity(root, "fix-login", "session-a")?.revision, 2);
    assert.equal(taskIdentityPath(root, "fix-login", "session-a").includes(".agent-context"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compatible unfinished identity is eligible for resume verification", () => {
  const root = createGitFixture("compatible");
  try {
    const fingerprint = currentSidecarWorkingTreeHash(root);
    const identity = writeTaskIdentity(root, {
      schemaVersion: TASK_RESUME_SCHEMA_VERSION,
      sessionId: "old-session",
      repositoryRoot: root,
      taskId: "fix-login",
      baseWorkingTreeFingerprint: fingerprint,
      latestWorkingTreeFingerprint: fingerprint,
      status: "verification-required",
      updatedAt: new Date().toISOString()
    });
    const candidate = classifyTaskIdentity(root, identity);
    assert.equal(candidate.compatibility, "resume-verification");
    assert.equal(candidate.repositoryMatches, true);
    assert.equal(candidate.workingTreeCompatible, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed working tree is classified as stale-task", () => {
  const root = createGitFixture("stale");
  try {
    const fingerprint = currentSidecarWorkingTreeHash(root);
    const identity = writeTaskIdentity(root, {
      schemaVersion: TASK_RESUME_SCHEMA_VERSION,
      sessionId: "old-session",
      repositoryRoot: root,
      taskId: "fix-login",
      baseWorkingTreeFingerprint: fingerprint,
      latestWorkingTreeFingerprint: fingerprint,
      status: "dirty",
      updatedAt: new Date().toISOString()
    });
    writeFileSync(path.join(root, "src", "login.ts"), "export const login = 'changed';\n", "utf8");
    const candidate = classifyTaskIdentity(root, identity);
    assert.equal(candidate.compatibility, "stale-task");
    assert.equal(candidate.workingTreeCompatible, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("working-tree fingerprint includes untracked file content", () => {
  const root = createGitFixture("untracked-content");
  try {
    const filePath = path.join(root, "src", "new-login.ts");
    const before = currentSidecarWorkingTreeHash(root);
    writeFileSync(filePath, "export const login = 'first';\n", "utf8");
    const first = currentSidecarWorkingTreeHash(root);
    writeFileSync(filePath, "export const login = 'second';\n", "utf8");
    const second = currentSidecarWorkingTreeHash(root);

    assert.notEqual(first, before);
    assert.notEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("working-tree fingerprint is independent of staging state", () => {
  const root = createGitFixture("staging");
  try {
    const filePath = path.join(root, "src", "login.ts");
    writeFileSync(filePath, "export const login = 'changed';\n", "utf8");
    const unstaged = currentSidecarWorkingTreeHash(root);
    runGit(root, ["add", "src/login.ts"]);
    const staged = currentSidecarWorkingTreeHash(root);

    assert.equal(staged, unstaged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity discovery retains repository mismatches and diagnoses corruption", () => {
  const root = createGitFixture("discovery");
  try {
    const fingerprint = currentSidecarWorkingTreeHash(root);
    writeTaskIdentity(root, {
      schemaVersion: TASK_RESUME_SCHEMA_VERSION,
      sessionId: "other-session",
      repositoryRoot: path.join(root, "other-repository"),
      taskId: "other-task",
      baseWorkingTreeFingerprint: fingerprint,
      latestWorkingTreeFingerprint: fingerprint,
      status: "active",
      updatedAt: new Date().toISOString()
    });
    mkdirSync(path.dirname(taskIdentityPath(root, "broken", "session")), { recursive: true });
    writeFileSync(taskIdentityPath(root, "broken", "session"), "{broken", "utf8");
    const discovered = discoverTaskIdentities(root);
    assert.equal(discovered.identities.length, 1);
    assert.equal(discovered.issues.length, 1);
    assert.equal(classifyTaskIdentity(root, discovered.identities[0]!).compatibility, "mismatched-repository");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume synchronization marks only changed in-repository tasks stale", () => {
  const root = createGitFixture("synchronize");
  try {
    const fingerprint = currentSidecarWorkingTreeHash(root);
    writeTaskIdentity(root, {
      schemaVersion: TASK_RESUME_SCHEMA_VERSION,
      sessionId: "old-session",
      repositoryRoot: root,
      taskId: "fix-login",
      baseWorkingTreeFingerprint: fingerprint,
      latestWorkingTreeFingerprint: fingerprint,
      status: "verification-required",
      updatedAt: "2026-09-09T00:00:00.000Z"
    });
    writeFileSync(path.join(root, "src", "login.ts"), "export const login = 'new';\n", "utf8");

    const before = discoverTaskResumeCandidates(root, { currentSessionId: "new-session" });
    assert.equal(before.candidates[0]?.compatibility, "stale-task");
    const synchronized = synchronizeTaskResumeCandidates(root, { currentSessionId: "new-session" });
    assert.deepEqual(synchronized.staleTaskIds, ["fix-login"]);
    assert.equal(synchronized.candidates[0]?.identity.status, "stale-task");
    assert.equal(synchronized.candidates[0]?.identity.latestWorkingTreeFingerprint, synchronized.currentWorkingTreeFingerprint);

    const repeated = synchronizeTaskResumeCandidates(root, { currentSessionId: "new-session" });
    assert.deepEqual(repeated.staleTaskIds, ["fix-login"]);
    assert.equal(repeated.candidates[0]?.identity.revision, synchronized.candidates[0]?.identity.revision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createGitFixture(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `opencode-plusplus-task-resume-${name}-`));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "login.ts"), "export const login = 'ok';\n", "utf8");
  runGit(root, ["init"]);
  runGit(root, ["checkout", "-b", "main"]);
  runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
  runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "baseline"]);
  return root;
}
