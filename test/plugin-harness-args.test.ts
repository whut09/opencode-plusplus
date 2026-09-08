import assert from "node:assert/strict";
import test from "node:test";
import {
  parseContextGetArgs,
  parseContextSearchArgs,
  parseContextStatusArgs,
  parseEvaluateArgs,
  parseFeedbackArgs,
  parseHumanReviewArgs,
  parseInterventionsArgs,
  parseNextArgs,
  parsePrepareArgs,
  parseRetrieveArgs
} from "../src/integrations/opencode/plugin-runtime/harness/args.js";

test("plugin harness arg parsers reject empty tasks and accept optional fields", () => {
  assert.equal(parsePrepareArgs({}), "prepare requires a non-empty task.");
  assert.deepEqual(parsePrepareArgs({ task: "fix login timeout", type: "bugfix" }), { task: "fix login timeout", type: "bugfix" });
  assert.match(String(parsePrepareArgs({ task: "x", type: "docs" })), /bugfix/);
  assert.deepEqual(parseRetrieveArgs({ task: "auth", topK: "5" }), { task: "auth", topK: 5 });
  assert.deepEqual(parseRetrieveArgs({ task: "auth", taskType: "refactor" }), { task: "auth", taskType: "refactor" });
  assert.deepEqual(parseRetrieveArgs({ task: "auth", contextId: "private/auth", file: "docs/auth/errors.md" }), {
    task: "auth",
    contextId: "private/auth",
    file: "docs/auth/errors.md"
  });
  assert.deepEqual(parseRetrieveArgs({ task: "auth", contextId: "private/auth", full: true }), { task: "auth", contextId: "private/auth", full: true });
  assert.equal(parseRetrieveArgs({ task: "auth", file: "docs/auth/errors.md" }), "retrieve file requires contextId.");
  assert.equal(parseRetrieveArgs({ task: "auth", contextId: "private/auth", file: "x.md", full: true }), "retrieve file cannot be combined with full.");
  assert.match(String(parseRetrieveArgs({ task: "auth", taskType: "docs" })), /taskType/);
  assert.equal(parseRetrieveArgs({ task: "auth", topK: 0 }), "retrieve topK must be a positive integer.");
  assert.deepEqual(parseEvaluateArgs({}), {});
  assert.equal(parseEvaluateArgs({ taskId: "   " }), "evaluate taskId must be a non-empty string when provided.");
  assert.deepEqual(parseHumanReviewArgs({ taskId: "fix-auth", sessionId: "session-1", requestId: "review-1", action: "approve", confirmed: true }), {
    taskId: "fix-auth",
    sessionId: "session-1",
    requestId: "review-1",
    action: "approve",
    confirmed: true
  });
  assert.match(String(parseHumanReviewArgs({ action: "approve", confirmed: false })), /confirmed=true/);
  assert.deepEqual(parseNextArgs({ taskId: "fix-login-timeout" }), { taskId: "fix-login-timeout" });
  assert.deepEqual(parseFeedbackArgs({ entryId: "official/auth", source: "official", revision: 2, target: "entry", label: "useful" }), {
    entryId: "official/auth",
    source: "official",
    revision: 2,
    target: "entry",
    label: "useful"
  });
  assert.equal(
    parseFeedbackArgs({ entryId: "official/auth", source: "official", revision: 2, target: "file", label: "useful" }),
    "file feedback requires file."
  );
});

test("Context tool arg parsers normalize filters and reject malformed selectors", () => {
  assert.deepEqual(parseContextSearchArgs({ query: " payments ", topK: "4", taskType: "bugfix", tags: ["api", "api", "typescript"] }), {
    query: "payments",
    topK: 4,
    taskType: "bugfix",
    tags: ["api", "typescript"]
  });
  assert.deepEqual(parseContextSearchArgs({}), {});
  assert.match(String(parseContextSearchArgs({ taskType: "docs" })), /taskType/);
  assert.match(String(parseContextSearchArgs({ tags: "api" })), /tags/);
  assert.deepEqual(parseContextGetArgs({ entryId: "private/payments", language: "typescript", packageVersion: "1.0.0", file: "references/errors.md" }), {
    entryId: "private/payments",
    language: "typescript",
    packageVersion: "1.0.0",
    file: "references/errors.md"
  });
  assert.equal(parseContextGetArgs({}), "context get requires a non-empty entryId.");
  assert.match(String(parseContextGetArgs({ entryId: "x", file: "x.md", full: true })), /cannot be combined/);
  assert.match(String(parseContextGetArgs({ entryId: "x", withAnnotations: "yes" })), /withAnnotations/);
  assert.deepEqual(parseContextStatusArgs({ sessionId: "desktop-1" }), { sessionId: "desktop-1" });
  assert.deepEqual(parseInterventionsArgs({ taskId: "task-1" }), { taskId: "task-1" });
});
