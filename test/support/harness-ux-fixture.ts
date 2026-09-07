import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "../../src/core/git.js";
import { createOpenCodePlusPlusSidecar } from "../../src/integrations/opencode/plugin-runtime/index.js";
import {
  createHarnessUxMetrics,
  instrumentHarnessTools,
  observeRuntimeTrace,
  recordVerificationCommand,
  type HarnessToolLike,
  type HarnessUxMetrics
} from "./harness-ux-metrics.js";

export interface HarnessUxRepoOptions {
  scenarioId: string;
  withTests?: boolean;
  withCheck?: boolean;
  docsOnly?: boolean;
}

export interface HarnessUxFixture {
  root: string;
  sessionId: string;
  metrics: HarnessUxMetrics;
  plugin: Record<string, unknown>;
  tools: Record<string, HarnessToolLike>;
}

export interface VerificationRun {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function createHarnessUxFixture(options: HarnessUxRepoOptions): Promise<HarnessUxFixture> {
  const root = createHarnessUxRepo(options);
  const sessionId = `${options.scenarioId}-session`;
  const plugin = await createOpenCodePlusPlusSidecar({ directory: root }, { stateFile: path.join(root, "state.json") });
  const metrics = createHarnessUxMetrics(options.scenarioId);
  const tools = instrumentHarnessTools(plugin, metrics);
  const chatMessage = plugin["chat.message"] as (input: unknown) => Promise<void>;
  await chatMessage({ sessionID: sessionId, agent: "opencode-plusplus" });
  return { root, sessionId, metrics, plugin, tools };
}

export function createHarnessUxRepo(options: HarnessUxRepoOptions): string {
  const root = mkdtempSync(path.join(tmpdir(), `opencode-plusplus-ux-${options.scenarioId}-`));
  mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  mkdirSync(path.join(root, "test", "auth"), { recursive: true });
  const scripts: Record<string, string> = {};
  if (options.withTests) scripts.test = `node -e "process.exit(process.env.BASELINE_FAIL === '1' ? 1 : 0)"`;
  if (options.withCheck) scripts.check = `node -e "process.exit(0)"`;
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ scripts }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(root, "README.md"), `# ${options.scenarioId}\n\nBaseline fixture.\n`, "utf8");
  writeFileSync(path.join(root, "src", "auth", "session.ts"), "export function loginSession() { return 'ok'; }\n", "utf8");
  writeFileSync(
    path.join(root, "src", "auth", "middleware.ts"),
    "import { loginSession } from './session.js';\nexport function authMiddleware() { return loginSession(); }\n",
    "utf8"
  );
  writeFileSync(path.join(root, "test", "auth", "session.test.ts"), "import { loginSession } from '../../src/auth/session.js';\nloginSession();\n", "utf8");
  if (options.docsOnly) writeFileSync(path.join(root, "docs.md"), "# Existing documentation\n", "utf8");
  runGit(root, ["init"]);
  runGit(root, ["checkout", "-b", "main"]);
  runGit(root, ["config", "user.email", "opencode-plusplus@example.com"]);
  runGit(root, ["config", "user.name", "OpenCode Plus Plus"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "baseline fixture"]);
  return root;
}

export async function callHarnessTool(fixture: HarnessUxFixture, name: string, args: unknown = {}): Promise<string> {
  const tool = fixture.tools[`opencode_plusplus_${name}`];
  if (!tool) throw new Error(`Harness fixture tool is unavailable: ${name}`);
  return tool.execute(args, { sessionID: fixture.sessionId, agent: "opencode-plusplus" });
}

export async function editFixtureFile(fixture: HarnessUxFixture, relativePath: string, content: string): Promise<void> {
  writeFileSync(path.join(fixture.root, relativePath), content, "utf8");
  const eventHook = fixture.plugin.event as (input: { event?: Record<string, unknown> }) => Promise<void>;
  await eventHook({
    event: {
      type: "file.edited",
      sessionID: fixture.sessionId,
      properties: { file: relativePath }
    }
  });
}

export async function runAndRecordVerification(
  fixture: HarnessUxFixture,
  options: { fail?: boolean; command?: "npm test" | "npm run check" } = {}
): Promise<VerificationRun> {
  const command = options.command ?? "npm test";
  const result = runNpmScript(fixture.root, command, options.fail === true);
  const callId = `${fixture.metrics.scenarioId}-${fixture.metrics.verificationCommands + 1}`;
  const before = fixture.plugin["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>;
  const after = fixture.plugin["tool.execute.after"] as (input: unknown, output: unknown) => Promise<void>;
  const input = { tool: "shell", sessionID: fixture.sessionId, callID: callId };
  await before(input, { args: { command } });
  await after(input, { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, args: { command } });
  recordVerificationCommand(fixture.metrics, command, result.exitCode);
  return result;
}

export function finishHarnessUxFixture(fixture: HarnessUxFixture): HarnessUxMetrics {
  observeRuntimeTrace(fixture.metrics, fixture.root);
  return fixture.metrics;
}

export function cleanupHarnessUxFixture(fixture: HarnessUxFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

function runNpmScript(root: string, command: string, fail: boolean): VerificationRun {
  const parts = command.split(/\s+/);
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(executable, parts.slice(1), {
    cwd: root,
    env: { ...process.env, ...(fail ? { BASELINE_FAIL: "1" } : {}) },
    encoding: "utf8"
  });
  return {
    command,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function readFixtureFile(fixture: HarnessUxFixture, relativePath: string): string {
  return readFileSync(path.join(fixture.root, relativePath), "utf8");
}
