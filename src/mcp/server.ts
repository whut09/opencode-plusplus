#!/usr/bin/env node
// Internal dev/test surface. Not the product entry point: end users install the
// Desktop plugin from the release EXE. This MCP server stays for development,
// CI, and compatibility with external agent hosts that speak MCP.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { OPENCODE_PLUSPLUS_PACKAGE_NAME, OPENCODE_PLUSPLUS_PACKAGE_VERSION } from "../core/package-info.js";
import { buildContextPackage, type BuildOptions } from "../core/context-builder.js";
import { taskSlug } from "../core/task-id.js";
import { unique } from "../core/collections.js";
import type { EvidencePolicyMode } from "../core/types.js";
import { buildContextDelta, renderContextDelta } from "../outputs/context-delta.js";
import { buildLoopControllerReport, renderLoopControllerReport, writeLoopControllerReport, type LoopPhase } from "../harness/control-plane/loop-controller.js";
import { buildPolicyReport, renderPolicyReport, type PolicyFailOn } from "../harness/verification-plane/policy-engine.js";
import { renderTaskVerify } from "../outputs/task-harness.js";
import { buildTaskPack } from "../outputs/task-context.js";
import { buildVerificationPlan } from "../core/verification/planner.js";
import {
  appendExecutionTraceStep,
  readExecutionTrace,
  renderExecutionTrace,
  type ExecutionFinalState,
  type ExecutionStepResult
} from "../harness/observability/execution-trace.js";
import { writeTaskRun, type TaskRunManifest } from "../outputs/task-run.js";
import { writeContextPackage } from "../outputs/renderers/writer.js";
import type { RetrieverProvider } from "../retrievers/types.js";
import { buildAndWriteApplicationContext } from "../application/context-service.js";
import { packApplicationTask, planApplicationTask } from "../application/task-service.js";
import { inspectApplicationImpact, testApplicationChanges, verifyApplicationChanges } from "../application/verification-service.js";
import { explainApplicationPath, retrieveApplicationContext } from "../application/retrieval-service.js";
import { getContextFiles } from "../application/context-service.js";
import {
  runContextFeedbackTool,
  runContextGetTool,
  runContextSearchTool,
  runContextStatusTool,
  runInterventionsTool
} from "../application/context-tools-service.js";
import type { ContextFeedbackLabel, ContextFeedbackTarget } from "../context-registry/types.js";

export const opencodePlusplusMcpToolNames = [
  "opencode_plusplus_build",
  "opencode_plusplus_plan",
  "opencode_plusplus_pack",
  "opencode_plusplus_retrieve",
  "opencode_plusplus_context_search",
  "opencode_plusplus_context_get",
  "opencode_plusplus_context_status",
  "opencode_plusplus_interventions",
  "opencode_plusplus_context_feedback",
  "opencode_plusplus_tests",
  "opencode_plusplus_impact",
  "opencode_plusplus_verify",
  "opencode_plusplus_explain",
  "opencode_plusplus_start_loop",
  "opencode_plusplus_step",
  "opencode_plusplus_evaluate",
  "opencode_plusplus_repair",
  "opencode_plusplus_finalize"
] as const;

type OpenCodePlusplusMcpToolName = (typeof opencodePlusplusMcpToolNames)[number];

const mcpTaskSlug = (task: string) => taskSlug(task, { maxLength: 64, fallback: "task" });

interface OpenCodePlusplusMcpResult {
  [key: string]: unknown;
}

interface RuntimeGuidance {
  nextAction: OpenCodePlusplusMcpResult;
  blocking: boolean;
  requiredCommands: string[];
  mustInspect: string[];
  allowedEditGlobs: string[];
  avoidEditGlobs: string[];
  missingEvidence: string[];
}

interface RetrieveArguments {
  repo?: string;
  task: string;
  provider?: RetrieverProvider;
  topK?: number;
  modules?: string[];
  changedFiles?: string[];
  includeTests?: boolean;
  contextId?: string;
  file?: string;
  full?: boolean;
  annotationId?: string;
  includeStaleAnnotation?: boolean;
}

interface ContextFeedbackInput {
  repo?: string;
  entryId: string;
  source: string;
  version?: string;
  revision: number;
  target: ContextFeedbackTarget;
  file?: string;
  retrievalId?: string;
  interventionId?: string;
  label: ContextFeedbackLabel;
}

interface ContextSearchInput {
  repo?: string;
  query?: string;
  topK?: number;
  taskType?: "auto" | "bugfix" | "feature" | "refactor";
  language?: string;
  packageVersion?: string;
  source?: string;
  tags?: string[];
}

interface ContextGetInput {
  repo?: string;
  entryId: string;
  language?: string;
  packageVersion?: string;
  source?: string;
  file?: string;
  full?: boolean;
  withAnnotations?: boolean;
}

interface ContextStatusInput {
  repo?: string;
  taskId?: string;
}

interface InterventionsInput {
  repo?: string;
  taskId: string;
}

export function createOpenCodePlusplusMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: OPENCODE_PLUSPLUS_PACKAGE_NAME,
      version: OPENCODE_PLUSPLUS_PACKAGE_VERSION
    },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "opencode_plusplus_build",
    {
      description: "Scan a repository and write AGENTS.md plus .agent-context outputs.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        target: z.enum(["codex", "claude", "cursor", "all"]).optional().default("codex"),
        tokenBudget: z.number().int().positive().optional(),
        tokenizer: z.enum(["chars_approx", "cl100k_base", "o200k_base"]).optional(),
        model: z.string().optional(),
        llm: z.boolean().optional()
      })
    },
    async (args) => jsonToolResult(await runBuild(args))
  );

  server.registerTool(
    "opencode_plusplus_plan",
    {
      description: "Generate a task plan with suspected modules, must-inspect files, and validation commands.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        task: z.string(),
        type: z.enum(["auto", "bugfix", "feature", "refactor"]).optional().default("auto"),
        tokenBudget: z.number().int().positive().optional()
      })
    },
    async (args) => jsonToolResult(await runTaskPlan(args))
  );

  server.registerTool(
    "opencode_plusplus_pack",
    {
      description: "Write a task context pack under .agent-context/tasks/<task-id>.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        task: z.string(),
        type: z.enum(["auto", "bugfix", "feature", "refactor"]).optional().default("auto"),
        tokenBudget: z.number().int().positive().optional()
      })
    },
    async (args) => jsonToolResult(await runTaskPack(args))
  );

  server.registerTool(
    "opencode_plusplus_retrieve",
    {
      description: "Search repository context through the unified retrieval protocol.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        task: z.string(),
        provider: z.enum(["static", "ripgrep", "hybrid", "lightrag", "embedding"]).optional().default("hybrid"),
        topK: z.number().int().positive().optional().default(8),
        modules: z.array(z.string()).optional(),
        changedFiles: z.array(z.string()).optional(),
        includeTests: z.boolean().optional().default(false),
        contextId: z.string().optional(),
        file: z.string().optional(),
        full: z.boolean().optional().default(false),
        annotationId: z.string().optional(),
        includeStaleAnnotation: z.boolean().optional().default(false)
      })
    },
    async (args) => jsonToolResult(await runRetrieve(args))
  );

  server.registerTool(
    "opencode_plusplus_context_search",
    {
      description: "Search configured Context Registry entries through the shared application service.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        query: z.string().optional(),
        topK: z.number().int().positive().optional(),
        taskType: z.enum(["auto", "bugfix", "feature", "refactor"]).optional(),
        language: z.string().optional(),
        packageVersion: z.string().optional(),
        source: z.string().optional(),
        tags: z.array(z.string()).optional()
      })
    },
    async (args) => jsonToolResult(await runContextSearch(args))
  );

  server.registerTool(
    "opencode_plusplus_context_get",
    {
      description: "Read a Context entry or companion file through the shared application service.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        entryId: z.string(),
        language: z.string().optional(),
        packageVersion: z.string().optional(),
        source: z.string().optional(),
        file: z.string().optional(),
        full: z.boolean().optional(),
        withAnnotations: z.boolean().optional()
      })
    },
    async (args) => jsonToolResult(await runContextGet(args))
  );

  server.registerTool(
    "opencode_plusplus_context_status",
    {
      description: "Return Context Registry, cache, freshness, selection, rejection, and intervention status.",
      inputSchema: z.object({ repo: z.string().optional().default("."), taskId: z.string().optional() })
    },
    async (args) => jsonToolResult(await runContextStatus(args))
  );

  server.registerTool(
    "opencode_plusplus_interventions",
    {
      description: "Return the application intervention ledger and summary for a task.",
      inputSchema: z.object({ repo: z.string().optional().default("."), taskId: z.string() })
    },
    async (args) => jsonToolResult(await runInterventions(args))
  );

  server.registerTool(
    "opencode_plusplus_context_feedback",
    {
      description: "Record local quality feedback for a Context entry without storing task or source content.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        entryId: z.string(),
        source: z.string(),
        version: z.string().optional(),
        revision: z.number().int().nonnegative(),
        target: z.enum(["entry", "file", "retrieval-result", "intervention"]),
        file: z.string().optional(),
        retrievalId: z.string().optional(),
        interventionId: z.string().optional(),
        label: z.enum(["useful", "not-useful", "outdated", "inaccurate", "incomplete", "wrong-version", "wrong-example", "irrelevant"])
      })
    },
    async (args) => jsonToolResult(await runContextFeedback(args))
  );

  server.registerTool(
    "opencode_plusplus_tests",
    {
      description: "Select minimal, regression, and full-confidence tests for a file, diff, or task.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        forPaths: z.array(z.string()).optional(),
        diff: z.boolean().optional(),
        base: z.string().optional().default("main")
      })
    },
    async (args) => jsonToolResult(await runTests(args))
  );

  server.registerTool(
    "opencode_plusplus_impact",
    {
      description: "Analyze changed files, dependents, related tests, and required verification.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        base: z.string().optional().default("main")
      })
    },
    async (args) => jsonToolResult(await runImpact(args))
  );

  server.registerTool(
    "opencode_plusplus_verify",
    {
      description: "Verify changed files against affected modules, tests, contracts, and risk signals.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        base: z.string().optional().default("main"),
        diff: z.boolean().optional().default(true)
      })
    },
    async (args) => jsonToolResult(await runVerify(args))
  );

  server.registerTool(
    "opencode_plusplus_explain",
    {
      description: "Explain a file or module from the generated repository index.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        targetPath: z.string()
      })
    },
    async (args) => jsonToolResult(await runExplain(args))
  );

  server.registerTool(
    "opencode_plusplus_start_loop",
    {
      description: "Start an agent-native runtime loop: build context, write task run, create execution trace, and return first decisions.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        task: z.string(),
        agent: z.enum(["codex", "claude-code", "cursor", "librechat", "openhands", "other"]).optional().default("other"),
        type: z.enum(["auto", "bugfix", "feature", "refactor"]).optional().default("auto"),
        tokenBudget: z.number().int().positive().optional(),
        base: z.string().optional().default("main"),
        evidencePolicy: z.enum(["advisory", "balanced", "strict"]).optional()
      })
    },
    async (args) => jsonToolResult(await runStartLoop(args))
  );

  server.registerTool(
    "opencode_plusplus_step",
    {
      description: "Append a structured agent runtime step to an execution trace.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        traceId: z.string(),
        agent: z.string().optional(),
        action: z.string(),
        files: z.array(z.string()).optional(),
        reason: z.string().optional(),
        command: z.string().optional(),
        test: z.string().optional(),
        result: z.enum(["passed", "failed", "skipped", "unknown"]).optional(),
        output: z.string().optional(),
        finalState: z.enum(["planned", "in_progress", "partial_success", "success", "failed", "blocked"]).optional()
      })
    },
    async (args) => jsonToolResult(await runRuntimeStep(args))
  );

  server.registerTool(
    "opencode_plusplus_evaluate",
    {
      description: "Evaluate the current agent loop from context delta, loop controller, policy engine, and verify signals.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        task: z.string(),
        traceId: z.string().optional(),
        type: z.enum(["auto", "bugfix", "feature", "refactor"]).optional().default("auto"),
        tokenBudget: z.number().int().positive().optional(),
        base: z.string().optional().default("main"),
        phase: z.enum(["preflight", "after-edit", "repair"]).optional().default("after-edit"),
        failOn: z.enum(["forbidden", "required", "risk"]).optional(),
        strict: z.boolean().optional().default(false),
        evidencePolicy: z.enum(["advisory", "balanced", "strict"]).optional()
      })
    },
    async (args) => jsonToolResult(await runRuntimeEvaluate(args))
  );

  server.registerTool(
    "opencode_plusplus_repair",
    {
      description: "Produce repair-loop decisions and write .agent-context/loops/<task>/loop.* for a failing or risky agent run.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        task: z.string(),
        traceId: z.string().optional(),
        type: z.enum(["auto", "bugfix", "feature", "refactor"]).optional().default("auto"),
        tokenBudget: z.number().int().positive().optional(),
        base: z.string().optional().default("main"),
        evidencePolicy: z.enum(["advisory", "balanced", "strict"]).optional()
      })
    },
    async (args) => jsonToolResult(await runRuntimeRepair(args))
  );

  server.registerTool(
    "opencode_plusplus_finalize",
    {
      description: "Finalize an agent runtime loop with strict policy evaluation and trace final-state update.",
      inputSchema: z.object({
        repo: z.string().optional().default("."),
        task: z.string(),
        traceId: z.string(),
        base: z.string().optional().default("main"),
        evidencePolicy: z.enum(["advisory", "balanced", "strict"]).optional(),
        finalState: z.enum(["success", "partial_success", "failed", "blocked"]).optional().default("success")
      })
    },
    async (args) => jsonToolResult(await runRuntimeFinalize(args))
  );

  return server;
}

export async function runOpenCodePlusplusMcpServer(): Promise<void> {
  const server = createOpenCodePlusplusMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function executeOpenCodePlusplusMcpTool(name: OpenCodePlusplusMcpToolName, args: unknown): Promise<OpenCodePlusplusMcpResult> {
  switch (name) {
    case "opencode_plusplus_build":
      return runBuild(args as BuildInput);
    case "opencode_plusplus_plan":
      return runTaskPlan(args as PlanInput);
    case "opencode_plusplus_pack":
      return runTaskPack(args as PackInput);
    case "opencode_plusplus_retrieve":
      return runRetrieve(args as RetrieveArguments);
    case "opencode_plusplus_context_search":
      return runContextSearch(args as ContextSearchInput);
    case "opencode_plusplus_context_get":
      return runContextGet(args as ContextGetInput);
    case "opencode_plusplus_context_status":
      return runContextStatus(args as ContextStatusInput);
    case "opencode_plusplus_interventions":
      return runInterventions(args as InterventionsInput);
    case "opencode_plusplus_context_feedback":
      return runContextFeedback(args as ContextFeedbackInput);
    case "opencode_plusplus_tests":
      return runTests(args as TestsInput);
    case "opencode_plusplus_impact":
      return runImpact(args as ImpactInput);
    case "opencode_plusplus_verify":
      return runVerify(args as VerifyInput);
    case "opencode_plusplus_explain":
      return runExplain(args as ExplainInput);
    case "opencode_plusplus_start_loop":
      return runStartLoop(args as RuntimeStartInput);
    case "opencode_plusplus_step":
      return runRuntimeStep(args as RuntimeStepInput);
    case "opencode_plusplus_evaluate":
      return runRuntimeEvaluate(args as RuntimeEvaluateInput);
    case "opencode_plusplus_repair":
      return runRuntimeRepair(args as RuntimeRepairInput);
    case "opencode_plusplus_finalize":
      return runRuntimeFinalize(args as RuntimeFinalizeInput);
  }
}

interface BuildInput extends BuildOptions {
  repo?: string;
}

interface PlanInput {
  repo?: string;
  task: string;
  type?: "auto" | "bugfix" | "feature" | "refactor";
  tokenBudget?: number;
  evidencePolicy?: EvidencePolicyMode;
}

type PackInput = PlanInput;

interface TestsInput {
  repo?: string;
  forPaths?: string[];
  diff?: boolean;
  base?: string;
}

interface ImpactInput {
  repo?: string;
  base?: string;
}

interface VerifyInput {
  repo?: string;
  base?: string;
  diff?: boolean;
}

interface ExplainInput {
  repo?: string;
  targetPath: string;
}

interface RuntimeStartInput extends PlanInput {
  agent?: "codex" | "claude-code" | "cursor" | "librechat" | "openhands" | "other";
  base?: string;
}

interface RuntimeStepInput {
  repo?: string;
  traceId: string;
  agent?: string;
  action: string;
  files?: string[];
  reason?: string;
  command?: string;
  test?: string;
  result?: ExecutionStepResult;
  output?: string;
  finalState?: ExecutionFinalState;
}

interface RuntimeEvaluateInput extends PlanInput {
  traceId?: string;
  base?: string;
  phase?: LoopPhase;
  failOn?: PolicyFailOn;
  strict?: boolean;
}

interface RuntimeRepairInput extends PlanInput {
  traceId?: string;
  base?: string;
}

interface RuntimeFinalizeInput {
  repo?: string;
  task: string;
  traceId: string;
  base?: string;
  evidencePolicy?: EvidencePolicyMode;
  finalState?: Extract<ExecutionFinalState, "success" | "partial_success" | "failed" | "blocked">;
}

async function runBuild(args: BuildInput): Promise<OpenCodePlusplusMcpResult> {
  const result = await buildAndWriteApplicationContext(args.repo ?? ".", {
    target: args.target,
    tokenBudget: args.tokenBudget,
    llm: args.llm,
    tokenizer: args.tokenizer,
    model: args.model
  });
  const context = result.context;

  return {
    repo: context.scan.root,
    readiness: {
      grade: context.readiness.grade,
      score: context.readiness.score
    },
    tokenSavings: {
      compressionRatio: context.tokenSavings.compressionRatio,
      withinBudget: context.tokenSavings.withinBudget,
      originalTokens: context.tokenSavings.originalRepoTokens.tokens,
      estimatedTokens: context.tokenSavings.estimatedContextPackTokens.tokens,
      actualTokens: context.tokenSavings.actualOutputTokens?.total ?? null
    },
    writtenFiles: result.writtenFiles
  };
}

async function runTaskPlan(args: PlanInput): Promise<OpenCodePlusplusMcpResult> {
  const result = await planApplicationTask({ repo: args.repo ?? ".", task: args.task, type: args.type, tokenBudget: args.tokenBudget });
  return {
    task: args.task,
    type: args.type ?? "auto",
    markdown: result.markdown
  };
}

async function runTaskPack(args: PackInput): Promise<OpenCodePlusplusMcpResult> {
  const result = await packApplicationTask({ repo: args.repo ?? ".", task: args.task, type: args.type, tokenBudget: args.tokenBudget });
  return {
    task: args.task,
    taskId: result.taskId,
    dir: result.dir,
    files: result.files,
    markdown: result.markdown
  };
}

async function runRetrieve(args: RetrieveArguments): Promise<OpenCodePlusplusMcpResult> {
  if (args.contextId) {
    return {
      ...(await getContextFiles({
        repo: args.repo ?? ".",
        id: args.contextId,
        file: args.file,
        full: args.full,
        annotationId: args.annotationId,
        includeStaleAnnotation: args.includeStaleAnnotation
      }))
    };
  }
  return retrieveApplicationContext({ repo: args.repo ?? ".", ...args });
}

async function runContextFeedback(args: ContextFeedbackInput): Promise<OpenCodePlusplusMcpResult> {
  const result = await runContextFeedbackTool({ ...args, repo: args.repo ?? "." });
  if (!result.ok) return { ...result };
  return {
    enabled: result.data.enabled,
    feedback: result.data.feedback,
    stats: result.data.stats,
    transport: result.data.transport,
    note: "Feedback is separate from local annotations and cannot satisfy evidence or change a decision."
  };
}

async function runContextSearch(args: ContextSearchInput): Promise<OpenCodePlusplusMcpResult> {
  return { ...(await runContextSearchTool({ ...args, repo: args.repo ?? "." })) };
}

async function runContextGet(args: ContextGetInput): Promise<OpenCodePlusplusMcpResult> {
  return {
    ...(await runContextGetTool({
      repo: args.repo ?? ".",
      id: args.entryId,
      language: args.language,
      packageVersion: args.packageVersion,
      source: args.source,
      file: args.file,
      full: args.full,
      withAnnotations: args.withAnnotations
    }))
  };
}

async function runContextStatus(args: ContextStatusInput): Promise<OpenCodePlusplusMcpResult> {
  return { ...(await runContextStatusTool({ repo: args.repo ?? ".", taskId: args.taskId })) };
}

async function runInterventions(args: InterventionsInput): Promise<OpenCodePlusplusMcpResult> {
  return { ...(await runInterventionsTool({ repo: args.repo ?? ".", taskId: args.taskId })) };
}

async function runTests(args: TestsInput): Promise<OpenCodePlusplusMcpResult> {
  const { context: _context, ...result } = await testApplicationChanges({ repo: args.repo ?? ".", ...args });
  return result;
}

async function runImpact(args: ImpactInput): Promise<OpenCodePlusplusMcpResult> {
  const { context: _context, ...result } = await inspectApplicationImpact({ repo: args.repo ?? ".", base: args.base });
  return result;
}

async function runVerify(args: VerifyInput): Promise<OpenCodePlusplusMcpResult> {
  const { context: _context, ...result } = await verifyApplicationChanges({ repo: args.repo ?? ".", base: args.base, diff: args.diff });
  return result;
}

async function runExplain(args: ExplainInput): Promise<OpenCodePlusplusMcpResult> {
  return explainApplicationPath({ repo: args.repo ?? ".", targetPath: args.targetPath });
}

async function runStartLoop(args: RuntimeStartInput): Promise<OpenCodePlusplusMcpResult> {
  const context = await buildContextPackage(args.repo ?? ".");
  const writeResult = writeContextPackage(context);
  const run = writeTaskRun(context, args.task, {
    type: args.type ?? "auto",
    tokenBudget: args.tokenBudget,
    base: args.base ?? "main"
  });
  appendExecutionTraceStep(context.scan.root, run.runId, {
    agent: args.agent ?? "other",
    action: "agent-runtime-start",
    reason: `Started through MCP runtime for ${args.agent ?? "other"}.`,
    finalState: "in_progress"
  });
  const loop = buildLoopControllerReport(context, args.task, {
    phase: "preflight",
    type: args.type ?? "auto",
    tokenBudget: args.tokenBudget,
    base: args.base ?? "main",
    traceId: run.runId,
    evidencePolicy: args.evidencePolicy
  });
  const delta = buildContextDelta(context, { base: args.base ?? "main" });
  const guidance = buildRuntimeGuidance(context, args.task, {
    loop,
    manifest: run.manifest
  });

  return {
    runtime: "agent-native",
    repo: context.scan.root,
    task: args.task,
    runId: run.runId,
    traceId: run.runId,
    taskRunDir: path.relative(context.scan.root, run.dir).replaceAll("\\", "/"),
    traceFile: run.manifest.traceFile,
    generatedFiles: writeResult.files.map((file) => path.relative(context.scan.root, file).replaceAll("\\", "/")),
    loop,
    delta,
    ...guidance
  };
}

async function runRuntimeStep(args: RuntimeStepInput): Promise<OpenCodePlusplusMcpResult> {
  const root = path.resolve(args.repo ?? ".");
  const trace = appendExecutionTraceStep(root, args.traceId, {
    agent: args.agent,
    action: args.action,
    files: args.files,
    reason: args.reason,
    command: args.command,
    test: args.test,
    result: args.result,
    output: args.output,
    finalState: args.finalState
  });
  return {
    traceId: trace.id,
    finalState: trace.finalState,
    steps: trace.steps.length,
    latestStep: trace.steps.at(-1),
    markdown: renderExecutionTrace(trace)
  };
}

async function runRuntimeEvaluate(args: RuntimeEvaluateInput): Promise<OpenCodePlusplusMcpResult> {
  const context = await buildContextPackage(args.repo ?? ".");
  const loop = buildLoopControllerReport(context, args.task, {
    phase: args.phase ?? "after-edit",
    type: args.type ?? "auto",
    tokenBudget: args.tokenBudget,
    base: args.base ?? "main",
    traceId: args.traceId,
    evidencePolicy: args.evidencePolicy
  });
  const policy = buildPolicyReport(context, {
    base: args.base ?? "main",
    traceId: args.traceId,
    failOn: args.failOn,
    strict: args.strict,
    evidencePolicy: args.evidencePolicy ?? (args.strict ? "strict" : undefined)
  });
  const delta = buildContextDelta(context, { base: args.base ?? "main" });
  const verifyMarkdown = renderTaskVerify(context, { base: args.base ?? "main", diff: true });
  const manifest = readTaskRunManifest(context.scan.root, args.traceId ?? mcpTaskSlug(args.task));
  const guidance = buildRuntimeGuidance(context, args.task, {
    loop,
    policy,
    manifest,
    type: args.type ?? "auto",
    tokenBudget: args.tokenBudget
  });

  return {
    runtime: "agent-native",
    task: args.task,
    traceId: args.traceId,
    passed: policy.passed && !guidance.blocking,
    loop,
    policy,
    delta,
    ...guidance,
    markdown: [renderLoopControllerReport(loop), "", renderPolicyReport(policy), "", renderContextDelta(delta), "", verifyMarkdown].join("\n")
  };
}

async function runRuntimeRepair(args: RuntimeRepairInput): Promise<OpenCodePlusplusMcpResult> {
  const context = await buildContextPackage(args.repo ?? ".");
  const loopResult = writeLoopControllerReport(context, args.task, {
    phase: "repair",
    type: args.type ?? "auto",
    tokenBudget: args.tokenBudget,
    base: args.base ?? "main",
    traceId: args.traceId,
    evidencePolicy: args.evidencePolicy
  });
  const policy = buildPolicyReport(context, { base: args.base ?? "main", traceId: args.traceId, evidencePolicy: args.evidencePolicy });
  const manifest = readTaskRunManifest(context.scan.root, args.traceId ?? mcpTaskSlug(args.task));
  const guidance = buildRuntimeGuidance(context, args.task, {
    loop: loopResult.report,
    policy,
    manifest,
    type: args.type ?? "auto",
    tokenBudget: args.tokenBudget
  });

  return {
    task: args.task,
    traceId: args.traceId,
    loop: loopResult.report,
    policy,
    repairFiles: loopResult.files.map((file) => path.relative(context.scan.root, file).replaceAll("\\", "/")),
    ...guidance,
    requiredActions: unique([
      ...guidance.requiredCommands,
      ...loopResult.report.decisions.map((decision) => decision.command).filter((command): command is string => Boolean(command)),
      ...policy.findings.map((finding) => finding.requiredAction).filter((command): command is string => Boolean(command)),
      ...(loopResult.report.verification?.commands.map((command) => command.command) ?? [])
    ]),
    markdown: [renderLoopControllerReport(loopResult.report), "", renderPolicyReport(policy)].join("\n")
  };
}

async function runRuntimeFinalize(args: RuntimeFinalizeInput): Promise<OpenCodePlusplusMcpResult> {
  const context = await buildContextPackage(args.repo ?? ".");
  const policy = buildPolicyReport(context, { base: args.base ?? "main", traceId: args.traceId, evidencePolicy: args.evidencePolicy });
  const traceBefore = readExecutionTrace(context.scan.root, args.traceId);
  const loop = buildLoopControllerReport(context, args.task, {
    phase: "after-edit",
    base: args.base ?? "main",
    traceId: args.traceId,
    evidencePolicy: args.evidencePolicy
  });
  const manifest = readTaskRunManifest(context.scan.root, args.traceId ?? mcpTaskSlug(args.task));
  const guidance = buildRuntimeGuidance(context, args.task, {
    loop,
    policy,
    manifest
  });
  const passed = policy.passed && !guidance.blocking;
  const trace = appendExecutionTraceStep(context.scan.root, args.traceId, {
    action: "finalize",
    reason: passed ? "Runtime policy and loop gates passed; finalizing runtime loop." : "Runtime gates failed; finalizing with unresolved findings.",
    result: passed ? "passed" : "failed",
    finalState: passed ? (args.finalState ?? "success") : "blocked"
  });

  return {
    task: args.task,
    traceId: trace.id,
    previousFinalState: traceBefore?.finalState ?? null,
    finalState: trace.finalState,
    passed,
    loop,
    policy,
    ...guidance,
    markdown: [renderPolicyReport(policy), "", renderExecutionTrace(trace)].join("\n")
  };
}

function buildRuntimeGuidance(
  context: Awaited<ReturnType<typeof buildContextPackage>>,
  task: string,
  input: {
    loop: ReturnType<typeof buildLoopControllerReport>;
    policy?: ReturnType<typeof buildPolicyReport>;
    manifest?: TaskRunManifest;
    type?: PlanInput["type"];
    tokenBudget?: number;
  }
): RuntimeGuidance {
  const fallback = input.manifest ?? fallbackManifest(context, task, input.type, input.tokenBudget);
  const nextAction = firstDecision(input.loop);
  const policyCommands = input.policy?.findings.map((finding) => finding.requiredAction).filter((command): command is string => Boolean(command)) ?? [];
  const missingEvidence = unique([
    ...input.loop.runtime.missingEvidence,
    ...input.loop.decisions.filter((decision) => decision.blocking).map((decision) => decision.reason),
    ...(input.policy?.findings
      .filter((finding) => finding.status === "missing" || finding.status === "failed")
      .map((finding) => `${finding.id}: ${finding.message}`) ?? [])
  ]);

  return {
    nextAction,
    blocking: Boolean(nextAction.blocking) || input.loop.decisions.some((decision) => decision.blocking) || Boolean(input.policy && !input.policy.passed),
    requiredCommands: unique([
      ...fallback.requiredCommands,
      ...input.loop.decisions.map((decision) => decision.command).filter((command): command is string => Boolean(command)),
      ...policyCommands
    ]).filter(isRunnableCommand),
    mustInspect: fallback.mustInspect,
    allowedEditGlobs: fallback.allowedEditGlobs,
    avoidEditGlobs: fallback.avoidEditGlobs,
    missingEvidence
  };
}

function fallbackManifest(
  context: Awaited<ReturnType<typeof buildContextPackage>>,
  task: string,
  type: PlanInput["type"] = "auto",
  tokenBudget?: number
): Pick<TaskRunManifest, "requiredCommands" | "mustInspect" | "allowedEditGlobs" | "avoidEditGlobs"> {
  const pack = buildTaskPack(context, task, { type, tokenBudget });
  const verification = buildVerificationPlan(context, {
    changedFiles: pack.files.filter((file) => file.category === "direct-source" || file.category === "entrypoint").map((file) => file.path)
  });

  return {
    requiredCommands: unique(verification.commands.map((command) => command.command)),
    mustInspect: unique([...pack.readFirst.map((file) => file.path), ...pack.files.filter((file) => file.category === "test").map((file) => file.path)]).slice(
      0,
      14
    ),
    allowedEditGlobs: unique(
      pack.files.filter((file) => file.category === "direct-source" || file.category === "entrypoint" || file.category === "test").map((file) => file.path)
    ).slice(0, 24),
    avoidEditGlobs: ["dist/**", "node_modules/**", ".agent-context/**", "**/*.lock", "package-lock.json"]
  };
}

function readTaskRunManifest(root: string, runId: string | undefined): TaskRunManifest | undefined {
  if (!runId) return undefined;
  const filePath = path.join(root, ".agent-context", "runs", runId, "run.json");
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as TaskRunManifest;
  } catch {
    return undefined;
  }
}

function firstDecision(loop: ReturnType<typeof buildLoopControllerReport>): OpenCodePlusplusMcpResult {
  const decision = loop.decisions[0];
  return decision
    ? {
        action: decision.action,
        priority: decision.priority,
        confidence: decision.confidence,
        blocking: decision.blocking,
        reason: decision.reason,
        signals: decision.signals,
        command: decision.command
      }
    : { action: "ready-for-review", confidence: 0.72, blocking: false, signals: ["no loop decisions returned"] };
}

function jsonToolResult(result: OpenCodePlusplusMcpResult) {
  return {
    structuredContent: result,
    content: [
      {
        type: "text" as const,
        text: `${JSON.stringify(result, null, 2)}\n`
      }
    ]
  };
}

function isRunnableCommand(command: string): boolean {
  return Boolean(command) && !/^No .*detected/i.test(command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOpenCodePlusplusMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
