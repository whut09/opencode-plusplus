import type {
  PluginContextGetArgs,
  PluginContextSearchArgs,
  PluginContextStatusArgs,
  PluginDashboardArgs,
  PluginEvaluateArgs,
  PluginFeedbackArgs,
  PluginHumanReviewArgs,
  PluginHarnessTaskType,
  PluginInterventionsArgs,
  PluginNextArgs,
  PluginPrepareArgs,
  PluginRetrieveArgs
  ,PluginResumeArgs
} from "./types.js";

export function parseContextSearchArgs(args: unknown): PluginContextSearchArgs | string {
  const record = asRecord(args);
  const query = readOptionalString(record.query);
  const taskType = readSearchTaskType(record.taskType);
  if (taskType === false) return 'context search taskType must be "auto", "bugfix", "feature", or "refactor".';
  const topK = record.topK === undefined ? undefined : readPositiveInteger(record.topK);
  if (record.topK !== undefined && topK === undefined) return "context search topK must be a positive integer.";
  const tags = readOptionalStringArray(record.tags);
  if (tags === false) return "context search tags must be an array of non-empty strings.";
  const language = readOptionalString(record.language);
  const packageVersion = readOptionalString(record.packageVersion);
  const source = readOptionalString(record.source);
  return {
    ...(query ? { query } : {}),
    ...(topK ? { topK } : {}),
    ...(taskType ? { taskType } : {}),
    ...(language ? { language } : {}),
    ...(packageVersion ? { packageVersion } : {}),
    ...(source ? { source } : {}),
    ...(tags ? { tags } : {})
  };
}

export function parseContextGetArgs(args: unknown): PluginContextGetArgs | string {
  const record = asRecord(args);
  const entryId = readNonEmptyString(record.entryId);
  if (!entryId) return "context get requires a non-empty entryId.";
  const file = readOptionalString(record.file);
  if (record.full !== undefined && typeof record.full !== "boolean") return "context get full must be boolean.";
  if (record.withAnnotations !== undefined && typeof record.withAnnotations !== "boolean") return "context get withAnnotations must be boolean.";
  if (file && record.full === true) return "context get file cannot be combined with full.";
  const language = readOptionalString(record.language);
  const packageVersion = readOptionalString(record.packageVersion);
  const source = readOptionalString(record.source);
  return {
    entryId,
    ...(language ? { language } : {}),
    ...(packageVersion ? { packageVersion } : {}),
    ...(source ? { source } : {}),
    ...(file ? { file } : {}),
    ...(record.full === true ? { full: true } : {}),
    ...(record.withAnnotations === true ? { withAnnotations: true } : {})
  };
}

export function parseContextStatusArgs(args: unknown): PluginContextStatusArgs | string {
  return parseOptionalTaskIdArgs(args, "context status");
}

export function parseInterventionsArgs(args: unknown): PluginInterventionsArgs | string {
  return parseOptionalTaskIdArgs(args, "interventions");
}

export function parseFeedbackArgs(args: unknown): PluginFeedbackArgs | string {
  const record = asRecord(args);
  const entryId = readNonEmptyString(record.entryId);
  const source = readNonEmptyString(record.source);
  const revision = readNonNegativeInteger(record.revision);
  const target = readFeedbackTarget(record.target);
  const label = readFeedbackLabel(record.label);
  if (!entryId || !source) return "context feedback requires entryId and source.";
  if (revision === undefined) return "context feedback revision must be a non-negative integer.";
  if (!target) return "context feedback target is invalid.";
  if (!label) return "context feedback label is invalid.";
  const file = readOptionalString(record.file);
  const retrievalId = readOptionalString(record.retrievalId);
  const interventionId = readOptionalString(record.interventionId);
  if (target === "file" && !file) return "file feedback requires file.";
  if (target === "retrieval-result" && !retrievalId) return "retrieval feedback requires retrievalId.";
  if (target === "intervention" && !interventionId) return "intervention feedback requires interventionId.";
  const version = readOptionalString(record.version);
  return {
    entryId,
    source,
    revision,
    target,
    label,
    ...(version ? { version } : {}),
    ...(file ? { file } : {}),
    ...(retrievalId ? { retrievalId } : {}),
    ...(interventionId ? { interventionId } : {})
  };
}

export function parseHumanReviewArgs(args: unknown): PluginHumanReviewArgs | string {
  const record = asRecord(args);
  const action = record.action === "approve" || record.action === "reject" ? record.action : undefined;
  if (!action) return 'human review action must be "approve" or "reject".';
  if (record.confirmed !== true) return "human review requires confirmed=true for an explicit user decision.";
  const taskId = readOptionalString(record.taskId);
  const sessionId = readOptionalSessionId(record.sessionId);
  const requestId = readOptionalString(record.requestId);
  return {
    action,
    confirmed: true,
    ...(taskId ? { taskId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(requestId ? { requestId } : {})
  };
}

export function parseResumeArgs(args: unknown): PluginResumeArgs | string {
  const record = asRecord(args);
  const action = record.action === "inspect" || record.action === "resume" ? record.action : undefined;
  if (!action) return 'resume action must be "inspect" or "resume".';
  if (record.confirmed !== undefined && typeof record.confirmed !== "boolean") return "resume confirmed must be boolean.";
  const taskId = readOptionalString(record.taskId);
  const sourceSessionId = readOptionalString(record.sourceSessionId);
  const sessionId = readOptionalSessionId(record.sessionId);
  if (action === "resume" && record.confirmed !== true) return "resume requires confirmed=true for an explicit recovery decision.";
  return {
    action,
    ...(taskId ? { taskId } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(record.confirmed === true ? { confirmed: true } : {})
  };
}

export function parsePrepareArgs(args: unknown): PluginPrepareArgs | string {
  const record = asRecord(args);
  const task = readNonEmptyString(record.task);
  if (!task) return "prepare requires a non-empty task.";
  const type = readTaskType(record.type);
  if (type === false) return 'prepare type must be "bugfix", "feature", or "refactor".';
  const sessionId = readOptionalSessionId(record.sessionId);
  if (record.forceRebuild !== undefined && typeof record.forceRebuild !== "boolean") return "prepare forceRebuild must be boolean.";
  return type
    ? { task, type, ...(sessionId ? { sessionId } : {}), ...(record.forceRebuild === true ? { forceRebuild: true } : {}) }
    : { task, ...(sessionId ? { sessionId } : {}), ...(record.forceRebuild === true ? { forceRebuild: true } : {}) };
}

export function parseRetrieveArgs(args: unknown): PluginRetrieveArgs | string {
  const record = asRecord(args);
  const task = readNonEmptyString(record.task);
  if (!task) return "retrieve requires a non-empty task.";
  const sessionId = readOptionalSessionId(record.sessionId);
  const taskType = readTaskType(record.taskType);
  if (taskType === false) return 'retrieve taskType must be "bugfix", "feature", or "refactor".';
  const contextId = readOptionalString(record.contextId);
  const file = readOptionalString(record.file);
  const annotationId = readOptionalString(record.annotationId);
  if (record.full !== undefined && typeof record.full !== "boolean") return "retrieve full must be boolean.";
  if (record.includeStaleAnnotation !== undefined && typeof record.includeStaleAnnotation !== "boolean")
    return "retrieve includeStaleAnnotation must be boolean.";
  if (file && !contextId) return "retrieve file requires contextId.";
  if (file && record.full === true) return "retrieve file cannot be combined with full.";
  if (record.topK === undefined)
    return {
      task,
      ...(taskType ? { taskType } : {}),
      ...(contextId ? { contextId } : {}),
      ...(file ? { file } : {}),
      ...(record.full ? { full: true } : {}),
      ...(annotationId ? { annotationId } : {}),
      ...(record.includeStaleAnnotation ? { includeStaleAnnotation: true } : {}),
      ...(sessionId ? { sessionId } : {})
    };
  const topK = readPositiveInteger(record.topK);
  if (topK === undefined) return "retrieve topK must be a positive integer.";
  return {
    task,
    topK,
    ...(taskType ? { taskType } : {}),
    ...(contextId ? { contextId } : {}),
    ...(file ? { file } : {}),
    ...(record.full ? { full: true } : {}),
    ...(annotationId ? { annotationId } : {}),
    ...(record.includeStaleAnnotation ? { includeStaleAnnotation: true } : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

export function parseEvaluateArgs(args: unknown): PluginEvaluateArgs | string {
  return parseOptionalTaskIdArgs(args, "evaluate");
}

export function parseDashboardArgs(args: unknown): PluginDashboardArgs | string {
  return parseOptionalTaskIdArgs(args, "dashboard");
}

export function parseNextArgs(args: unknown): PluginNextArgs | string {
  return parseOptionalTaskIdArgs(args, "next");
}

function parseOptionalTaskIdArgs(
  args: unknown,
  tool: "evaluate" | "next" | "dashboard" | "context status" | "interventions"
): { taskId?: string; sessionId?: string | null } | string {
  const record = asRecord(args);
  const sessionId = readOptionalSessionId(record.sessionId);
  if (record.taskId === undefined) return sessionId ? { sessionId } : {};
  const taskId = readNonEmptyString(record.taskId);
  if (!taskId) return `${tool} taskId must be a non-empty string when provided.`;
  return { taskId, ...(sessionId ? { sessionId } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalSessionId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTaskType(value: unknown): PluginHarnessTaskType | undefined | false {
  if (value === undefined) return undefined;
  return value === "bugfix" || value === "feature" || value === "refactor" ? value : false;
}

function readSearchTaskType(value: unknown): PluginContextSearchArgs["taskType"] | undefined | false {
  if (value === undefined) return undefined;
  return value === "auto" || value === "bugfix" || value === "feature" || value === "refactor" ? value : false;
}

function readOptionalStringArray(value: unknown): string[] | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return false;
  const values = value.map(readNonEmptyString);
  if (values.some((item) => item === undefined)) return false;
  return [...new Set(values as string[])].sort((left, right) => left.localeCompare(right));
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readFeedbackTarget(value: unknown): PluginFeedbackArgs["target"] | undefined {
  return value === "entry" || value === "file" || value === "retrieval-result" || value === "intervention" ? value : undefined;
}

function readFeedbackLabel(value: unknown): PluginFeedbackArgs["label"] | undefined {
  const labels = ["useful", "not-useful", "outdated", "inaccurate", "incomplete", "wrong-version", "wrong-example", "irrelevant"];
  return typeof value === "string" && labels.includes(value) ? (value as PluginFeedbackArgs["label"]) : undefined;
}
