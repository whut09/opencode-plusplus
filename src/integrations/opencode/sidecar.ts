import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../../core/atomic-store.js";
import { collectWorkingTreeFiles, resolveGitBase, runGit } from "../../core/git.js";
import type { ExecutionTrace, ExecutionTraceStep } from "../../harness/observability/execution-trace.js";
import type { ChangeImpactReport } from "../../outputs/impact.js";
import { renderCommandCheck, renderLatestMarkdown, renderToolRecord, renderVerifyReport } from "./sidecar-report-renderer.js";
import { isGeneratedSidecarOutput, isSecretLike } from "./sidecar-path-guard.js";
import { recordSidecarTool } from "./sidecar-evidence-recorder.js";
import { checkSidecarCommand } from "./sidecar-command-guard.js";
import { blockersFromGuardStack, runSidecarIncrementalVerifier, warningsFromGuardStack } from "./sidecar-incremental-verifier.js";
import { defaultOpenCodePlusPlusPluginFile } from "./plugin-runtime/state.js";
import { pluginInterventionSnapshot } from "./plugin-runtime/harness/interventions.js";
import { readPluginEvaluateState, readPluginHarnessSession } from "./plugin-runtime/harness/session.js";
import type { OpenCodeSidecarCommandAuthority, OpenCodeSidecarCommandDisposition } from "./command-permission.js";

export interface OpenCodeSidecarVerifyOptions {
  pluginPath?: string;
  pluginInstalled?: boolean;
}

export const OPENCODE_SIDECAR_PLUGIN_PATH = ".opencode/plugins/opencode-plusplus.ts";

export interface OpenCodeSidecarVerifyCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  details: string;
}

export interface OpenCodeSidecarVerifyResult {
  repo: string;
  ok: boolean;
  pluginPath: string;
  eventLogPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
  generatedAt: string;
  changedFiles: string[];
  blockers: string[];
  warnings: string[];
  checks: OpenCodeSidecarVerifyCheck[];
  guardStack: OpenCodeSidecarGuardStackSummary;
  interventions?: import("./plugin-runtime/harness/types.js").PluginInterventionSnapshot;
}

export interface OpenCodeSidecarGuardStackSummary {
  ran: boolean;
  passed: boolean;
  base: string;
  artifacts: {
    policyMarkdown?: string;
    taskVerifyMarkdown?: string;
  };
  contracts?: {
    passed: boolean;
    violations: number;
  };
  hallucination?: {
    errors: number;
    warnings: number;
  };
  regression?: {
    matches: number;
    missingRequiredTestEvidence: number;
  };
  impact?: {
    risk: ChangeImpactReport["risk"];
    changedFiles: number;
    relatedTests: number;
  };
  tests?: {
    minimalCommands: number;
    recommendedCommands: number;
    fullConfidenceCommands: number;
  };
  verification?: {
    classification: string;
    commands: number;
    codeTestRequired: boolean;
    verificationRequired: boolean;
  };
  policy?: {
    passed: boolean;
    forbidden: number;
    requiredMissing: number;
    risks: number;
  };
  error?: string;
}

export interface OpenCodeSidecarCommandFinding {
  kind:
    | "dangerous_command"
    | "unknown_script"
    | "unknown_make_target"
    | "unknown_pyproject_script"
    | "protected_path"
    | "secret_path"
    | "approval_required"
    | "external_path";
  severity: "blocker" | "warning";
  message: string;
  evidence: string[];
  doInstead?: string;
  rule?: string;
  disposition?: OpenCodeSidecarCommandDisposition;
  authority?: OpenCodeSidecarCommandAuthority;
}

export interface OpenCodeSidecarCommandCheckResult {
  repo: string;
  command: string | null;
  paths: string[];
  disposition: OpenCodeSidecarCommandDisposition;
  allowed: boolean;
  approvalRequired: boolean;
  findings: OpenCodeSidecarCommandFinding[];
}

export interface OpenCodeSidecarToolRecordInput {
  tool?: string;
  command?: string;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string;
  stdout?: string;
  stderr?: string;
  stdoutHash?: string;
  stderrHash?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutRedacted?: boolean;
  stderrRedacted?: boolean;
  workingTreeHashBefore?: string;
  workingTreeHashAfter?: string;
  sessionId?: string;
  taskId?: string;
  source?: "desktop-hook" | "cli" | "ci" | "manual";
  paths?: string[];
  eventId?: string;
}

export interface OpenCodeSidecarToolRecordResult {
  repo: string;
  eventLogPath: string;
  traceId: string;
  tracePath: string;
  event: {
    schemaVersion: 1;
    eventId: string;
    sequence: number;
    timestamp: string;
    type: "tool.execute.after";
    ts: string;
    tool: string;
    command: string | null;
    exitCode: number | null;
    startedAt: string;
    finishedAt: string;
    stdoutHash: string;
    stderrHash: string;
    stdoutPreview: string;
    stderrPreview: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    stdoutRedacted: boolean;
    stderrRedacted: boolean;
    workingTreeHashBefore: string;
    workingTreeHashAfter: string;
    filesTouched: string[];
    sessionId: string;
    taskId: string | null;
    source: "desktop-hook" | "cli" | "ci" | "manual";
  };
  trace: ExecutionTrace;
  step: ExecutionTraceStep;
}

export async function verifyOpencodeSidecar(repo = ".", options: OpenCodeSidecarVerifyOptions = {}): Promise<OpenCodeSidecarVerifyResult> {
  const root = path.resolve(repo);
  const globalPluginPath = defaultOpenCodePlusPlusPluginFile();
  const globalPluginInstalled = options.pluginInstalled ?? (!options.pluginPath && existsSync(globalPluginPath));
  const pluginPath = options.pluginPath
    ? path.resolve(options.pluginPath)
    : globalPluginInstalled
      ? globalPluginPath
      : path.join(root, OPENCODE_SIDECAR_PLUGIN_PATH);
  const eventLogPath = path.join(root, ".agent-context", "traces", "opencode-sidecar-events.jsonl");
  const latestJsonPath = path.join(root, ".agent-context", "sidecar", "latest.json");
  const latestMarkdownPath = path.join(root, ".agent-context", "sidecar", "latest.md");
  const generatedAt = new Date().toISOString();
  const checks: OpenCodeSidecarVerifyCheck[] = [];

  checks.push(checkGitRepo(root));
  checks.push(checkExists(".agent-context", path.join(root, ".agent-context"), "OpenCode++ context directory exists"));
  checks.push(
    globalPluginInstalled
      ? { name: "global-plugin", status: "pass", details: "OpenCode++ global plugin is installed" }
      : checkExists(path.relative(root, pluginPath), pluginPath, "OpenCode sidecar plugin exists")
  );

  if (globalPluginInstalled) {
    checks.push({ name: "plugin-source", status: "pass", details: "plugin source is managed by the OpenCode++ user installation" });
  } else if (existsSync(pluginPath)) {
    const source = readFileSync(pluginPath, "utf8");
    checks.push(checkSource("plugin-export", source, /OpenCodePlusPlusSidecar/, "exports OpenCodePlusPlusSidecar"));
    checks.push(checkSource("file.edited hook", source, /createOpenCodePlusPlusSidecar|file\.edited/, "delegates file.edited handling to the sidecar runtime"));
    checks.push(
      checkSource("session.idle hook", source, /createOpenCodePlusPlusSidecar|session\.idle/, "delegates session.idle handling to the sidecar runtime")
    );
    checks.push(
      checkSource(
        "tool.execute.after hook",
        source,
        /createOpenCodePlusPlusSidecar|tool\.execute\.after/,
        "delegates post-tool evidence to the sidecar runtime"
      )
    );
  }

  checks.push(
    existsSync(eventLogPath)
      ? { name: "sidecar-event-log", status: "pass", details: `${path.relative(root, eventLogPath)} exists` }
      : {
          name: "sidecar-event-log",
          status: "warn",
          details: "no sidecar event log yet; start OpenCode with opencode-plusplus and trigger a session/edit first"
        }
  );

  const changedFiles = collectCurrentChangedFiles(root);
  const blockers = detectBlockers(changedFiles);
  const warnings = detectWarnings(changedFiles);
  const base = resolveGitBase(root);
  const guardStack = await runSidecarIncrementalVerifier(root, { base, changedFiles });
  const session = readPluginHarnessSession(root);
  const evaluate = session ? readPluginEvaluateState(root, session.sessionId) : readPluginEvaluateState(root);
  const interventions = session?.taskId
    ? pluginInterventionSnapshot(root, session.taskId, evaluate?.interventions?.selectedFiles ?? [], evaluate?.interventions?.excludedFiles ?? [])
    : undefined;
  blockers.push(...blockersFromGuardStack(guardStack));
  warnings.push(...warningsFromGuardStack(guardStack));
  checks.push({
    name: "current-diff",
    status: blockers.length ? "fail" : "pass",
    details: changedFiles.length ? `${changedFiles.length} changed file(s), ${blockers.length} blocker(s)` : "no source diff detected"
  });
  checks.push({
    name: "guard-stack",
    status: guardStack.passed ? "pass" : "fail",
    details: guardStack.ran
      ? `contracts/policy/impact/tests completed for base ${guardStack.base}`
      : `guard stack failed: ${guardStack.error ?? "unknown error"}`
  });

  const ok = checks.every((check) => check.status !== "fail");
  return {
    repo: root,
    ok,
    pluginPath,
    eventLogPath,
    latestJsonPath,
    latestMarkdownPath,
    generatedAt,
    changedFiles,
    blockers,
    warnings,
    checks,
    guardStack,
    interventions
  };
}

export function writeOpencodeSidecarLatest(result: OpenCodeSidecarVerifyResult): void {
  writeJsonAtomic(result.latestJsonPath, { schemaVersion: 1, revision: Date.now(), ...toPersistedSidecarResult(result) });
  writeTextAtomic(result.latestMarkdownPath, `${renderOpencodeSidecarLatestMarkdown(result)}\n`);
}

export function checkOpencodeSidecarCommand(repo = ".", input: { command?: string; paths?: string[] } = {}): OpenCodeSidecarCommandCheckResult {
  return checkSidecarCommand(repo, input);
}

export function recordOpencodeSidecarTool(repo = ".", input: OpenCodeSidecarToolRecordInput = {}): OpenCodeSidecarToolRecordResult {
  return recordSidecarTool(repo, input);
}

export function renderOpencodeSidecarCommandCheck(result: OpenCodeSidecarCommandCheckResult): string {
  return renderCommandCheck(result);
}

export function renderOpencodeSidecarToolRecord(result: OpenCodeSidecarToolRecordResult): string {
  return renderToolRecord(result);
}

export function renderOpencodeSidecarVerifyReport(result: OpenCodeSidecarVerifyResult): string {
  return renderVerifyReport(result);
}

export function renderOpencodeSidecarLatestMarkdown(result: OpenCodeSidecarVerifyResult): string {
  return renderLatestMarkdown(result);
}

function toPersistedSidecarResult(result: OpenCodeSidecarVerifyResult): Omit<
  OpenCodeSidecarVerifyResult,
  "pluginPath" | "eventLogPath" | "latestJsonPath" | "latestMarkdownPath"
> & {
  pluginPath: string;
  eventLogPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
} {
  return {
    ...result,
    pluginPath: path.relative(result.repo, result.pluginPath),
    eventLogPath: path.relative(result.repo, result.eventLogPath),
    latestJsonPath: path.relative(result.repo, result.latestJsonPath),
    latestMarkdownPath: path.relative(result.repo, result.latestMarkdownPath)
  };
}

function checkGitRepo(repo: string): OpenCodeSidecarVerifyCheck {
  try {
    const inside = runGit(repo, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
    return inside ? { name: "git", status: "pass", details: "inside git repository" } : { name: "git", status: "fail", details: "not inside git repository" };
  } catch (error) {
    return { name: "git", status: "fail", details: error instanceof Error ? error.message : String(error) };
  }
}

function checkExists(name: string, absolutePath: string, okDetails: string): OpenCodeSidecarVerifyCheck {
  return existsSync(absolutePath) ? { name, status: "pass", details: okDetails } : { name, status: "fail", details: `${absolutePath} is missing` };
}

function checkSource(name: string, source: string, pattern: RegExp, okDetails: string): OpenCodeSidecarVerifyCheck {
  return pattern.test(source) ? { name, status: "pass", details: okDetails } : { name, status: "fail", details: `${name} missing from generated plugin` };
}

function collectCurrentChangedFiles(root: string): string[] {
  try {
    return collectWorkingTreeFiles(root, true).filter((file) => !isGeneratedSidecarOutput(file));
  } catch {
    return [];
  }
}

function detectBlockers(files: string[]): string[] {
  const blockers: string[] = [];
  for (const file of files) {
    if (isSecretLike(file)) blockers.push(`Secret/local configuration path changed: ${file}`);
    if (isLockfile(file) && !hasPackageManifest(files)) blockers.push(`Lockfile changed without a package manifest change: ${file}`);
  }
  return [...new Set(blockers)];
}

function detectWarnings(files: string[]): string[] {
  const warnings: string[] = [];
  for (const file of files) {
    if (isCiOrDeploy(file)) warnings.push(`CI/deploy configuration changed: ${file}`);
    if (isMigration(file)) warnings.push(`Migration/schema file changed: ${file}`);
  }
  return [...new Set(warnings)];
}

function isLockfile(file: string): boolean {
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|poetry\.lock|Cargo\.lock|Gemfile\.lock)$/i.test(file);
}

function hasPackageManifest(files: string[]): boolean {
  return files.some((file) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|Gemfile|go\.mod)$/i.test(file));
}

function isCiOrDeploy(file: string): boolean {
  return file.startsWith(".github/workflows/") || /(^|\/)(Dockerfile|docker-compose\.ya?ml|fly\.toml|vercel\.json|netlify\.toml)$/i.test(file);
}

function isMigration(file: string): boolean {
  return /(^|\/)(migrations?|prisma|schema)\/|schema\.(sql|prisma)$/i.test(file);
}
