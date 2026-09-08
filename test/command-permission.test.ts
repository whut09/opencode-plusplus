import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommandFinding, summarizeCommandFindings } from "../src/integrations/opencode/command-permission.js";

test("command finding classification keeps ordinary warnings allowed", () => {
  assert.deepEqual(classifyCommandFinding({ kind: "protected_path", severity: "warning", rule: "dependency-build-output-uncertain" }), {
    disposition: "allowed",
    authority: "none"
  });
});

test("command finding classification sends consent decisions to OpenCode", () => {
  assert.deepEqual(classifyCommandFinding({ kind: "approval_required", severity: "warning" }), {
    disposition: "approval-required",
    authority: "opencode-permission"
  });
  assert.deepEqual(classifyCommandFinding({ kind: "external_path", severity: "warning" }), {
    disposition: "approval-required",
    authority: "opencode-permission"
  });
});

test("policy blocks take precedence over native approval", () => {
  assert.deepEqual(
    summarizeCommandFindings([
      { kind: "approval_required", severity: "warning" },
      { kind: "dangerous_command", severity: "blocker" }
    ]),
    { disposition: "policy-blocked", allowed: false, approvalRequired: false }
  );
});

test("approval-only results remain executable by the host permission layer", () => {
  assert.deepEqual(summarizeCommandFindings([{ kind: "approval_required", severity: "warning" }]), {
    disposition: "approval-required",
    allowed: true,
    approvalRequired: true
  });
});
