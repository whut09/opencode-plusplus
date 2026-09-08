import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPackage, IndexedFile, TaskPack } from "../core/types.js";
import { buildChangeImpactReport, renderChangeImpactReport } from "./impact.js";
import { bullet, code, heading, table } from "./renderers/markdown.js";
import { buildTaskPack, renderTaskContext, type TaskContextOptions } from "./task-context.js";
import { renderTaskPlan, renderTaskVerify } from "./task-harness.js";
import { buildTestSelection, renderTestSelection } from "./test-selector.js";
import { executionTracePath, startExecutionTrace } from "../harness/observability/execution-trace.js";
import { initialRunState, writeRunState } from "./runtime-state.js";
import { buildRegressionReport, renderRegressionReport } from "../harness/verification-plane/guards/regression.js";
import { taskSlug } from "../core/task-id.js";
import { buildVerificationPlan, renderVerificationPlan } from "../core/verification/planner.js";
import type { VerificationPlan } from "../core/verification/types.js";

export interface TaskRunOptions extends TaskContextOptions {
  base?: string;
  preserveTrace?: boolean;
}

export interface TaskRunWriteResult {
  runId: string;
  dir: string;
  files: string[];
  manifest: TaskRunManifest;
}

export interface TaskRunManifest {
  id: string;
  task: string;
  type: TaskPack["type"];
  mustInspect: string[];
  contextFiles?: string[];
  allowedEditGlobs: string[];
  avoidEditGlobs: string[];
  relatedTests: string[];
  requiredCommands: string[];
  requiredRegressionTests: string[];
  regressionMatches: string[];
  riskLevel: "low" | "medium" | "high";
  contextBudget: {
    maxTokens: number;
    usedTokens: number;
  };
  impact: {
    base: string;
    changedFiles: string[];
    directDependents: string[];
    transitiveDependents: string[];
    risk: string;
  };
  testSelection: {
    minimalTests: string[];
    recommendedRegressionTests: string[];
    fullConfidenceCommands: string[];
  };
  verification?: VerificationPlan;
  traceFile: string;
  files: string[];
}

export function writeTaskRun(context: ContextPackage, task: string, options: TaskRunOptions = {}): TaskRunWriteResult {
  const pack = buildTaskPack(context, task, options);
  const runId = taskSlug(task);
  const runDir = path.join(context.scan.root, ".agent-context", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const base = options.base ?? "main";
  const allowedEditGlobs = allowedEditGlobsFor(pack);
  const avoidEditGlobs = avoidEditGlobsFor(context, pack);
  const testSelectionTargets = pack.files.filter((file) => file.category === "direct-source" || file.category === "entrypoint").map((file) => file.path);
  const testSelection = buildTestSelection(context, { forPaths: testSelectionTargets, base });
  const verification = buildVerificationPlan(context, { changedFiles: testSelectionTargets });
  const impact = buildChangeImpactReport(context, { base });
  const regression = buildRegressionReport(context, { base, task });
  const manifest = buildTaskRunManifest(context, pack, {
    runId,
    base,
    allowedEditGlobs,
    avoidEditGlobs,
    testSelection,
    verification,
    impact,
    regression
  });
  const traceFile = executionTracePath(context.scan.root, runId);
  if (!options.preserveTrace || !existsSync(traceFile)) {
    startExecutionTrace(context.scan.root, task, { id: runId, agent: "opencode-plusplus" });
  }
  manifest.traceFile = path.relative(context.scan.root, traceFile).replaceAll("\\", "/");
  const stateFile = writeRunState(context.scan.root, initialRunState(context, runId, task));

  const outputs: Array<[string, string]> = [
    ["plan.md", renderTaskPlan(context, task, options)],
    ["pack.md", renderTaskContext(context, task, options)],
    ["edit-boundary.md", renderEditBoundary(manifest)],
    ["expected-diff.md", renderExpectedDiff(context, pack, manifest)],
    ["tests.md", renderTestSelection(context, { forPaths: testSelectionTargets, base })],
    ["verification-plan.md", renderVerificationPlan(verification)],
    ["verify.md", renderTaskVerify(context, { base, diff: true })],
    ["regression.md", renderRegressionReport(regression)],
    ["impact.md", renderChangeImpactReport(context, { base })],
    ["prompt.opencode.md", renderAgentPrompt("OpenCode", manifest)],
    ["prompt.codex.md", renderAgentPrompt("Codex", manifest)],
    ["prompt.claude.md", renderAgentPrompt("Claude Code", manifest)],
    ["prompt.cursor.md", renderAgentPrompt("Cursor", manifest)],
    ["run.json", `${JSON.stringify(manifest, null, 2)}\n`]
  ];

  const files = outputs.map(([name, content]) => {
    const filePath = path.join(runDir, name);
    writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    return filePath;
  });

  manifest.files = [
    ...files.map((filePath) => path.relative(context.scan.root, filePath).replaceAll("\\", "/")),
    manifest.traceFile,
    path.relative(context.scan.root, stateFile).replaceAll("\\", "/")
  ];
  writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { runId, dir: runDir, files: [...files, stateFile], manifest };
}

function buildTaskRunManifest(
  context: ContextPackage,
  pack: TaskPack,
  options: {
    runId: string;
    base: string;
    allowedEditGlobs: string[];
    avoidEditGlobs: string[];
    testSelection: ReturnType<typeof buildTestSelection>;
    verification: VerificationPlan;
    impact: ReturnType<typeof buildChangeImpactReport>;
    regression: ReturnType<typeof buildRegressionReport>;
  }
): TaskRunManifest {
  const mustInspect = mustInspectFor(pack);
  const requiredCommands = dedupe([
    ...options.verification.commands.map((command) => command.command),
    ...options.impact.requiredVerification,
    ...options.regression.requiredTests
  ]);
  return {
    id: options.runId,
    task: pack.task,
    type: pack.type,
    mustInspect,
    contextFiles: dedupe(pack.files.map((file) => file.path)),
    allowedEditGlobs: options.allowedEditGlobs,
    avoidEditGlobs: options.avoidEditGlobs,
    relatedTests: dedupe([...options.testSelection.minimalTests, ...options.testSelection.recommendedRegressionTests]),
    requiredCommands,
    requiredRegressionTests: options.regression.requiredTests,
    regressionMatches: options.regression.matches.map((match) => match.id),
    riskLevel: taskRiskLevel(context, pack, options.impact.risk),
    contextBudget: {
      maxTokens: pack.tokenBudget,
      usedTokens: pack.estimatedTokens
    },
    impact: {
      base: options.base,
      changedFiles: options.impact.changedFiles,
      directDependents: options.impact.directDependents,
      transitiveDependents: options.impact.transitiveDependents,
      risk: options.impact.risk
    },
    testSelection: {
      minimalTests: options.testSelection.minimalTests,
      recommendedRegressionTests: options.testSelection.recommendedRegressionTests,
      fullConfidenceCommands: options.testSelection.fullConfidenceCommands
    },
    verification: options.verification,
    traceFile: "",
    files: []
  };
}

function renderEditBoundary(manifest: TaskRunManifest): string {
  return [
    heading(1, "Edit Boundary"),
    "",
    heading(2, "Allowed edit globs"),
    bullet(manifest.allowedEditGlobs.map(code)),
    "",
    heading(2, "Avoid edit globs"),
    bullet(manifest.avoidEditGlobs.map(code)),
    "",
    heading(2, "Must inspect before editing"),
    bullet(manifest.mustInspect.map(code)),
    "",
    heading(2, "Rule"),
    "Edit only inside the allowed boundary unless the task cannot be completed otherwise. If an avoided path is necessary, explain why before editing it."
  ].join("\n");
}

function renderExpectedDiff(context: ContextPackage, pack: TaskPack, manifest: TaskRunManifest): string {
  const fileMap = new Map(context.index.files.map((file) => [file.path, file]));
  const expected = pack.files.filter((file) => file.category === "direct-source" || file.category === "entrypoint");
  return [
    heading(1, "Expected Diff"),
    "",
    "This run does not edit code. It predicts the likely edit surface for the agent task.",
    "",
    table(
      ["Path", "Module", "Category", "Why"],
      expected.map((file) => [code(file.path), fileMap.get(file.path)?.moduleName ?? "unknown", file.category, file.reasons.join(", ").replace(/\|/g, "\\|")])
    ),
    "",
    heading(2, "Expected validation"),
    bullet(manifest.requiredCommands.map(code))
  ].join("\n");
}

function renderAgentPrompt(agent: "OpenCode" | "Codex" | "Claude Code" | "Cursor", manifest: TaskRunManifest): string {
  const agentNote =
    agent === "Claude Code"
      ? "If this repository uses `CLAUDE.md`, treat it as the tool-specific wrapper and keep this run directory as the source of task evidence."
      : agent === "Cursor"
        ? "Use this run directory as the task rule source before opening broad repository context."
        : agent === "OpenCode"
          ? "Use this run directory as the primary OpenCode++ task context before opening broad repository context."
          : "Use this run directory as the primary task context before loading broader `.agent-context` files.";

  return [
    heading(1, `${agent} Task Prompt`),
    "",
    `Task: ${manifest.task}`,
    `Task type: ${manifest.type}`,
    `Risk level: ${manifest.riskLevel}`,
    "",
    agentNote,
    "",
    heading(2, "Read first"),
    bullet(["plan.md", "edit-boundary.md", "pack.md", "tests.md", "verification-plan.md", "regression.md", "impact.md"].map(code)),
    "",
    heading(2, "Must inspect"),
    bullet(manifest.mustInspect.map(code)),
    "",
    heading(2, "Edit boundary"),
    bullet(manifest.allowedEditGlobs.map(code)),
    "",
    heading(2, "Avoid unless necessary"),
    bullet(manifest.avoidEditGlobs.map(code)),
    "",
    heading(2, "Required verification"),
    bullet(manifest.requiredCommands.map(code)),
    "",
    heading(2, "Required regression tests"),
    bullet(manifest.requiredRegressionTests.map(code)),
    "",
    "Before editing, state the files you intend to touch. After editing, update tests when needed and run the required verification commands."
  ].join("\n");
}

function mustInspectFor(pack: TaskPack): string[] {
  const direct = pack.readFirst.map((file) => file.path);
  const relatedTests = pack.files
    .filter((file) => file.category === "test" && file.reasons.some((reason) => /related test|required regression test/i.test(reason)))
    .map((file) => file.path);
  return dedupe([...direct, ...relatedTests]).slice(0, 12);
}

function allowedEditGlobsFor(pack: TaskPack): string[] {
  const allowed = pack.files
    .filter((file) => file.category === "direct-source" || file.category === "entrypoint" || file.category === "test")
    .map((file) => file.path);
  return dedupe(allowed).slice(0, 24);
}

function avoidEditGlobsFor(context: ContextPackage, pack: TaskPack): string[] {
  const selected = new Set(pack.files.map((file) => file.path));
  const avoid = ["dist/**", "node_modules/**", ".agent-context/**", "**/*.lock", "package-lock.json"];
  if (context.scan.migrationFiles.some((file) => !selected.has(file))) avoid.push("**/migrations/**", "**/schema/**");
  if (context.scan.configFiles.some((file) => !selected.has(file))) avoid.push(".github/**", "Dockerfile", "docker-compose*.yml", "*.service");
  return dedupe(avoid);
}

function taskRiskLevel(context: ContextPackage, pack: TaskPack, impactRisk: string): "low" | "medium" | "high" {
  if (impactRisk === "High") return "high";
  if (impactRisk === "Medium") return "medium";

  const fileMap = new Map(context.index.files.map((file) => [file.path, file]));
  const selected = pack.files.map((file) => fileMap.get(file.path)).filter((file): file is IndexedFile => Boolean(file));
  if (selected.some((file) => file.importanceScore >= 65) || pack.files.length > 16) return "high";
  if (selected.some((file) => file.importanceScore >= 40) || pack.retrieval.dependencyNeighbors > 0 || pack.retrieval.tests > 0) return "medium";
  return "low";
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
