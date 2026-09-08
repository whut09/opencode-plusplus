import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPackage, EvidencePolicyMode, TaskType } from "../../core/types.js";
import { changedFilesSince, runGit } from "../../core/git.js";
import { assessDrift, assessFreshness } from "../../core/freshness.js";
import { buildChangeImpactReport } from "../../outputs/impact.js";
import { validateContracts } from "../../outputs/contract-validator.js";
import { currentWorkingTreeHash, readExecutionTrace } from "../observability/execution-trace.js";
import { evidenceSatisfies, type EvidenceLevel } from "../../outputs/evidence.js";
import { buildTaskPack } from "../../outputs/task-context.js";
import { buildTestSelection } from "../../outputs/test-selector.js";
import { bullet, code, heading, table } from "../../outputs/renderers/markdown.js";
import { buildRunStateSnapshot, writeRunState, type RunStateSnapshot } from "../../outputs/runtime-state.js";
import { taskSlug } from "../../core/task-id.js";
import { firstTestExecutionCommand } from "../../core/test-command.js";
import { buildVerificationPlan } from "../../core/verification/planner.js";
import { requiresSourceVerification } from "../../core/verification/classifier.js";
import type { VerificationPlan } from "../../core/verification/types.js";

export type LoopPhase = "preflight" | "after-edit" | "repair";
export type LoopStatus = "ready" | "needs-context" | "needs-repair" | "needs-validation" | "blocked";
export type LoopAction =
  | "start-agent"
  | "rebuild-context"
  | "replan"
  | "expand-context"
  | "repair-contracts"
  | "add-or-update-tests"
  | "run-tests"
  | "human-review"
  | "ready-for-review";

export interface LoopControllerOptions {
  phase?: LoopPhase;
  base?: string;
  type?: TaskType;
  tokenBudget?: number;
  traceId?: string;
  evidencePolicy?: EvidencePolicyMode;
}

export interface LoopDecision {
  action: LoopAction;
  priority: "high" | "medium" | "low";
  confidence: number;
  blocking: boolean;
  reason: string;
  signals: string[];
  command?: string;
}

export interface LoopControllerReport {
  task: string;
  phase: LoopPhase;
  base: string;
  evidencePolicy?: EvidencePolicyMode;
  status: LoopStatus;
  changedFiles: string[];
  risk: "Low" | "Medium" | "High";
  context: {
    freshness: string;
    drift: string;
    taskPackTokens: number;
    taskPackBudget: number;
  };
  trace: {
    id?: string;
    loaded: boolean;
    passedTestEvidence: LoopTraceEvidenceLevel;
    stepId?: string;
    signals: string[];
  };
  checks: {
    contracts: "passed" | "failed";
    contractViolations: number;
    minimalTests: number;
    regressionTests: number;
    impactDependents: number;
  };
  decisions: LoopDecision[];
  runtime: RunStateSnapshot;
  verification?: VerificationPlan;
}

type LoopTraceEvidenceLevel = EvidenceLevel;

export interface LoopWriteResult {
  taskId: string;
  dir: string;
  files: string[];
  report: LoopControllerReport;
}

export function buildLoopControllerReport(context: ContextPackage, task: string, options: LoopControllerOptions = {}): LoopControllerReport {
  const base = options.base ?? "main";
  const phase = options.phase ?? "after-edit";
  const evidencePolicy = options.evidencePolicy ?? context.config.evidencePolicy;
  const taskId = taskSlug(task);
  const freshness = assessFreshness(context);
  const drift = assessDrift(context);
  const contracts = validateContracts(context, { base, diff: true });
  const actionableContractViolations = contracts.violations.filter((violation) => !isGeneratedContextState(violation.file));
  const actionableContractsPassed = !actionableContractViolations.some((violation) => violation.severity === "error");
  const impact = buildChangeImpactReport(context, { base });
  const changedFiles = changedFilesForLoop(context, base);
  const verification = buildVerificationPlan(context, { changedFiles });
  const tests = buildTestSelection(context, { diff: true, base });
  const taskPack = buildTaskPack(context, task, { type: options.type ?? "auto", tokenBudget: options.tokenBudget });
  const traceEvidence = inspectTraceEvidence(
    context.scan.root,
    options.traceId,
    verification.commands.filter((command) => command.kind === "test").map((command) => command.command),
    evidencePolicy,
    requiresSourceVerification(verification.classification)
  );
  const decisions = decideNextSteps({
    task,
    phase,
    base,
    freshnessStatus: freshness.status,
    driftStatus: drift.status,
    changedFiles,
    contractsPassed: actionableContractsPassed,
    contractViolations: actionableContractViolations.length,
    impactRisk: impact.risk,
    minimalTests: tests.minimalTests.length,
    regressionTests: tests.recommendedRegressionTests.length,
    impactDependents: impact.directDependents.length + impact.transitiveDependents.length,
    minimalCommands: tests.minimalCommands,
    regressionCommands: tests.recommendedCommands,
    fullConfidenceCommands: tests.fullConfidenceCommands,
    verificationCommands: verification.commands.map((command) => command.command),
    verificationRequired: verification.verificationRequired,
    codeTestRequired: verification.codeTestRequired,
    taskPackOverBudget: taskPack.estimatedTokens > taskPack.tokenBudget,
    taskPackTokens: taskPack.estimatedTokens,
    taskPackBudget: taskPack.tokenBudget,
    passedTestEvidence: traceEvidence.passedTestEvidence,
    traceSignals: traceEvidence.signals,
    missingTestSignals: actionableContractViolations.filter((violation) => /test/i.test(`${violation.rule} ${violation.reason}`)).length
  });
  const runtime = buildRunStateSnapshot(context, {
    taskId,
    task,
    phase,
    contextFresh: freshness.status === "fresh",
    driftClean: drift.status === "clean",
    taskPackReady: true,
    editBoundaryReady: true,
    changedFiles,
    contractsPassed: actionableContractsPassed,
    contractViolations: actionableContractViolations.length,
    taskPackOverBudget: taskPack.estimatedTokens > taskPack.tokenBudget,
    impactRisk: impact.risk,
    passedTestEvidence: traceEvidence.passedTestEvidence,
    decisions
  });

  return {
    task,
    phase,
    base,
    evidencePolicy,
    status: statusFor(decisions),
    changedFiles,
    risk: impact.risk,
    context: {
      freshness: freshness.status,
      drift: drift.status,
      taskPackTokens: taskPack.estimatedTokens,
      taskPackBudget: taskPack.tokenBudget
    },
    trace: traceEvidence,
    checks: {
      contracts: actionableContractsPassed ? "passed" : "failed",
      contractViolations: actionableContractViolations.length,
      minimalTests: tests.minimalTests.length,
      regressionTests: tests.recommendedRegressionTests.length,
      impactDependents: impact.directDependents.length + impact.transitiveDependents.length
    },
    decisions,
    runtime,
    verification
  };
}

export function renderLoopControllerReport(report: LoopControllerReport): string {
  return [
    heading(1, "Loop Controller"),
    "",
    `Task: ${report.task}`,
    `Phase: ${report.phase}`,
    `Status: ${report.status}`,
    `Base: ${report.base}`,
    `Evidence policy: ${report.evidencePolicy ?? "advisory"}`,
    `Risk: ${report.risk}`,
    "",
    heading(2, "Loop Checks"),
    table(
      ["Check", "Result"],
      [
        ["Context freshness", report.context.freshness],
        ["Context drift", report.context.drift],
        ["Contracts", `${report.checks.contracts} (${report.checks.contractViolations} violation${report.checks.contractViolations === 1 ? "" : "s"})`],
        ["Minimal tests", String(report.checks.minimalTests)],
        ["Regression tests", String(report.checks.regressionTests)],
        ["Impact dependents", String(report.checks.impactDependents)],
        ["Trace loaded", report.trace.loaded ? "yes" : "no"],
        ["Passed test evidence", report.trace.passedTestEvidence],
        ["Verification plan", report.verification?.classification.primaryKind ?? "legacy selector"],
        ["Recommended commands", String(report.verification?.commands.length ?? 0)],
        ["Task pack budget", `${report.context.taskPackTokens.toLocaleString()} / ${report.context.taskPackBudget.toLocaleString()} estimated tokens`]
      ]
    ),
    "",
    heading(2, "Runtime State"),
    table(
      ["Field", "Value"],
      [
        ["State", report.runtime.state],
        ["Previous state", report.runtime.previousState ?? "none"],
        ["Last action", report.runtime.lastAction],
        ["Next action", `${report.runtime.nextAction.type}${report.runtime.nextAction.blocking ? " (blocking)" : ""}`],
        ["Missing evidence", report.runtime.missingEvidence.join(", ") || "none"]
      ]
    ),
    "",
    heading(2, "Changed Files"),
    bullet(report.changedFiles.map(code)),
    "",
    heading(2, "Next Decisions"),
    bullet(report.decisions.map(formatDecision)),
    "",
    heading(2, "Loop Rule"),
    "Do not treat generated context as the source of truth. Inspect source files before edits, then rerun this loop after changes."
  ].join("\n");
}

export function writeLoopControllerReport(context: ContextPackage, task: string, options: LoopControllerOptions = {}): LoopWriteResult {
  const report = buildLoopControllerReport(context, task, options);
  const taskId = taskSlug(task);
  const dir = path.join(context.scan.root, ".agent-context", "loops", taskId);
  mkdirSync(dir, { recursive: true });

  const files = [
    write(path.join(dir, "loop.md"), renderLoopControllerReport(report)),
    write(path.join(dir, "loop.json"), JSON.stringify(report, null, 2)),
    writeRunState(context.scan.root, report.runtime)
  ];

  return { taskId, dir, files, report };
}

function decideNextSteps(input: {
  task: string;
  phase: LoopPhase;
  base: string;
  freshnessStatus: string;
  driftStatus: string;
  changedFiles: string[];
  contractsPassed: boolean;
  contractViolations: number;
  impactRisk: "Low" | "Medium" | "High";
  minimalTests: number;
  regressionTests: number;
  impactDependents: number;
  minimalCommands: string[];
  regressionCommands: string[];
  fullConfidenceCommands: string[];
  verificationCommands: string[];
  verificationRequired: boolean;
  codeTestRequired: boolean;
  taskPackOverBudget: boolean;
  taskPackTokens: number;
  taskPackBudget: number;
  passedTestEvidence: LoopTraceEvidenceLevel;
  traceSignals: string[];
  missingTestSignals: number;
}): LoopDecision[] {
  const decisions: LoopDecision[] = [];

  if (input.freshnessStatus !== "fresh" || input.driftStatus !== "clean") {
    decisions.push(
      decision({
        action: "rebuild-context",
        priority: "high",
        confidence: 0.95,
        blocking: true,
        reason: "Generated context is missing, stale, or drifted from the current repository state.",
        signals: [`freshness: ${input.freshnessStatus}`, `drift: ${input.driftStatus}`],
        command: "opencode-plusplus update ."
      })
    );
  }

  if (input.taskPackOverBudget) {
    decisions.push(
      decision({
        action: "replan",
        priority: "medium",
        confidence: 0.84,
        blocking: true,
        reason: "The task pack exceeds its context budget; shrink or split the task before handing it to an agent.",
        signals: [`task pack tokens: ${input.taskPackTokens}`, `task pack budget: ${input.taskPackBudget}`],
        command: `opencode-plusplus plan "${input.task}" .`
      })
    );
  }

  if (!input.changedFiles.length && input.phase === "preflight") {
    decisions.push(
      decision({
        action: "start-agent",
        priority: "high",
        confidence: 0.88,
        blocking: false,
        reason: "No edits are detected yet; create a fresh task run before agent execution.",
        signals: [`phase: ${input.phase}`, "changed files: 0"],
        command: `opencode-plusplus run "${input.task}" . --base ${input.base}`
      })
    );
  }

  if (!input.contractsPassed) {
    decisions.push(
      decision({
        action: "repair-contracts",
        priority: "high",
        confidence: 0.96,
        blocking: true,
        reason: `${input.contractViolations} contract violation${input.contractViolations === 1 ? "" : "s"} detected in the current diff.`,
        signals: [`contract violations: ${input.contractViolations}`, "contracts: failed"],
        command: `opencode-plusplus validate-contracts . --base ${input.base}`
      })
    );
  }

  if (input.missingTestSignals > 0) {
    decisions.push(
      decision({
        action: "add-or-update-tests",
        priority: "medium",
        confidence: 0.78,
        blocking: true,
        reason: "Changed source files have contract signals indicating missing related tests.",
        signals: [`missing test signals: ${input.missingTestSignals}`, `changed files: ${input.changedFiles.length}`],
        command: undefined
      })
    );
  }

  if (input.impactRisk === "High") {
    decisions.push(
      decision({
        action: "expand-context",
        priority: "medium",
        confidence: 0.76,
        blocking: true,
        reason: "High impact risk means the next agent turn should include dependents, related tests, and contract violations.",
        signals: [`impact risk: ${input.impactRisk}`, `impact dependents: ${input.impactDependents}`],
        command: `opencode-plusplus impact . --base ${input.base}`
      })
    );
  }

  if (input.changedFiles.length && input.verificationRequired && input.passedTestEvidence === "none") {
    const verificationCommand = input.codeTestRequired
      ? preferredTestCommand(
          [...input.verificationCommands, ...input.minimalCommands, ...input.regressionCommands, ...input.fullConfidenceCommands],
          input.task
        )
      : firstUsefulCommand(input.verificationCommands, input.task);
    decisions.push(
      decision({
        action: verificationCommand ? "run-tests" : "human-review",
        priority: input.impactRisk === "High" ? "high" : "medium",
        confidence: verificationCommand ? confidenceForRunTests(input) : 0.96,
        blocking: true,
        reason: verificationCommand
          ? input.codeTestRequired
            ? "The loop cannot close until an actual test command has been run."
            : "The docs-only change has a repository documentation verifier that should be run before review."
          : input.codeTestRequired
            ? "No runnable test command is configured. Stop automatic execution and ask a human to configure or choose the repository test command."
            : "A docs-only verification was required by repository policy, but no documentation command was discovered. Ask a human to configure the docs verifier.",
        signals: [
          `changed files: ${input.changedFiles.length}`,
          `minimal tests detected: ${input.minimalTests}`,
          `regression tests detected: ${input.regressionTests}`,
          `runnable verification command: ${verificationCommand ?? "none"}`,
          ...input.traceSignals
        ],
        command: verificationCommand
      })
    );
  }

  if (!decisions.length) {
    const hasChangedFiles = input.changedFiles.length > 0;
    decisions.push(
      decision({
        action: "ready-for-review",
        priority: "low",
        confidence: hasChangedFiles ? 0.78 : 0.72,
        blocking: false,
        reason: hasChangedFiles
          ? input.verificationRequired
            ? "Changed files have passed test trace evidence and no blocking context, contract, or impact signals were detected."
            : "Only documentation changed and no documentation verifier is required."
          : "No stale context, contract failures, changed files, or high-risk impact signals were detected.",
        signals: [
          "freshness: fresh",
          "drift: clean",
          `changed files: ${input.changedFiles.length}`,
          "contracts: passed",
          `passed test trace: ${input.passedTestEvidence}`
        ]
      })
    );
  }

  return dedupeDecisions(decisions);
}

function statusFor(decisions: LoopDecision[]): LoopStatus {
  if (decisions.some((decision) => decision.action === "repair-contracts")) return "needs-repair";
  if (decisions.some((decision) => decision.action === "rebuild-context" || decision.action === "replan" || decision.action === "expand-context"))
    return "needs-context";
  if (decisions.some((decision) => decision.action === "run-tests" || decision.action === "add-or-update-tests")) return "needs-validation";
  if (decisions.some((decision) => decision.action === "human-review")) return "blocked";
  if (decisions.some((decision) => decision.action === "start-agent" || decision.action === "ready-for-review")) return "ready";
  return "blocked";
}

function changedFilesForLoop(context: ContextPackage, base: string): string[] {
  const files = new Set<string>();
  for (const file of changedFilesSince(context.scan.root, base)) {
    if (!isGeneratedContextState(file)) files.add(file);
  }
  try {
    for (const line of runGit(context.scan.root, ["status", "--porcelain", "--untracked-files=all"]).split(/\r?\n/)) {
      if (line.length <= 3) continue;
      const file = line.slice(3).trim().replace(/\\/g, "/").split(" -> ").pop();
      if (file && !isGeneratedContextState(file)) files.add(file);
    }
  } catch {
    return [...files].sort();
  }
  return [...files].sort();
}

function inspectTraceEvidence(
  root: string,
  traceId: string | undefined,
  requiredCommands: string[],
  evidencePolicy: EvidencePolicyMode,
  sourceChanged: boolean
): LoopControllerReport["trace"] {
  if (!traceId) {
    return {
      loaded: false,
      passedTestEvidence: "none",
      signals: ["passed test trace: none", "trace: none"]
    };
  }

  const trace = readExecutionTrace(root, traceId);
  if (!trace) {
    return {
      id: traceId,
      loaded: false,
      passedTestEvidence: "none",
      signals: [`trace: ${traceId} missing`, "passed test trace: none"]
    };
  }

  const result = evidenceSatisfies(
    {
      kind: "tests",
      currentRepoHash: currentWorkingTreeHash(root),
      requiredCommands,
      policy: evidencePolicy,
      sourceChanged
    },
    trace
  );
  if (!result.satisfied) {
    return {
      id: trace.id,
      loaded: true,
      passedTestEvidence: "none",
      stepId: result.stepId,
      signals: [`trace: ${trace.id} loaded`, "passed test trace: none", ...result.evidence]
    };
  }

  return {
    id: trace.id,
    loaded: true,
    passedTestEvidence: result.level,
    stepId: result.stepId,
    signals: [
      `trace: ${trace.id} loaded`,
      `passed test trace: ${result.level}`,
      result.stepId ? `passed test step: ${result.stepId}` : "",
      ...result.evidence
    ].filter(Boolean)
  };
}

function isGeneratedContextState(file: string): boolean {
  return file.startsWith(".agent-context/") || file === "AGENTS.md";
}

function firstUsefulCommand(commands: string[], task: string): string | undefined {
  const useful = commands.filter((command) => !/^No .*detected/i.test(command));
  const terms =
    task
      .toLowerCase()
      .match(/[a-z0-9_-]+/g)
      ?.filter((term) => term.length >= 4) ?? [];
  return (
    useful.find((command) => terms.some((term) => command.toLowerCase().includes(term))) ??
    useful.find((command) => !command.includes("benchmarks/fixtures/") && /(^|\s)(test|tests)\//i.test(command)) ??
    useful.find((command) => !command.includes("benchmarks/fixtures/")) ??
    useful[0]
  );
}

function preferredTestCommand(commands: string[], task: string): string | undefined {
  const executable = commands.filter((command) => firstTestExecutionCommand([command]));
  return firstUsefulCommand(executable, task);
}

function formatDecision(decision: LoopDecision): string {
  const command = decision.command ? ` Command: ${code(decision.command)}.` : "";
  const signals = decision.signals.length ? ` Signals: ${decision.signals.join("; ")}.` : "";
  return `${decision.priority.toUpperCase()} ${decision.action} (${formatConfidence(decision.confidence)}, ${decision.blocking ? "blocking" : "non-blocking"}): ${decision.reason}${command}${signals}`;
}

function write(filePath: string, content: string): string {
  writeFileSync(filePath, `${content.trim()}\n`, "utf8");
  return filePath;
}

function dedupeDecisions(decisions: LoopDecision[]): LoopDecision[] {
  const seen = new Set<string>();
  return decisions.filter((decision) => {
    const key = `${decision.action}:${decision.command ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decision(input: LoopDecision): LoopDecision {
  return {
    ...input,
    confidence: clampConfidence(input.confidence),
    signals: input.signals.filter(Boolean)
  };
}

function confidenceForRunTests(input: {
  impactRisk: "Low" | "Medium" | "High";
  minimalTests: number;
  regressionTests: number;
  minimalCommands: string[];
  regressionCommands: string[];
}): number {
  let confidence = input.impactRisk === "High" ? 0.86 : 0.8;
  if (input.minimalTests > 0) confidence += 0.04;
  if (input.regressionTests > 0) confidence += 0.03;
  if (preferredTestCommand([...input.minimalCommands, ...input.regressionCommands], "")) confidence += 0.03;
  return confidence;
}

function clampConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function formatConfidence(value: number): string {
  return `confidence ${value.toFixed(2)}`;
}
