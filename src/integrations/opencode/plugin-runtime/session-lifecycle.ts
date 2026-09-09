import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readJsonDiagnostic } from "../../../core/atomic-store.js";
import type { TaskRunManifest } from "../../../outputs/task-run.js";
import { notifyOpenCodePlusPlusToast, notifyPluginInterventionSignals, type OpenCodeSidecarRecorder, type OpenCodeSidecarRuntimeContext } from "./events.js";
import { loadPluginHarnessContext } from "./harness/context.js";
import { readPluginEvaluateState, readPluginHarnessSession, taskRunManifestPath } from "./harness/session.js";
import { readWorkflowState } from "./harness/workflow.js";
import type { IdleVerifier } from "./idle-verify.js";
import type { OpenCodeSidecarVerifyResult } from "../sidecar.js";

export const SESSION_READY_DEBOUNCE_MS = 2500;

export interface SessionLifecycleOptions {
  directory: string;
  context: OpenCodeSidecarRuntimeContext;
  recorder: OpenCodeSidecarRecorder;
  idle: IdleVerifier;
  isEnabled: () => boolean;
  buildContext?: (root: string) => Promise<unknown>;
  readyDebounceMs?: number;
  readyMessage?: string;
  blockerMessage?: (blocker: string) => string;
}

export interface SessionLifecycle {
  onSessionCreated: () => void;
  onHarnessActivated: () => void;
  onHarnessDeactivated: () => void;
  onSessionIdle: (verify: OpenCodeSidecarVerifyResult | null) => void;
  onSessionCompacting: (input: unknown, output: unknown) => void;
  onSessionError: (event: Record<string, unknown>) => void;
}

export function createSessionLifecycle(options: SessionLifecycleOptions): SessionLifecycle {
  const { directory, context, recorder, idle, isEnabled } = options;
  const buildContext = options.buildContext ?? loadPluginHarnessContext;
  const readyDebounceMs = options.readyDebounceMs ?? SESSION_READY_DEBOUNCE_MS;
  const readyMessage = options.readyMessage ?? "已就绪";
  const blockerMessage = options.blockerMessage ?? ((blocker: string) => `未通过：${blocker}。下一步调用 opencode_plusplus_next`);
  let buildTimer: ReturnType<typeof setTimeout> | undefined;
  let buildRunning = false;

  function onSessionCreated(): void {
    const enabled = isEnabled();
    recorder.record("session.created", { enabled });
    recorder.log("debug", "session created", { enabled, directory: context.directory, worktree: context.worktree });
  }

  function onHarnessActivated(): void {
    if (!isEnabled()) return;
    idle.markDirty("session.created", {});
    scheduleReadyBuild();
  }

  function onHarnessDeactivated(): void {
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = undefined;
  }

  function scheduleReadyBuild(): void {
    if (buildRunning) return;
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      buildTimer = undefined;
      void runReadyBuild();
    }, readyDebounceMs);
  }

  async function runReadyBuild(): Promise<void> {
    if (buildRunning) return;
    buildRunning = true;
    try {
      await buildContext(directory);
      const channel = notifyOpenCodePlusPlusToast(context, "OpenCode++", readyMessage);
      recorder.record("sidecar.context-ready", { channel });
      recorder.log("info", `OpenCode++ ${readyMessage}`);
    } catch (error) {
      recorder.log("error", "session ready context build failed", { error: errorMessage(error) });
    } finally {
      buildRunning = false;
    }
  }

  function onSessionIdle(verify: OpenCodeSidecarVerifyResult | null): void {
    try {
      if (!isEnabled()) return;
      if (!verify) return;
      if (verify.interventions && notifyPluginInterventionSignals(context, verify.interventions, "evaluate", recorder) > 0) return;
      if (verify.ok) return;
      const blocker = verify.blockers[0];
      if (!blocker) return;
      notifyOpenCodePlusPlusToast(context, "OpenCode++", blockerMessage(blocker));
      recorder.record("sidecar.idle-blocked", { blocker });
      recorder.log("warn", "idle verification blocked the session", { blocker });
    } catch (error) {
      recorder.log("error", "idle blocker notification failed", { error: errorMessage(error) });
    }
  }

  function onSessionCompacting(input: unknown, output: unknown): void {
    try {
      if (!isEnabled()) return;
      const injected = buildCompactingContext(directory, sessionIdFromInput(input));
      if (!injected) return;
      if (typeof output !== "object" || output === null) {
        recorder.log("debug", "compacting output unavailable; context injection skipped");
        return;
      }
      const target = output as { context?: unknown };
      if (!Array.isArray(target.context)) target.context = [];
      (target.context as string[]).push(injected);
      recorder.record("sidecar.compacting", { bytes: injected.length });
      recorder.log("debug", "compacting context injected");
    } catch (error) {
      recorder.log("error", "compacting context injection failed", { error: errorMessage(error) });
    }
  }

  function onSessionError(event: Record<string, unknown>): void {
    try {
      if (!isEnabled()) return;
      const properties = event.properties && typeof event.properties === "object" ? (event.properties as Record<string, unknown>) : {};
      const message = typeof properties.message === "string" ? properties.message : typeof event.message === "string" ? event.message : "session error";
      recorder.record("session.error", { message, sessionID: properties.sessionID ?? event.sessionID });
      recorder.log("warn", "session error recorded", { message });
    } catch (error) {
      recorder.log("error", "session error recording failed", { error: errorMessage(error) });
    }
  }

  return { onSessionCreated, onHarnessActivated, onHarnessDeactivated, onSessionIdle, onSessionCompacting, onSessionError };
}

export function buildCompactingContext(root: string, sessionId?: string): string | undefined {
  const lines: string[] = [];
  const session = readPluginHarnessSession(root, sessionId);
  const workflow = sessionId ? readWorkflowState(root, sessionId) : undefined;
  if (workflow?.resumeCandidates?.length) {
    lines.push(
      `OpenCode++ resume candidates: ${workflow.resumeCandidates
        .map((candidate) => `${candidate.identity.taskId} [${candidate.compatibility}] from ${candidate.identity.sessionId}: ${candidate.reason}`)
        .join(" | ")}`
    );
    lines.push("OpenCode++ will not restore a mismatched repository or an unconfirmed candidate automatically; call opencode_plusplus_resume with action inspect.");
  }
  if (session) {
    lines.push(`OpenCode++ taskId: ${session.taskId} (task: ${session.task})`);
  }
  const manifest = session ? readTaskRunManifest(root, session.taskId) : undefined;
  if (manifest) {
    if (manifest.allowedEditGlobs.length) lines.push(`OpenCode++ allowedEditGlobs: ${manifest.allowedEditGlobs.join(", ")}`);
    if (manifest.avoidEditGlobs.length) lines.push(`OpenCode++ avoidEditGlobs: ${manifest.avoidEditGlobs.join(", ")}`);
  }
  const evaluate = readPluginEvaluateState(root, sessionId);
  if (evaluate) {
    lines.push(`OpenCode++ last evaluate: blocking=${evaluate.blocking ? "yes" : "no"}, decision=${evaluate.decision}`);
    if (evaluate.missingEvidence.length) lines.push(`OpenCode++ missingEvidence: ${evaluate.missingEvidence.join(", ")}`);
    if (evaluate.requiredCommands.length) lines.push(`OpenCode++ requiredCommands: ${evaluate.requiredCommands.join(" | ")}`);
    if (evaluate.humanReview) {
      lines.push(`OpenCode++ human review: ${evaluate.humanReview.reasonCode} — ${evaluate.humanReview.title}`);
      lines.push(`OpenCode++ human review why: ${evaluate.humanReview.explanation}`);
      lines.push(`OpenCode++ human review action: ${evaluate.humanReview.requiredUserAction}`);
      lines.push(`OpenCode++ human review resume: ${evaluate.humanReview.resumeCondition}`);
    }
  }
  const latest = sessionId ? undefined : readSidecarLatestSummary(root);
  if (latest) lines.push(`OpenCode++ sidecar latest:\n${latest}`);
  if (session || evaluate || latest) lines.push("Do not claim the task complete until opencode_plusplus_next returns finalize.");
  if (!lines.length) return undefined;
  return lines.join("\n");
}

function sessionIdFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.sessionID ?? record.sessionId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readTaskRunManifest(root: string, taskId: string): TaskRunManifest | undefined {
  const result = readJsonDiagnostic<TaskRunManifest>(taskRunManifestPath(root, taskId));
  return result.status === "ok" ? result.value : undefined;
}

function readSidecarLatestSummary(root: string, maxLines = 30): string | undefined {
  const filePath = path.join(root, ".agent-context", "sidecar", "latest.md");
  if (!existsSync(filePath)) return undefined;
  try {
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) return undefined;
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines) return text;
    return `${lines.slice(0, maxLines).join("\n")}\n...(truncated)`;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
