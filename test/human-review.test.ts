import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHumanReviewRequest,
  classifyHumanReviewReason,
  humanReviewRequestPath,
  readHumanReviewRequest,
  updateHumanReviewRequest,
  upsertHumanReviewRequest
} from "../src/integrations/opencode/plugin-runtime/harness/human-review.js";
import { createPluginHarnessError } from "../src/integrations/opencode/plugin-runtime/harness/protocol.js";

test("human review requests explain boundary expansion and remain deterministic", () => {
  const first = buildHumanReviewRequest({
    taskId: "fix-auth",
    sessionId: "session-1",
    reasonCode: "BOUNDARY_EXPANSION_REQUIRED",
    explanation: "The selected implementation imports shared token logic.",
    currentBoundary: ["packages/auth/**"],
    requestedBoundary: ["packages/shared/token.ts"],
    now: "2026-09-08T00:00:00.000Z"
  });
  const second = buildHumanReviewRequest({
    taskId: "fix-auth",
    sessionId: "session-1",
    reasonCode: "BOUNDARY_EXPANSION_REQUIRED",
    explanation: "The selected implementation imports shared token logic.",
    currentBoundary: ["packages/auth/**"],
    requestedBoundary: ["packages/shared/token.ts"],
    now: "2026-09-08T00:00:00.000Z"
  });

  assert.equal(first.requestId, second.requestId);
  assert.equal(first.title, "OpenCode++ needs permission to expand task scope.");
  assert.match(first.explanation, /Current: packages\/auth/);
  assert.match(first.explanation, /Requested: packages\/shared\/token\.ts/);
  assert.doesNotMatch(first.requiredUserAction, /Please retry|repeat the task/i);
});

test("reason classification keeps boundary and plugin failures distinct", () => {
  assert.equal(classifyHumanReviewReason({ boundaryExpansion: true, pluginFailure: true }), "BOUNDARY_EXPANSION_REQUIRED");
  assert.equal(classifyHumanReviewReason({ pluginFailure: true }), "PLUGIN_FAILURE");
  assert.equal(classifyHumanReviewReason({ noExecutableTest: true }), "NO_EXECUTABLE_TEST");
  assert.equal(classifyHumanReviewReason({}), "UNVERIFIABLE_RESULT");
});

test("human review requests use atomic persistence and idempotent upsert", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-human-review-"));
  try {
    const draft = {
      taskId: "fix-auth",
      sessionId: "session-1",
      reasonCode: "NO_EXECUTABLE_TEST" as const,
      explanation: "No executable test was discovered.",
      suggestedCommands: ["npm test"],
      now: "2026-09-08T00:00:00.000Z"
    };
    const first = upsertHumanReviewRequest(root, draft);
    const second = upsertHumanReviewRequest(root, draft);
    assert.equal(second.requestId, first.requestId);
    assert.equal(second.revision, first.revision);
    assert.equal(readHumanReviewRequest(root, "fix-auth", "session-1")?.status, "pending");
    assert.equal(existsSync(humanReviewRequestPath(root, "fix-auth", "session-1")), true);
    assert.match(readFileSync(humanReviewRequestPath(root, "fix-auth", "session-1"), "utf8"), /schemaVersion/);

    const approved = updateHumanReviewRequest(root, "fix-auth", "session-1", first.requestId, {
      status: "approved",
      boundaryRevision: 2,
      now: "2026-09-08T00:01:00.000Z"
    });
    assert.equal(approved.status, "approved");
    assert.equal(approved.boundaryRevision, 2);
    assert.equal(updateHumanReviewRequest(root, "fix-auth", "session-1", first.requestId, { status: "resumed" }).status, "approved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin failures remain diagnosable when the review store is corrupt", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-human-review-corrupt-"));
  try {
    const requestPath = humanReviewRequestPath(root, "task-1", "session-1");
    mkdirSync(path.dirname(requestPath), { recursive: true });
    writeFileSync(requestPath, "{broken", "utf8");
    const result = createPluginHarnessError(root, "evaluate", "plugin state could not be read", "task-1", "session-1", "argument", undefined, {
      code: "PLUGIN_STATE_CORRUPT",
      message: "plugin state could not be read",
      attribution: "opencode-plusplus",
      retryable: false
    });
    assert.equal(result.decision, "human-review");
    assert.equal(result.humanReview?.reasonCode, "PLUGIN_FAILURE");
    assert.match(result.humanReview?.explanation ?? "", /plugin state could not be read/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
