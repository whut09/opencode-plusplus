import assert from "node:assert/strict";
import test from "node:test";
import {
  callHarnessTool,
  cleanupHarnessUxFixture,
  createHarnessUxFixture,
  editFixtureFile,
  finishHarnessUxFixture,
  runAndRecordVerification
} from "./support/harness-ux-fixture.js";
import type { PluginHarnessResult } from "../src/integrations/opencode/plugin-runtime/harness/types.js";

function result(output: string): PluginHarnessResult {
  return JSON.parse(output) as PluginHarnessResult;
}

test("UX baseline A: ordinary bugfix records inspect, edit, test, and current completion cost", async () => {
  const fixture = await createHarnessUxFixture({ scenarioId: "ordinary-bugfix", withTests: true, withCheck: true });
  try {
    const prepared = result(await callHarnessTool(fixture, "prepare", { task: "fix the profile timeout", type: "bugfix" }));
    assert.equal(prepared.ok, true);
    const retrieved = result(await callHarnessTool(fixture, "retrieve", { task: "fix the profile timeout", topK: 4 }));
    assert.equal(retrieved.ok, true);

    await editFixtureFile(fixture, "src/profile.ts", "export function profileTimeout() { return 10; }\n");
    const verification = await runAndRecordVerification(fixture, { command: "npm run test -- test/profile.test.ts" });
    const contracts = await runAndRecordVerification(fixture, { command: "npm run validate-contracts" });
    assert.equal(verification.exitCode, 0, `${verification.stdout}\n${verification.stderr}`);
    assert.equal(contracts.exitCode, 0, `${contracts.stdout}\n${contracts.stderr}`);

    const evaluated = result(await callHarnessTool(fixture, "evaluate", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const next = result(await callHarnessTool(fixture, "next", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const dashboard = result(await callHarnessTool(fixture, "dashboard", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const metrics = finishHarnessUxFixture(fixture);

    assert.equal(evaluated.ok, true);
    assert.equal(next.ok, true);
    assert.equal(dashboard.ok, true);
    assert.equal(metrics.harnessToolCalls, 5);
    assert.equal(metrics.modelVisibleHarnessSteps, 5);
    assert.equal(metrics.duplicateEvaluations, 0);
    assert.equal(metrics.userApprovals, 0);
    assert.equal(metrics.userInterruptions, 0);
    assert.equal(metrics.humanReviews, 0);
    assert.equal(metrics.verificationCommands, 2);
    assert.equal(metrics.finalDecision, "run-tests", JSON.stringify({ evaluated, next, metrics }));
    assert.ok(metrics.automaticRuntimeSteps >= 2);
  } finally {
    cleanupHarnessUxFixture(fixture);
  }
});

test("UX baseline B: failed verification and repair record two evaluation cycles", async () => {
  const fixture = await createHarnessUxFixture({ scenarioId: "repair-loop", withTests: true, withCheck: true });
  try {
    const prepared = result(await callHarnessTool(fixture, "prepare", { task: "fix the profile timeout", type: "bugfix" }));
    assert.equal(prepared.ok, true);
    const retrieved = result(await callHarnessTool(fixture, "retrieve", { task: "fix the profile timeout", topK: 4 }));
    assert.equal(retrieved.ok, true);

    await editFixtureFile(fixture, "src/profile.ts", "export function profileTimeout() { throw new Error('broken'); }\n");
    const failed = await runAndRecordVerification(fixture, { command: "npm run test -- test/profile.test.ts", fail: true });
    assert.notEqual(failed.exitCode, 0);
    const firstEvaluate = result(await callHarnessTool(fixture, "evaluate", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const firstNext = result(await callHarnessTool(fixture, "next", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    assert.equal(firstEvaluate.decision, "run-tests");
    assert.equal(firstNext.nextAction, "run-tests");

    await editFixtureFile(fixture, "src/profile.ts", "export function profileTimeout() { return 10; }\n");
    const passed = await runAndRecordVerification(fixture, { command: "npm run test -- test/profile.test.ts" });
    const contracts = await runAndRecordVerification(fixture, { command: "npm run validate-contracts" });
    assert.equal(passed.exitCode, 0, `${passed.stdout}\n${passed.stderr}`);
    assert.equal(contracts.exitCode, 0, `${contracts.stdout}\n${contracts.stderr}`);

    const secondEvaluate = result(await callHarnessTool(fixture, "evaluate", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const secondNext = result(await callHarnessTool(fixture, "next", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const dashboard = result(await callHarnessTool(fixture, "dashboard", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const metrics = finishHarnessUxFixture(fixture);

    assert.equal(secondEvaluate.ok, true);
    assert.equal(secondNext.ok, true);
    assert.equal(dashboard.ok, true);
    assert.equal(metrics.harnessToolCalls, 7);
    assert.equal(metrics.modelVisibleHarnessSteps, 7);
    assert.equal(metrics.duplicateEvaluations, 0);
    assert.equal(metrics.userApprovals, 0);
    assert.equal(metrics.userInterruptions, 0);
    assert.equal(metrics.humanReviews, 0);
    assert.equal(metrics.verificationCommands, 2);
    assert.equal(metrics.finalDecision, "run-tests", JSON.stringify({ firstEvaluate, firstNext, secondEvaluate, secondNext, metrics }));
  } finally {
    cleanupHarnessUxFixture(fixture);
  }
});

test("UX baseline C: docs-only edits avoid a full-suite command but still expose current loop cost", async () => {
  const fixture = await createHarnessUxFixture({ scenarioId: "docs-only", withTests: true, withCheck: true, docsOnly: true });
  try {
    const prepared = result(await callHarnessTool(fixture, "prepare", { task: "update documentation", type: "bugfix" }));
    assert.equal(prepared.ok, true);
    const retrieved = result(await callHarnessTool(fixture, "retrieve", { task: "update documentation", topK: 4 }));
    assert.equal(retrieved.ok, true);

    await editFixtureFile(fixture, "docs.md", "# Updated documentation\n");
    const evaluated = result(await callHarnessTool(fixture, "evaluate", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const next = result(await callHarnessTool(fixture, "next", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const dashboard = result(await callHarnessTool(fixture, "dashboard", { taskId: prepared.taskId, sessionId: fixture.sessionId }));
    const metrics = finishHarnessUxFixture(fixture);

    assert.equal(evaluated.ok, true);
    assert.equal(next.ok, true);
    assert.equal(dashboard.ok, true);
    assert.equal(evaluated.findings.some((finding) => finding.startsWith("policy.required.tests:")), false);
    assert.equal(evaluated.requiredCommands.includes("npm run test"), false);
    assert.equal(evaluated.decision, "run-tests");
    assert.equal(next.nextAction, "run-tests");
    assert.equal(metrics.harnessToolCalls, 5);
    assert.equal(metrics.modelVisibleHarnessSteps, 5);
    assert.equal(metrics.verificationCommands, 0);
    assert.equal(metrics.humanReviews, 0);
    assert.equal(metrics.finalDecision, "run-tests", JSON.stringify({ evaluated, next, metrics }));
  } finally {
    cleanupHarnessUxFixture(fixture);
  }
});
