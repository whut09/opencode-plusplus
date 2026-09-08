import { retrieveApplicationContext } from "../../../../application/retrieval-service.js";
import { getContextFiles } from "../../../../application/context-service.js";
import { adaptiveTopK } from "../../../../retrievers/types.js";
import { createPluginHarnessResult } from "./protocol.js";
import { loadPluginHarnessContext } from "./context.js";
import { readPluginHarnessSession } from "./session.js";
import type { PluginRetrieveArgs, PluginRetrieveResult } from "./types.js";
import { createPluginHarnessError } from "./protocol.js";
import { cacheStatusForStats, contextModeForStats, pluginPerformance, runPluginStage } from "./performance.js";
import { pluginInterventionSnapshot, recordPluginContextSelection } from "./interventions.js";
import { contextUsageStorePath, recordContextUsage } from "../../../../context-registry/usage-ledger.js";
import path from "node:path";

export async function retrievePluginHarnessContext(root: string, args: PluginRetrieveArgs): Promise<PluginRetrieveResult> {
  const staged = await runPluginStage("retrieve", () => retrievePluginHarnessContextInternal(root, args));
  if (staged.status === "timeout") {
    return createPluginHarnessError(
      root,
      "retrieve",
      `retrieve exceeded the ${3000}ms Desktop target. OpenCode++ stopped this turn and recorded the plugin failure for review.`,
      null,
      args.sessionId ?? null,
      "none",
      pluginPerformance("retrieve", staged, "miss", "rebuilt", [], [])
    );
  }
  const result = staged.value!;
  return {
    ...result,
    performance: pluginPerformance(
      "retrieve",
      staged,
      result.performance?.cache ?? "miss",
      result.performance?.contextMode ?? "rebuilt",
      result.performance?.selectedFiles ?? [],
      result.performance?.rejectedFiles ?? []
    )
  };
}

async function retrievePluginHarnessContextInternal(root: string, args: PluginRetrieveArgs): Promise<PluginRetrieveResult> {
  if (args.contextId) return fetchPluginContext(root, args);
  const context = await loadPluginHarnessContext(root);
  const taskType = args.taskType ?? "auto";
  const topK = adaptiveTopK(taskType, args.topK);
  const result = await retrieveApplicationContext({
    repo: root,
    context,
    task: args.task,
    provider: "static",
    taskType,
    topK,
    includeTests: true
  });
  const session = readPluginHarnessSession(root, args.sessionId);
  const hits = [...result.hits]
    .map((hit) => ({ path: hit.path, score: hit.score, reason: hit.reason, scoreBreakdown: hit.metadata.scoreBreakdown }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  const selectedFiles = hits.map((hit) => hit.path);
  const excludedFiles = context.index.files
    .map((file) => file.path)
    .filter((file) => !selectedFiles.includes(file))
    .slice(0, 50)
    .map((file) => ({ path: file, reason: "ranked below the requested topK" }));
  recordPluginContextSelection({
    root,
    taskId: session?.taskId ?? `retrieve-${args.task}`,
    sessionId: args.sessionId,
    phase: "retrieve",
    selectedFiles,
    excludedFiles
  });
  return createPluginHarnessResult(root, {
    ok: true,
    tool: "retrieve",
    summary: hits.length ? `Retrieved ${hits.length} stable context hits for ${args.task}.` : `No context hits found for ${args.task}.`,
    taskId: session?.taskId ?? null,
    sessionId: session?.sessionId ?? null,
    taskIdSource: session ? "session" : "none",
    currentPhase: "retrieve",
    decision: "context-retrieved",
    blocking: false,
    nextAction: session ? "evaluate" : "prepare",
    hits,
    interventions: pluginInterventionSnapshot(root, session?.taskId ?? `retrieve-${args.task}`, selectedFiles, excludedFiles),
    artifacts: context.scan.root ? [".agent-context/manifest.json"] : [],
    performance: {
      ...pluginPerformance(
        "retrieve",
        { status: "completed", durationMs: 0 },
        cacheStatusForStats(context.cacheStats),
        contextModeForStats(context.cacheStats),
        hits.map((hit) => hit.path),
        context.index.files
          .map((file) => file.path)
          .filter((file) => !hits.some((hit) => hit.path === file))
          .slice(0, 50)
      )
    }
  });
}

async function fetchPluginContext(root: string, args: PluginRetrieveArgs): Promise<PluginRetrieveResult> {
  const session = readPluginHarnessSession(root, args.sessionId);
  const context = await getContextFiles({
    repo: root,
    id: args.contextId!,
    file: args.file,
    full: args.full,
    mode: args.full ? "full" : args.file ? "file" : "entry",
    annotationId: args.annotationId,
    includeStaleAnnotation: args.includeStaleAnnotation
  });
  const contextTaskId = session?.taskId ?? context.entry.id;
  recordContextUsage(root, contextTaskId, context);
  const selected = context.files?.map((file) => `context://${context.entry.sourceName}/${file.path}`) ?? [];
  const excludedFiles = context.omittedFiles.map((file) => ({ path: file, reason: "omitted by incremental context fetch mode" }));
  recordPluginContextSelection({
    root,
    taskId: contextTaskId,
    sessionId: args.sessionId,
    phase: "retrieve",
    selectedFiles: selected,
    excludedFiles
  });
  return createPluginHarnessResult(root, {
    ok: true,
    tool: "retrieve",
    summary: `Fetched ${context.selectedFiles.length} context file${context.selectedFiles.length === 1 ? "" : "s"} for ${context.entry.id}.`,
    taskId: session?.taskId ?? null,
    sessionId: session?.sessionId ?? null,
    taskIdSource: session ? "session" : "none",
    currentPhase: "retrieve",
    decision: "context-fetched",
    blocking: false,
    nextAction: session ? "evaluate" : "prepare",
    mustInspect: selected,
    artifacts: [".agent-context/manifest.json", path.relative(root, contextUsageStorePath(root, contextTaskId)).replaceAll("\\", "/")],
    context,
    interventions: pluginInterventionSnapshot(root, session?.taskId ?? context.entry.id, selected, excludedFiles),
    performance: {
      stage: "retrieve",
      durationMs: context.durationMs,
      targetMs: 3000,
      status: "completed",
      cache: context.cache.status,
      contextMode: context.contextMode,
      selectedFiles: context.selectedFiles,
      rejectedFiles: context.omittedFiles
    }
  });
}
