import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContextPackage } from "../src/core/context-builder.js";
import { resolveGitBase, runGit } from "../src/core/git.js";
import { getOpenCodePlusplusPackageVersion } from "../src/core/package-info.js";
import { writeContextPackage } from "../src/outputs/renderers/writer.js";
import { runOpenCodePlusplusDoctor } from "../src/cli/opencode-plusplus-commands.js";
import { exitCodeFromOutput, hashText, outputText } from "../src/integrations/opencode/plugin-runtime/evidence.js";
import { commandFromTool, pathsFromTool } from "../src/integrations/opencode/plugin-runtime/paths.js";
import {
  checkOpencodeSidecarCommand,
  recordOpencodeSidecarTool,
  renderOpencodeSidecarCommandCheck,
  verifyOpencodeSidecar,
  writeOpencodeSidecarLatest
} from "../src/integrations/opencode/sidecar.js";
import { readExecutionTrace } from "../src/harness/observability/execution-trace.js";

test("OpenCode sidecar runtime extracts commands, paths, output, and hashes", () => {
  assert.equal(commandFromTool("bash", { input: "npm test" }), "npm test");
  assert.equal(commandFromTool("write", { command: "node test.js" }), "node test.js");
  assert.equal(commandFromTool("edit", { input: "not a command" }), null);
  assert.deepEqual(pathsFromTool({ path: "src/a.ts", filePath: "src/b.ts", files: ["test/a.test.ts", 1] }), ["src/a.ts", "src/b.ts", "test/a.test.ts"]);
  assert.equal(exitCodeFromOutput({ properties: { status: "2" } }), 2);
  assert.equal(exitCodeFromOutput({ exitCode: 0 }), 0);
  assert.equal(exitCodeFromOutput({ properties: { stdout: "ok" } }), null);
  assert.equal(outputText({ properties: { stdout: "ok" } }, ["stdout"]), "ok");
  assert.match(hashText("ok"), /^[a-f0-9]{64}$/);
});

test("sidecar base resolution falls back to HEAD when main is unavailable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-git-base-"));
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "trunk"]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    assert.equal(resolveGitBase(root), "HEAD");
    assert.equal(resolveGitBase(root, "trunk"), "trunk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode++ doctor reports CLI/plugin version consistency", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-doctor-version-"));
  const bin = path.join(root, "bin");
  const oldPath = process.env.PATH;
  const oldConfigDir = process.env.OPENCODE_CONFIG_DIR;
  try {
    mkdirSync(bin, { recursive: true });
    writeFakeOpenCode(bin);
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "opencode-config");
    mkdirSync(path.join(root, ".agent-context"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    writeGlobalPluginFixture(process.env.OPENCODE_CONFIG_DIR);

    const report = await runOpenCodePlusplusDoctor(root);
    const versionCheck = report.checks.find((check) => check.id === "opencode-plusplus-version");

    assert.equal(versionCheck?.status, "pass");
    assert.equal(versionCheck?.label, "CLI/plugin version");
    const version = getOpenCodePlusplusPackageVersion();
    assert.equal(versionCheck?.details, `CLI ${version}; installed plugin ${version}`);
  } finally {
    process.env.PATH = oldPath;
    restoreEnvironment("OPENCODE_CONFIG_DIR", oldConfigDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode++ doctor treats a missing sidecar plugin as first-run warning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-doctor-first-run-"));
  const bin = path.join(root, "bin");
  const oldPath = process.env.PATH;
  const oldConfigDir = process.env.OPENCODE_CONFIG_DIR;
  try {
    mkdirSync(bin, { recursive: true });
    writeFakeOpenCode(bin);
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "missing-opencode-config");
    mkdirSync(path.join(root, ".agent-context"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    const report = await runOpenCodePlusplusDoctor(root);

    assert.equal(report.checks.filter((check) => check.id.startsWith("sidecar-") && check.status === "fail").length, 0);
    assert.equal(report.checks.find((check) => check.id === "opencode-plusplus-version")?.status, "warn");
    assert.equal(report.checks.find((check) => check.id === "sidecar-plugin")?.status, "warn");
    assert.equal(report.checks.find((check) => check.id === "sidecar-hooks")?.status, "warn");
    assert.match(report.checks.find((check) => check.id === "sidecar-plugin")?.details ?? "", /Windows OpenCode\+\+ installer/);
  } finally {
    process.env.PATH = oldPath;
    restoreEnvironment("OPENCODE_CONFIG_DIR", oldConfigDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar records tool execution evidence into event logs and traces", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-sidecar-record-tool-"));
  try {
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
    runGit(root, ["commit", "-m", "initial"]);
    writeFileSync(path.join(root, "src.ts"), "export const value = 1;\n", "utf8");

    const result = recordOpencodeSidecarTool(root, {
      eventId: "tool.execute.after:call-123",
      tool: "bash",
      command: "npm run test",
      exitCode: 0,
      startedAt: "2026-06-19T10:00:00.000Z",
      finishedAt: "2026-06-19T10:00:01.000Z",
      stdout: "ok\n",
      stderr: "",
      workingTreeHashBefore: "a".repeat(64),
      workingTreeHashAfter: "b".repeat(64),
      sessionId: "session-123",
      paths: ["src.ts"]
    });
    const replay = recordOpencodeSidecarTool(root, {
      eventId: "tool.execute.after:call-123",
      tool: "bash",
      command: "npm run test",
      exitCode: 0,
      startedAt: "2026-06-19T10:00:00.000Z",
      finishedAt: "2026-06-19T10:00:01.000Z",
      stdout: "ok\n",
      stderr: "",
      workingTreeHashBefore: "a".repeat(64),
      workingTreeHashAfter: "b".repeat(64),
      sessionId: "session-123",
      paths: ["src.ts"]
    });

    assert.equal(existsSync(result.eventLogPath), true);
    assert.match(readFileSync(result.eventLogPath, "utf8"), /tool\.execute\.after/);
    assert.equal(
      readFileSync(result.eventLogPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes('"eventId":"tool.execute.after:call-123"')).length,
      1
    );
    assert.equal(typeof result.event.eventId, "string");
    assert.equal(result.event.sequence, 1);
    assert.equal(result.event.schemaVersion, 1);
    assert.equal(typeof result.event.timestamp, "string");
    assert.equal(path.basename(result.tracePath), "opencode-session-session-123.json");
    const trace = readExecutionTrace(root, result.traceId);
    const step = trace?.steps.at(-1);
    assert.equal(trace?.agent, "opencode");
    assert.equal(step?.action, "run-test");
    assert.equal(step?.command, "npm run test");
    assert.equal(step?.evidenceSource, "command");
    assert.equal(step?.capturedBy, "opencode-plusplus");
    assert.equal(step?.exitCode, 0);
    assert.equal(step?.startedAt, "2026-06-19T10:00:00.000Z");
    assert.equal(step?.finishedAt, "2026-06-19T10:00:01.000Z");
    assert.match(step?.stdoutHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(step?.stderrHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(step?.stdoutPreview, "ok\n");
    assert.equal(step?.stdoutTruncated, false);
    assert.equal(step?.stdoutRedacted, false);
    assert.equal(step?.workingTreeHashBefore, "a".repeat(64));
    assert.equal(step?.workingTreeHashAfter, "b".repeat(64));
    assert.ok(step?.files.includes("src.ts"));
    assert.equal(replay.event.sequence, result.event.sequence);
    assert.equal(replay.trace.steps.filter((candidate) => candidate.eventId === "tool.execute.after:call-123").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar records unknown exit code and sanitized output evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-sidecar-record-tool-safe-"));
  try {
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
    runGit(root, ["commit", "-m", "initial"]);

    const result = recordOpencodeSidecarTool(root, {
      tool: "bash",
      command: "npm run test",
      stdout: `TOKEN=super-secret-token-value\n${"x".repeat(1000)}`,
      stderr: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      startedAt: "2026-06-19T10:00:00.000Z",
      finishedAt: "2026-06-19T10:00:01.000Z"
    });

    assert.equal(result.event.exitCode, null);
    assert.equal(result.step.result, "unknown");
    assert.notEqual(result.step.stdoutHash, undefined);
    assert.doesNotMatch(result.step.stdoutPreview ?? "", /super-secret-token-value/);
    assert.match(result.step.stdoutPreview ?? "", /\[REDACTED_SECRET\]/);
    assert.equal(result.step.stdoutRedacted, true);
    assert.equal(result.step.stdoutTruncated, true);
    assert.doesNotMatch(result.step.stderrPreview ?? "", /abcdefghijklmnopqrstuvwxyz012345/);
    assert.equal(result.step.stderrRedacted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar verify checks plugin hooks, event log readiness, and guard stack", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-sidecar-verify-"));
  try {
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
    runGit(root, ["commit", "-m", "initial"]);
    writeContextPackage(await buildContextPackage(root));
    runGit(root, ["add", ".agent-context", "AGENTS.md"]);
    runGit(root, ["commit", "-m", "add generated context"]);
    writeFileSync(path.join(root, "src.ts"), "export const value = 1;\n", "utf8");

    const report = await verifyOpencodeSidecar(root, { pluginInstalled: true });

    assert.equal(report.ok, false);
    assert.equal(report.guardStack.ran, true);
    assert.equal(report.guardStack.contracts?.passed, true);
    assert.equal(report.guardStack.hallucination?.errors, 0);
    assert.equal(report.guardStack.regression?.matches, 0);
    assert.equal(report.guardStack.impact?.risk, "Low");
    assert.equal(typeof report.guardStack.tests?.fullConfidenceCommands, "number");
    assert.equal(report.guardStack.verification?.classification, "source-local");
    assert.equal(report.guardStack.verification?.codeTestRequired, true);
    assert.equal(report.guardStack.policy?.passed, false);
    assert.match(report.blockers.join("\n"), /Policy required evidence missing/);
    assert.equal(report.checks.find((check) => check.name === "global-plugin")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "plugin-source")?.status, "pass");
    assert.equal(report.checks.find((check) => check.name === "sidecar-event-log")?.status, "warn");
    writeOpencodeSidecarLatest(report);
    assert.equal(existsSync(path.join(root, ".agent-context", "sidecar", "latest.json")), true);
    assert.equal(existsSync(path.join(root, ".agent-context", "sidecar", "latest.md")), true);
    assert.match(readFileSync(path.join(root, ".agent-context", "sidecar", "latest.md"), "utf8"), /Guard Stack/);
    const latest = readFileSync(path.join(root, ".agent-context", "sidecar", "latest.md"), "utf8");
    assert.match(latest, /Intervention Summary/);
    assert.match(latest, /Verified Fixes/);
    assert.match(latest, /Remaining Problems/);
    assert.match(latest, /Human Review/);
    assert.match(latest, /Context Help/);
    assert.match(latest, /Context Advice Rejected/);
    assert.equal(existsSync(path.join(root, ".agent-context", "sidecar", "policy.md")), true);
    assert.equal(existsSync(path.join(root, ".agent-context", "sidecar", "task-verify.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar command guard blocks unknown scripts and protected paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-command-guard-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    writeFileSync(path.join(root, "Makefile"), "build:\n\t@echo build\n", "utf8");

    assert.equal(checkOpencodeSidecarCommand(root, { command: "npm run test" }).allowed, true);
    const missingScript = checkOpencodeSidecarCommand(root, { command: "npm run hallucinated" });
    assert.equal(missingScript.allowed, false);
    assert.match(missingScript.findings[0]?.message ?? "", /Unknown package script/);

    assert.equal(checkOpencodeSidecarCommand(root, { command: "make build" }).allowed, true);
    assert.equal(checkOpencodeSidecarCommand(root, { command: "make deploy-prod" }).allowed, false);

    const protectedPath = checkOpencodeSidecarCommand(root, { command: "path-check", paths: [".agent-context/repo-summary.md", ".env"] });
    assert.equal(protectedPath.allowed, false);
    assert.match(protectedPath.findings.map((finding) => finding.kind).join(","), /protected_path/);
    assert.match(protectedPath.findings.map((finding) => finding.kind).join(","), /secret_path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar command guard blocks dangerous shell commands", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-command-danger-"));
  try {
    const result = checkOpencodeSidecarCommand(root, { command: "git reset --hard HEAD" });
    assert.equal(result.allowed, false);
    assert.equal(result.findings[0]?.kind, "dangerous_command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar command guard lists existing scripts for unknown npm scripts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-command-script-list-"));
  try {
    const scripts = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`script-${index}`, "node -e 1"]));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts }), "utf8");

    const result = checkOpencodeSidecarCommand(root, { command: "npm run hallucinated" });
    const rendered = renderOpencodeSidecarCommandCheck(result);

    assert.equal(result.allowed, false);
    assert.match(result.findings[0]?.doInstead ?? "", /script-0, script-1, script-10/);
    assert.match(result.findings[0]?.doInstead ?? "", /\+3 more/);
    assert.doesNotMatch(result.findings[0]?.doInstead ?? "", /script-7/);
    assert.match(rendered, /BLOCKED: Unknown package script/);
    assert.match(rendered, /Evidence: npm run hallucinated/);
    assert.match(rendered, /Do instead:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar command guard gives rm -rf a concrete Do instead action", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-command-rm-"));
  try {
    const result = checkOpencodeSidecarCommand(root, { command: "rm -rf /" });
    const rendered = renderOpencodeSidecarCommandCheck(result);

    assert.equal(result.allowed, false);
    assert.equal(result.findings[0]?.kind, "dangerous_command");
    assert.match(result.findings[0]?.doInstead ?? "", /Remove specific files/);
    assert.match(rendered, /BLOCKED: Destructive recursive remove/);
    assert.match(rendered, /Evidence: rm -rf \//);
    assert.match(rendered, /Do instead:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar command guard states the rule for protected paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-command-rule-"));
  try {
    const generated = checkOpencodeSidecarCommand(root, { command: "path-check", paths: [".agent-context/repo-summary.md"] });
    assert.equal(generated.allowed, false);
    assert.equal(generated.findings[0]?.rule, "generated-context");
    assert.match(generated.findings[0]?.doInstead ?? "", /opencode_plusplus_prepare/);

    const secret = checkOpencodeSidecarCommand(root, { command: "path-check", paths: [".env"] });
    assert.equal(secret.allowed, false);
    assert.equal(secret.findings[0]?.rule, "secret-local-config");
    assert.match(renderOpencodeSidecarCommandCheck(secret), /Do instead:/);

    const agents = checkOpencodeSidecarCommand(root, { command: "path-check", paths: ["AGENTS.md"] });
    assert.equal(agents.allowed, false);
    assert.equal(agents.findings[0]?.rule, "generated-agents-md");
    assert.match(agents.findings[0]?.doInstead ?? "", /AGENTS\.manual\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar command guard treats uncertain path arguments as warnings", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-command-uncertain-"));
  try {
    const result = checkOpencodeSidecarCommand(root, { command: "node build.js --out=dist/index.js" });
    const rendered = renderOpencodeSidecarCommandCheck(result);

    assert.equal(result.allowed, true, "uncertain arguments must not block");
    assert.equal(result.findings[0]?.severity, "warning");
    assert.equal(result.findings[0]?.rule, "dependency-build-output-uncertain");
    assert.match(rendered, /WARNING: Uncertain dependency\/build path argument/);
    assert.match(rendered, /Do instead:/);

    const clearOutput = checkOpencodeSidecarCommand(root, { command: "path-check", paths: ["dist/index.js"] });
    assert.equal(clearOutput.allowed, false);
    assert.equal(clearOutput.findings[0]?.rule, "dependency-build-output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode sidecar verify detects generated context blockers from current diff", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-sidecar-blocker-"));
  try {
    runGit(root, ["init"]);
    runGit(root, ["checkout", "-b", "main"]);
    mkdirSync(path.join(root, ".agent-context", "traces"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 1" } }), "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
    runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
    runGit(root, ["commit", "-m", "initial"]);

    writeFileSync(path.join(root, ".agent-context", "repo-summary.md"), "stale generated change\n", "utf8");
    const report = await verifyOpencodeSidecar(root, { pluginInstalled: true });

    assert.equal(report.ok, false);
    assert.deepEqual(report.changedFiles, [".agent-context/repo-summary.md"]);
    assert.match(report.blockers.join("\n"), /Policy required evidence missing|Policy forbidden failures|Contract violations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFakeOpenCode(bin: string): void {
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "opencode.cmd"), '@echo off\r\nif "%1"=="--version" echo opencode 0.0.0-test& exit /b 0\r\nexit /b 0\r\n', "utf8");
    return;
  }

  const script = path.join(bin, "opencode");
  writeFileSync(script, ["#!/usr/bin/env sh", 'if [ "$1" = "--version" ]; then echo "opencode 0.0.0-test"; exit 0; fi', "exit 0"].join("\n"), "utf8");
  chmodSync(script, 0o755);
}

function writeGlobalPluginFixture(configDir: string): void {
  const now = "2026-08-17T00:00:00.000Z";
  const version = getOpenCodePlusplusPackageVersion();
  mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  mkdirSync(path.join(configDir, "opencode-plusplus"), { recursive: true });
  writeFileSync(path.join(configDir, "plugins", "opencode-plusplus.js"), "module.exports = async () => ({});\n", "utf8");
  writeFileSync(
    path.join(configDir, "opencode-plusplus", "state.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, enabled: true, version, installedAt: now, updatedAt: now }),
    "utf8"
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
