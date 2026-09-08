import assert from "node:assert/strict";
import test from "node:test";
import { assessPluginEditBoundary, matchesPathGlob } from "../src/integrations/opencode/plugin-runtime/harness/edit-boundary.js";

test("edit boundary identifies an approvable scope expansion", () => {
  const result = assessPluginEditBoundary(["packages/auth/login.ts", "packages/shared/token.ts"], {
    allowedEditGlobs: ["packages/auth/**"],
    avoidEditGlobs: ["node_modules/**", ".agent-context/**"],
    revision: 3
  });
  assert.deepEqual(result.outsideAllowed, ["packages/shared/token.ts"]);
  assert.deepEqual(result.avoided, []);
  assert.equal(result.expansionRequired, true);
  assert.equal(result.boundaryRevision, 3);
});

test("protected paths are not converted into scope expansion approval", () => {
  const result = assessPluginEditBoundary(["src/auth.ts", ".agent-context/runs/task/run.json"], {
    allowedEditGlobs: ["src/**"],
    avoidEditGlobs: [".agent-context/**"],
    revision: 1
  });
  assert.deepEqual(result.avoided, [".agent-context/runs/task/run.json"]);
  assert.equal(result.expansionRequired, false);
});

test("boundary matching is stable across Windows separators", () => {
  assert.equal(matchesPathGlob("packages\\shared\\token.ts", "packages/shared/**"), true);
  assert.equal(matchesPathGlob("packages/shared/token.ts", "packages/auth/**"), false);
  assert.equal(matchesPathGlob("src/a.test.ts", "src/*.test.ts"), true);
});
