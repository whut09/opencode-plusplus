import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const MODEL_VISIBLE_HARNESS_TOOLS = ["prepare", "retrieve", "evaluate", "next", "dashboard"] as const;
export type ModelVisibleHarnessTool = (typeof MODEL_VISIBLE_HARNESS_TOOLS)[number];

export interface HarnessUxToolCall {
  tool: string;
  args: unknown;
  decision?: string;
  nextAction?: string;
  workingTreeHash?: string;
}

export interface HarnessUxMetrics {
  scenarioId: string;
  harnessToolCalls: number;
  modelVisibleHarnessSteps: number;
  automaticRuntimeSteps: number;
  duplicateEvaluations: number;
  userInterruptions: number;
  userApprovals: number;
  humanReviews: number;
  verificationCommands: number;
  finalDecision: string | null;
  toolCalls: HarnessUxToolCall[];
  runtimeEvents: string[];
}

export interface HarnessToolLike {
  execute: (args?: unknown, context?: unknown) => Promise<string>;
  [key: string]: unknown;
}

export interface PluginLike {
  tool?: Record<string, HarnessToolLike>;
}

export function createHarnessUxMetrics(scenarioId: string): HarnessUxMetrics {
  return {
    scenarioId,
    harnessToolCalls: 0,
    modelVisibleHarnessSteps: 0,
    automaticRuntimeSteps: 0,
    duplicateEvaluations: 0,
    userInterruptions: 0,
    userApprovals: 0,
    humanReviews: 0,
    verificationCommands: 0,
    finalDecision: null,
    toolCalls: [],
    runtimeEvents: []
  };
}

export function instrumentHarnessTools(plugin: PluginLike, metrics: HarnessUxMetrics): Record<string, HarnessToolLike> {
  const source = plugin.tool ?? {};
  return Object.fromEntries(
    Object.entries(source).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (args?: unknown, context?: unknown): Promise<string> => {
          const shortName = name.startsWith("opencode_plusplus_") ? name.slice("opencode_plusplus_".length) : name;
          const call: HarnessUxToolCall = { tool: shortName, args };
          metrics.harnessToolCalls += 1;
          if (MODEL_VISIBLE_HARNESS_TOOLS.includes(shortName as ModelVisibleHarnessTool)) metrics.modelVisibleHarnessSteps += 1;
          const output = await tool.execute(args, context);
          observeHarnessResult(metrics, call, output);
          metrics.toolCalls.push(call);
          return output;
        }
      }
    ])
  );
}

export function recordVerificationCommand(metrics: HarnessUxMetrics, command: string, exitCode: number): void {
  if (command.trim() && Number.isInteger(exitCode)) metrics.verificationCommands += 1;
}

export function recordUserInterruption(metrics: HarnessUxMetrics): void {
  metrics.userInterruptions += 1;
}

export function recordUserApproval(metrics: HarnessUxMetrics): void {
  metrics.userApprovals += 1;
}

export function observeRuntimeTrace(metrics: HarnessUxMetrics, root: string): HarnessUxMetrics {
  const eventLog = path.join(root, ".agent-context", "traces", "opencode-sidecar-events.jsonl");
  if (!existsSync(eventLog)) return metrics;
  const events = readFileSync(eventLog, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { type?: unknown });
  metrics.runtimeEvents = events.map((event) => (typeof event.type === "string" ? event.type : "unknown"));
  metrics.automaticRuntimeSteps = events.filter((event) => event.type !== "sidecar.log").length;
  return metrics;
}

function observeHarnessResult(metrics: HarnessUxMetrics, call: HarnessUxToolCall, output: string): void {
  let result: { decision?: unknown; nextAction?: unknown; workingTreeHash?: unknown; blocking?: unknown };
  try {
    result = JSON.parse(output) as typeof result;
  } catch {
    return;
  }
  call.decision = typeof result.decision === "string" ? result.decision : undefined;
  call.nextAction = typeof result.nextAction === "string" ? result.nextAction : undefined;
  call.workingTreeHash = typeof result.workingTreeHash === "string" ? result.workingTreeHash : undefined;
  if (typeof result.decision === "string") metrics.finalDecision = result.decision;
  if (result.decision === "human-review" || result.nextAction === "human-review") metrics.humanReviews += 1;
  if (call.tool !== "evaluate") return;
  const previous = [...metrics.toolCalls].reverse().find((item) => item.tool === "evaluate");
  if (previous && stableJson(previous.args) === stableJson(call.args) && previous.workingTreeHash === call.workingTreeHash) metrics.duplicateEvaluations += 1;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
