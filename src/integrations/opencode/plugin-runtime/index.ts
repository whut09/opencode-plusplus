import { sanitizeToolOutput } from "../output-sanitizer.js";
import { recordOpencodeSidecarTool } from "../sidecar.js";
import { runCommandGuard } from "./command-guard.js";
import { createSidecarRecorder, type OpenCodeSidecarRuntimeContext } from "./events.js";
import { exitCodeFromOutput, outputText, toolKey } from "./evidence.js";
import {
  executeContextGetTool,
  executeContextSearchTool,
  executeContextStatusTool,
  executeDashboardTool,
  executeEvaluateTool,
  executeFeedbackTool,
  executeHumanReviewTool,
  executeInterventionsTool,
  executeNextTool,
  executePrepareTool,
  executeRetrieveTool
} from "./harness/index.js";
import { createIdleVerifier } from "./idle-verify.js";
import { normalizeToolExecuteAfter, normalizeToolExecuteBefore } from "./hook-input.js";
import { commandFromTool, pathsFromTool } from "./paths.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { initializeWorkflowState, readWorkflowState, updateWorkflowState } from "./harness/workflow.js";
import {
  defaultOpenCodePlusPlusStateFile,
  readOpenCodePlusPlusPluginStatus,
  renderOpenCodePlusPlusPluginStatus,
  setOpenCodePlusPlusPluginEnabled
} from "./state.js";
import { currentSidecarWorkingTreeHash } from "./worktree-hash.js";
import { isGeneratedRuntimePath } from "../sidecar-path-guard.js";
import { isOpenCodePlusPlusAgent } from "./agent-scope.js";

export { OPENCODE_PLUSPLUS_PLUGIN_TOOL_NAMES } from "./harness/index.js";

export interface OpenCodePlusPlusSidecarOptions {
  stateFile?: string;
  pluginPath?: string;
  pluginInstalled?: boolean;
}

export async function OpenCodePlusPlusSidecar(context: OpenCodeSidecarRuntimeContext): Promise<Record<string, unknown>> {
  return createOpenCodePlusPlusSidecar(context);
}

export async function createOpenCodePlusPlusSidecar(
  context: OpenCodeSidecarRuntimeContext,
  options: OpenCodePlusPlusSidecarOptions = {}
): Promise<Record<string, unknown>> {
  const recorder = createSidecarRecorder(context);
  const stateFile = options.stateFile ?? defaultOpenCodePlusPlusStateFile();
  const idle = createIdleVerifier(context.directory, recorder, 2000, options.pluginPath, options.pluginInstalled);
  const toolStarts = new Map<string, { startedAt: string; workingTreeHashBefore: string }>();
  const sessionAgents = new Map<string, unknown>();

  function enabled(): boolean {
    return readOpenCodePlusPlusPluginStatus(stateFile).enabled;
  }

  function sessionActive(sessionId?: string): boolean {
    return Boolean(enabled() && sessionId && isOpenCodePlusPlusAgent(sessionAgents.get(sessionId)));
  }

  const lifecycle = createSessionLifecycle({
    directory: context.directory,
    context,
    recorder,
    idle,
    isEnabled: enabled
  });
  const desktopHarnessTool = (description: string, args: Record<string, { type: string }>, execute: (input: unknown) => Promise<string>) =>
    harnessTool(description, args, execute, {
      root: context.directory,
      isEnabled: enabled,
      isActive: (agent, sessionId) => {
        if (agent !== undefined) return isOpenCodePlusPlusAgent(agent);
        if (sessionId) return sessionActive(sessionId);
        return true;
      }
    });

  function rememberToolStart(tool: unknown, args: unknown, callId?: string): void {
    toolStarts.set(hookKey(tool, args, callId), {
      startedAt: new Date().toISOString(),
      workingTreeHashBefore: currentSidecarWorkingTreeHash(context.directory)
    });
  }

  function recordToolAfter(input: unknown, output: unknown): void {
    try {
      const normalized = normalizeToolExecuteAfter(input, output);
      const tool = normalized.tool;
      const args = normalized.args;
      const command = commandFromTool(tool, args);
      const paths = pathsFromTool(args);
      const key = hookKey(tool, args, normalized.callId);
      const started = toolStarts.get(key) ?? {
        startedAt: new Date().toISOString(),
        workingTreeHashBefore: currentSidecarWorkingTreeHash(context.directory)
      };
      toolStarts.delete(key);

      const finishedAt = new Date().toISOString();
      const exitCode = exitCodeFromOutput(output);
      const sessionId = normalized.sessionId;
      const stdout = outputText(output, ["stdout", "output", "text"]);
      const stderr = outputText(output, ["stderr", "error"]);
      const stdoutEvidence = sanitizeToolOutput(stdout);
      const stderrEvidence = sanitizeToolOutput(stderr);
      const eventId = normalized.callId ? `tool.execute.after:${normalized.callId}` : undefined;
      const payload = {
        eventId,
        tool: String(tool),
        command: command ?? undefined,
        exitCode,
        startedAt: started.startedAt,
        finishedAt,
        workingTreeHashBefore: started.workingTreeHashBefore,
        workingTreeHashAfter: currentSidecarWorkingTreeHash(context.directory),
        sessionId: sessionId ? String(sessionId) : undefined,
        taskId: sessionId ? (readWorkflowState(context.directory, String(sessionId))?.taskId ?? undefined) : undefined,
        source: "desktop-hook" as const,
        paths,
        stdoutHash: stdoutEvidence.hash,
        stdoutPreview: stdoutEvidence.preview,
        stdoutTruncated: stdoutEvidence.truncated,
        stdoutRedacted: stdoutEvidence.redacted,
        stderrHash: stderrEvidence.hash,
        stderrPreview: stderrEvidence.preview,
        stderrTruncated: stderrEvidence.truncated,
        stderrRedacted: stderrEvidence.redacted
      };
      recordOpencodeSidecarTool(context.directory, payload);
      recorder.record("sidecar.record-tool", {
        eventId: normalized.callId ? `sidecar.record-tool:${normalized.callId}` : undefined,
        sessionId: sessionId ? String(sessionId) : undefined,
        taskId: payload.taskId,
        tool,
        command,
        paths,
        exitCode
      });
    } catch (error) {
      recorder.log("debug", "tool evidence record failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    name: "opencode-plusplus-sidecar",
    tool: {
      opencode_plusplus_enable: controlTool("Enable OpenCode++ guards and evidence capture.", () => setOpenCodePlusPlusPluginEnabled(true, stateFile)),
      opencode_plusplus_disable: controlTool("Disable OpenCode++ guards and evidence capture.", () => {
        const status = setOpenCodePlusPlusPluginEnabled(false, stateFile);
        sessionAgents.clear();
        lifecycle.onHarnessDeactivated();
        return status;
      }),
      opencode_plusplus_status: controlTool("Show OpenCode++ installation and enabled status.", () => readOpenCodePlusPlusPluginStatus(stateFile)),
      opencode_plusplus_dashboard: desktopHarnessTool(
        "Show the detailed OpenCode++ Harness Dashboard when the user asks for it, debugging is needed, or human review is required. It shows recorded facts and actionSummary, not hidden model reasoning; normal tool results stay compact.",
        { taskId: { type: "string" }, sessionId: { type: "string" } },
        (args) => executeDashboardTool(context.directory, args, context, recorder)
      ),
      opencode_plusplus_prepare: desktopHarnessTool(
        "Call before editing. Builds repository context if missing and returns taskId, mustInspect, edit boundaries, and requiredCommands.",
        { task: { type: "string" }, type: { type: "string" }, sessionId: { type: "string" } },
        (args) => executePrepareTool(context.directory, args, context, recorder)
      ),
      opencode_plusplus_retrieve: desktopHarnessTool(
        "Call to find task-relevant files or incrementally fetch a Context Registry entry. Returns ranked paths, scores, provenance, and selected content.",
        {
          task: { type: "string" },
          topK: { type: "number" },
          taskType: { type: "string" },
          contextId: { type: "string" },
          file: { type: "string" },
          full: { type: "boolean" },
          annotationId: { type: "string" },
          includeStaleAnnotation: { type: "boolean" },
          sessionId: { type: "string" }
        },
        (args) => executeRetrieveTool(context.directory, args, context, recorder)
      ),
      opencode_plusplus_context_search: desktopHarnessTool(
        "Search configured Context Registry entries and return deterministic scores, filters, cache state, conflicts, and diagnostics.",
        {
          query: { type: "string" },
          topK: { type: "number" },
          taskType: { type: "string" },
          language: { type: "string" },
          packageVersion: { type: "string" },
          source: { type: "string" },
          tags: { type: "array" }
        },
        (args) => executeContextSearchTool(context.directory, args)
      ),
      opencode_plusplus_context_get: desktopHarnessTool(
        "Read a Context Registry entry or companion file with provenance, freshness, cache state, and optional explicit annotations.",
        {
          entryId: { type: "string" },
          language: { type: "string" },
          packageVersion: { type: "string" },
          source: { type: "string" },
          file: { type: "string" },
          full: { type: "boolean" },
          withAnnotations: { type: "boolean" }
        },
        (args) => executeContextGetTool(context.directory, args)
      ),
      opencode_plusplus_context_status: desktopHarnessTool(
        "Return Context Registry sources, cache, freshness, selected and rejected Context, and the current intervention summary.",
        { taskId: { type: "string" }, sessionId: { type: "string" } },
        (args) => executeContextStatusTool(context.directory, args)
      ),
      opencode_plusplus_interventions: desktopHarnessTool(
        "Return deterministic intervention events, verified fixes, remaining problems, Context usage, and feedback state for the current task.",
        { taskId: { type: "string" }, sessionId: { type: "string" } },
        (args) => executeInterventionsTool(context.directory, args)
      ),
      opencode_plusplus_context_feedback: desktopHarnessTool(
        "Record local Context quality feedback. Feedback is metadata only and cannot satisfy evidence or change a decision.",
        {
          entryId: { type: "string" },
          source: { type: "string" },
          version: { type: "string" },
          revision: { type: "number" },
          target: { type: "string" },
          file: { type: "string" },
          retrievalId: { type: "string" },
          interventionId: { type: "string" },
          label: { type: "string" }
        },
        (args) => executeFeedbackTool(context.directory, args)
      ),
      opencode_plusplus_human_review: desktopHarnessTool(
        "Resolve a persisted OpenCode++ human review request. Approve only a boundary expansion after inspecting the requested files; this updates the current task boundary and resumes without prepare.",
        {
          taskId: { type: "string" },
          sessionId: { type: "string" },
          requestId: { type: "string" },
          action: { type: "string" },
          confirmed: { type: "boolean" }
        },
        (args) => executeHumanReviewTool(context.directory, args, context, recorder)
      ),
      opencode_plusplus_evaluate: desktopHarnessTool(
        "Call after edits or before claiming done. Returns a compact OpenCode++ status plus structured actionSummary, blocking findings, decision, and exact missing evidence.",
        { taskId: { type: "string" }, sessionId: { type: "string" } },
        (args) => executeEvaluateTool(context.directory, args, context, recorder)
      ),
      opencode_plusplus_next: desktopHarnessTool(
        "Call to get the next harness action and compact status. Use the structured actionSummary for facts; if nextAction is not finalize, do not claim completion or ask the user to repeat the task.",
        { taskId: { type: "string" }, sessionId: { type: "string" } },
        (args) => executeNextTool(context.directory, args, context, recorder)
      )
    },
    "chat.message": async (input: unknown) => {
      const message = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const sessionId = stringValue(message.sessionID ?? message.sessionId);
      if (!sessionId || message.agent === undefined) return;
      const wasActive = sessionActive(sessionId);
      sessionAgents.set(sessionId, message.agent);
      const isActive = sessionActive(sessionId);
      if (isActive && !wasActive) {
        safeInitializeWorkflow(sessionId);
        lifecycle.onHarnessActivated();
      } else if (!isActive && wasActive && ![...sessionAgents.values()].some(isOpenCodePlusPlusAgent)) {
        lifecycle.onHarnessDeactivated();
      }
    },
    "tool.execute.before": async (input: unknown, output: unknown) => {
      const normalized = normalizeToolExecuteBefore(input, output);
      if (!sessionActive(normalized.sessionId)) return;
      const sessionId = normalized.sessionId!;
      const workflow = safeInitializeWorkflow(sessionId);
      if (normalized.tool !== "shell" && workflow.sourceChanged && !workflow.taskId) {
        throw new Error("OpenCode++ requires opencode_plusplus_prepare before source edits.");
      }
      safeUpdateWorkflow(sessionId, {
        phase: workflow.taskId ? "editing" : workflow.phase,
        eventKey: `tool:${normalized.callId ?? toolKey(normalized.tool, normalized.args)}`
      });
      rememberToolStart(normalized.tool, normalized.args, normalized.callId);
      runCommandGuard(context.directory, recorder, normalized.tool, normalized.args);
    },
    "tool.execute.after": async (input: unknown, output: unknown) => {
      const normalized = normalizeToolExecuteAfter(input, output);
      if (!sessionActive(normalized.sessionId)) return;
      recordToolAfter(input, output);
    },
    "experimental.session.compacting": async (input: unknown, output: unknown) => {
      const sessionId = sessionIdFromRecord(input);
      if (!sessionActive(sessionId)) return;
      lifecycle.onSessionCompacting(input, output);
    },
    event: async ({ event }: { event?: Record<string, unknown> }) => {
      try {
        const eventRecord = event ?? {};
        const type = eventRecord.type;
        if (type === "session.created") {
          lifecycle.onSessionCreated();
          return;
        }

        const sessionId = sessionIdFromEvent(eventRecord);
        if (!sessionActive(sessionId)) return;

        if (type === "file.edited") {
          const properties = eventRecord.properties && typeof eventRecord.properties === "object" ? (eventRecord.properties as Record<string, unknown>) : {};
          const file = properties.file ?? properties.path ?? eventRecord.file ?? eventRecord.path ?? "unknown";
          if (isGeneratedRuntimePath(String(file))) return;
          const workflow = safeInitializeWorkflow(sessionId!);
          safeUpdateWorkflow(sessionId!, { phase: "editing", taskId: workflow.taskId, eventKey: `file.edited:${file}` });
          idle.markDirty("file.edited", { file });
        }

        if (type === "file.watcher.updated") {
          const properties = eventRecord.properties && typeof eventRecord.properties === "object" ? (eventRecord.properties as Record<string, unknown>) : {};
          const file = properties.file ?? properties.path ?? eventRecord.file ?? eventRecord.path ?? "unknown";
          if (isGeneratedRuntimePath(String(file))) {
            recorder.record("file.watcher.updated.ignored", { file: String(file), reason: "generated-runtime-path" });
            return;
          }
          const workflow = safeInitializeWorkflow(sessionId!);
          if (!workflow.taskId) throw new Error("OpenCode++ requires opencode_plusplus_prepare before source edits.");
          safeUpdateWorkflow(sessionId!, { phase: "editing", taskId: workflow.taskId, eventKey: `file.watcher.updated:${file}` });
          idle.markDirty("file.watcher.updated", { file });
        }

        if (type === "session.idle") {
          safeUpdateWorkflow(sessionId!, { eventKey: `session.idle:${sessionId}` });
          recorder.record("session.idle");
          const verify = await idle.maybeVerifyOnIdle();
          lifecycle.onSessionIdle(verify);
        }

        if (type === "session.error") {
          lifecycle.onSessionError(eventRecord);
        }
      } catch (error) {
        recorder.log("debug", "plugin event hook failed safely", { message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  function safeInitializeWorkflow(sessionId: string) {
    try {
      return initializeWorkflowState(context.directory, sessionId);
    } catch (error) {
      recorder.log("debug", "workflow initialization failed safely", { sessionId, message: error instanceof Error ? error.message : String(error) });
      const current = currentSidecarWorkingTreeHash(context.directory);
      return {
        sessionId,
        phase: "created" as const,
        taskId: null,
        contextFingerprint: null,
        initialWorkingTreeHash: current,
        currentWorkingTreeHash: current,
        editBoundary: { allowedEditGlobs: [], avoidEditGlobs: [] },
        boundaryRevision: 1,
        requiredTests: [],
        lastEventKey: null,
        sourceChanged: false,
        updatedAt: new Date().toISOString()
      };
    }
  }

  function safeUpdateWorkflow(sessionId: string, update: Parameters<typeof updateWorkflowState>[2]): void {
    try {
      updateWorkflowState(context.directory, sessionId, update);
    } catch (error) {
      recorder.log("debug", "workflow update failed safely", { sessionId, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function controlTool(description: string, action: () => ReturnType<typeof readOpenCodePlusPlusPluginStatus>): Record<string, unknown> {
  return {
    description,
    args: {},
    async execute(): Promise<string> {
      return renderOpenCodePlusPlusPluginStatus(action());
    }
  };
}

interface HarnessToolRuntimeContext {
  sessionID?: unknown;
  sessionId?: unknown;
  agent?: unknown;
}

interface HarnessToolGate {
  root: string;
  isEnabled: () => boolean;
  isActive: (agent: unknown, sessionId?: string) => boolean;
}

function harnessTool(
  description: string,
  args: Record<string, { type: string }>,
  execute: (input: unknown) => Promise<string>,
  gate: HarnessToolGate
): Record<string, unknown> {
  return {
    description,
    args,
    async execute(input: unknown = {}, runtimeContext: HarnessToolRuntimeContext = {}): Promise<string> {
      const sessionId = stringValue(runtimeContext.sessionID ?? runtimeContext.sessionId);
      if (!gate.isEnabled()) {
        return renderInactiveHarnessTool(
          gate.root,
          "OPENCODE_PLUSPLUS_DISABLED",
          "OpenCode++ is disabled in plugin state.",
          "Enable OpenCode++ before starting a new OpenCode++ turn."
        );
      }
      if (!gate.isActive(runtimeContext.agent, sessionId)) {
        return renderInactiveHarnessTool(
          gate.root,
          "HARNESS_INACTIVE_AGENT",
          "OpenCode++ Harness is inactive for the selected OpenCode agent.",
          "Select the OpenCode++ mode and send a new message. Changing the selector does not cancel the turn already running."
        );
      }
      return execute(withRuntimeSession(input, sessionId));
    }
  };
}

function renderInactiveHarnessTool(root: string, code: string, message: string, nextStep: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: "opencode-plusplus.desktop-availability.v1",
      repository: root,
      ok: false,
      active: false,
      error: {
        code,
        message,
        attribution: code === "HARNESS_INACTIVE_AGENT" ? "opencode-host" : "opencode-plusplus",
        retryable: false,
        nextStep
      },
      humanReadable: `${message} ${nextStep}`
    },
    null,
    2
  )}\n`;
}

function withRuntimeSession(input: unknown, sessionId?: string): unknown {
  if (!sessionId) return input;
  const args = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
  if (typeof args.sessionId !== "string" && typeof args.sessionID !== "string") args.sessionId = sessionId;
  return args;
}

function sessionIdFromEvent(event: Record<string, unknown>): string | undefined {
  const properties = recordValue(event.properties);
  const info = recordValue(properties.info ?? event.info);
  return stringValue(properties.sessionID ?? properties.sessionId ?? event.sessionID ?? event.sessionId ?? info.id);
}

function sessionIdFromRecord(value: unknown): string | undefined {
  const record = recordValue(value);
  return stringValue(record.sessionID ?? record.sessionId);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hookKey(tool: unknown, args: unknown, callId?: string): string {
  return callId ? `call:${callId}` : toolKey(tool, args);
}
