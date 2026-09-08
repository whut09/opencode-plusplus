import { startApplicationTask } from "../../../../application/task-service.js";
import { readJsonDiagnostic } from "../../../../core/atomic-store.js";
import { taskSlug } from "../../../../core/task-id.js";
import type { TaskRunManifest } from "../../../../outputs/task-run.js";
import { loadPluginHarnessContext } from "./context.js";
import { taskRunManifestPath, writePluginHarnessSession } from "./session.js";
import { createPluginHarnessResult } from "./protocol.js";
import { currentSidecarWorkingTreeHash } from "../worktree-hash.js";
import { contextFingerprint, updateWorkflowState } from "./workflow.js";
import { cacheStatusForStats, contextModeForStats, pluginPerformance, PLUGIN_STAGE_TARGETS, runPluginStage } from "./performance.js";
import { createPluginHarnessError } from "./protocol.js";
import type { PluginPrepareArgs, PluginPrepareResult } from "./types.js";
import { pluginInterventionSnapshot, recordPluginContextSelection } from "./interventions.js";
import { buildVerificationPlan } from "../../../../core/verification/planner.js";

export async function preparePluginHarnessTask(root: string, args: PluginPrepareArgs): Promise<PluginPrepareResult> {
  const staged = await runPluginStage("prepare", () => preparePluginHarnessTaskInternal(root, args));
  if (staged.status === "timeout") {
    return createPluginHarnessError(
      root,
      "prepare",
      `prepare exceeded the ${PLUGIN_STAGE_TARGETS.prepare}ms Desktop target; retry after context generation settles.`,
      null,
      args.sessionId ?? null,
      "none",
      pluginPerformance("prepare", staged, "miss", "rebuilt", [], [])
    );
  }
  const result = staged.value!;
  return {
    ...result,
    performance: pluginPerformance(
      "prepare",
      staged,
      result.performance?.cache ?? "miss",
      result.performance?.contextMode ?? "rebuilt",
      result.performance?.selectedFiles ?? [],
      result.performance?.rejectedFiles ?? []
    )
  };
}

async function preparePluginHarnessTaskInternal(root: string, args: PluginPrepareArgs): Promise<PluginPrepareResult> {
  const context = await loadPluginHarnessContext(root);
  const taskId = taskSlug(args.task);
  const existing = readJsonDiagnostic<TaskRunManifest>(taskRunManifestPath(root, taskId));
  const manifest =
    existing.status === "ok" && existing.value.id === taskId
      ? existing.value
      : (await startApplicationTask({ repo: root, task: args.task, type: args.type ?? "auto" })).manifest;
  const resolvedTaskId = manifest.id || taskId;
  writePluginHarnessSession(root, {
    taskId: resolvedTaskId,
    task: args.task,
    type: args.type ?? "auto",
    sessionId: args.sessionId ?? null,
    updatedAt: new Date().toISOString()
  });
  const artifacts = manifest.files ?? [];
  const selectedFiles = manifest.mustInspect;
  const verification = manifest.verification ?? buildVerificationPlan(context, { changedFiles: manifest.contextFiles ?? selectedFiles });
  const requiredCommands = verification.commands.length ? verification.commands.map((command) => command.command) : manifest.requiredCommands;
  const excludedFiles = (manifest.contextFiles ?? [])
    .filter((file) => !selectedFiles.includes(file))
    .map((file) => ({ path: file, reason: "related context was not marked mustInspect" }));
  recordPluginContextSelection({ root, taskId: resolvedTaskId, sessionId: args.sessionId, phase: "prepare", selectedFiles, excludedFiles });
  if (args.sessionId) {
    updateWorkflowState(root, args.sessionId, {
      phase: "prepared",
      taskId: resolvedTaskId,
      contextFingerprint: contextFingerprint(root, resolvedTaskId),
      initialWorkingTreeHash: currentSidecarWorkingTreeHash(root),
      editBoundary: { allowedEditGlobs: manifest.allowedEditGlobs, avoidEditGlobs: manifest.avoidEditGlobs },
      requiredTests: requiredCommands,
      eventKey: `prepare:${resolvedTaskId}`
    });
  }
  return createPluginHarnessResult(root, {
    ok: true,
    tool: "prepare",
    summary: `Prepared ${resolvedTaskId}. Read mustInspect, edit only allowedEditGlobs, then evaluate.`,
    taskId: resolvedTaskId,
    sessionId: args.sessionId ?? null,
    taskIdSource: "created",
    currentPhase: "prepare",
    decision: "needs-inspection",
    blocking: true,
    findings: ["Prepare is not completion evidence; evaluate and next are required."],
    nextAction: "evaluate",
    mustInspect: manifest.mustInspect,
    allowedEditGlobs: manifest.allowedEditGlobs,
    avoidEditGlobs: manifest.avoidEditGlobs,
    requiredCommands,
    verification,
    artifacts,
    interventions: pluginInterventionSnapshot(root, resolvedTaskId, selectedFiles, excludedFiles),
    performance: {
      ...pluginPerformance(
        "prepare",
        { status: "completed", durationMs: 0 },
        cacheStatusForStats(context.cacheStats),
        contextModeForStats(context.cacheStats),
        manifest.mustInspect,
        (manifest.contextFiles ?? manifest.mustInspect).filter((file) => !manifest.mustInspect.includes(file))
      )
    }
  });
}
