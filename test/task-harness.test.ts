import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContextPackage } from "../src/core/context-builder.js";
import { runGit } from "../src/core/git.js";
import { renderTaskPlan, renderTaskVerify, writeTaskContextPack } from "../src/outputs/task-harness.js";
import { writeTaskRun } from "../src/outputs/task-run.js";

function createTaskRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-harness-"));
  mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  mkdirSync(path.join(root, "test", "auth"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", check: "tsc --noEmit" } }), "utf8");
  writeFileSync(
    path.join(root, "src", "auth", "session.ts"),
    `
export function loginSession() { return "ok"; }
`,
    "utf8"
  );
  writeFileSync(
    path.join(root, "src", "auth", "middleware.ts"),
    `
import { loginSession } from "./session.js";
export function authMiddleware() { return loginSession(); }
`,
    "utf8"
  );
  writeFileSync(
    path.join(root, "test", "auth", "session.test.ts"),
    `
import { loginSession } from "../../src/auth/session.js";
loginSession();
`,
    "utf8"
  );
  return root;
}

test("task plan renders intent, inspection boundary, and validation commands", async () => {
  const root = createTaskRepo();
  try {
    const context = await buildContextPackage(root);
    const plan = renderTaskPlan(context, "fix login timeout bug", { type: "bugfix", tokenBudget: 2000 });

    assert.match(plan, /# Task Plan/);
    assert.match(plan, /## Intent\nfix login timeout bug/);
    assert.match(plan, /## Suspected modules/);
    assert.match(plan, /src\/auth\/session\.ts/);
    assert.match(plan, /test\/auth\/session\.test\.ts/);
    assert.match(plan, /## Do not edit unless necessary/);
    assert.match(plan, /npm run test -- login/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task pack writes task directory files", async () => {
  const root = createTaskRepo();
  try {
    const context = await buildContextPackage(root);
    const result = writeTaskContextPack(context, "fix login timeout bug", { type: "bugfix", tokenBudget: 2000 });
    const relative = result.files.map((file) => path.relative(result.dir, file).replace(/\\/g, "/")).sort();

    assert.equal(result.taskId, "fix-login-timeout-bug");
    assert.deepEqual(relative, ["dependency-neighbors.md", "prompt.md", "relevant-files.md", "risk.md", "task.md", "tests.md"]);
    assert.ok(existsSync(path.join(result.dir, "prompt.md")));
    assert.match(readFileSync(path.join(result.dir, "risk.md"), "utf8"), /# Risk/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task run writes a complete agent execution context", async () => {
  const root = createTaskRepo();
  try {
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "Repo Context"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    const context = await buildContextPackage(root);
    const result = writeTaskRun(context, "fix login timeout bug", { type: "bugfix", tokenBudget: 2000, base: "main" });
    const relative = result.files.map((file) => path.relative(result.dir, file).replace(/\\/g, "/")).sort();
    const manifest = JSON.parse(readFileSync(path.join(result.dir, "run.json"), "utf8"));

    assert.equal(result.runId, "fix-login-timeout-bug");
    assert.deepEqual(relative, [
      "edit-boundary.md",
      "expected-diff.md",
      "impact.md",
      "pack.md",
      "plan.md",
      "prompt.claude.md",
      "prompt.codex.md",
      "prompt.cursor.md",
      "prompt.opencode.md",
      "regression.md",
      "run.json",
      "state.json",
      "tests.md",
      "verification-plan.md",
      "verify.md"
    ]);
    assert.equal(manifest.task, "fix login timeout bug");
    assert.equal(manifest.type, "bugfix");
    assert.equal(manifest.contextBudget.maxTokens, 2000);
    assert.ok(Array.isArray(manifest.mustInspect));
    assert.ok(Array.isArray(manifest.allowedEditGlobs));
    assert.ok(Array.isArray(manifest.avoidEditGlobs));
    assert.ok(Array.isArray(manifest.relatedTests));
    assert.ok(Array.isArray(manifest.requiredCommands));
    assert.equal(manifest.traceFile, ".agent-context/traces/fix-login-timeout-bug.json");
    assert.ok(manifest.files.includes(".agent-context/runs/fix-login-timeout-bug/run.json"));
    assert.ok(manifest.files.includes(".agent-context/runs/fix-login-timeout-bug/state.json"));
    assert.ok(manifest.files.includes(".agent-context/traces/fix-login-timeout-bug.json"));
    const state = JSON.parse(readFileSync(path.join(result.dir, "state.json"), "utf8"));
    assert.equal(state.state, "EDIT_BOUNDARY_READY");
    assert.equal(state.nextAction.type, "start_agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task verify reports missing tests and risk for changed source files", async () => {
  const root = createTaskRepo();
  try {
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "Repo Context"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    writeFileSync(
      path.join(root, "src", "auth", "session.ts"),
      `
export function loginSession() { return "fixed"; }
`,
      "utf8"
    );

    const context = await buildContextPackage(root);
    const report = renderTaskVerify(context, { base: "main", diff: true });

    assert.match(report, /# Task Verify/);
    assert.match(report, /src\/auth\/session\.ts/);
    assert.doesNotMatch(report, /`rc\/auth\/session\.ts`/);
    assert.match(report, /Missing tests/);
    assert.match(report, /without updating related test/);
    assert.match(report, /Risk score: \d+\/100/);
    assert.match(report, /npm run test -- auth/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
