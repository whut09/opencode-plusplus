export const OPENCODE_PLUSPLUS_PLUGIN_TOOL_NAMES = [
  "opencode_plusplus_enable",
  "opencode_plusplus_disable",
  "opencode_plusplus_status",
  "opencode_plusplus_dashboard",
  "opencode_plusplus_prepare",
  "opencode_plusplus_retrieve",
  "opencode_plusplus_context_search",
  "opencode_plusplus_context_get",
  "opencode_plusplus_context_status",
  "opencode_plusplus_interventions",
  "opencode_plusplus_context_feedback",
  "opencode_plusplus_human_review",
  "opencode_plusplus_resume",
  "opencode_plusplus_evaluate",
  "opencode_plusplus_next"
] as const;

export type OpenCodePlusPlusPluginToolName = (typeof OPENCODE_PLUSPLUS_PLUGIN_TOOL_NAMES)[number];

export type PluginHarnessTaskType = "bugfix" | "feature" | "refactor";

export const TASK_RESUME_SCHEMA_VERSION = "opencode-plusplus.task-resume.v1";

export type TaskResumeStatus = "active" | "dirty" | "verification-required" | "human-review" | "stale-task" | "completed" | "abandoned";

export interface TaskIdentity {
  schemaVersion: typeof TASK_RESUME_SCHEMA_VERSION;
  revision?: number;
  sessionId: string;
  repositoryRoot: string;
  taskId: string;
  baseWorkingTreeFingerprint: string;
  latestWorkingTreeFingerprint: string;
  status: TaskResumeStatus;
  updatedAt: string;
  resumedToSessionId?: string;
}

export type TaskResumeCompatibility = "resume-verification" | "stale-task" | "mismatched-repository" | "not-resumable";

export interface TaskResumeCandidate {
  identity: TaskIdentity;
  currentWorkingTreeFingerprint: string;
  repositoryMatches: boolean;
  workingTreeCompatible: boolean;
  compatibility: TaskResumeCompatibility;
  reason: string;
}

export type PluginResumeAction = "inspect" | "resume";

export interface PluginResumeArgs {
  taskId?: string;
  sourceSessionId?: string;
  sessionId?: string | null;
  action: PluginResumeAction;
  confirmed?: boolean;
}

export type PluginResumeStatus = "none" | "available" | "resumed" | "stale-task" | "human-review";

export interface PluginResumeState {
  status: PluginResumeStatus;
  candidates: TaskResumeCandidate[];
  selectedTaskId?: string;
  sourceSessionId?: string;
  message: string;
}
import type { InterventionStatus } from "../../../../harness/types.js";
import type { ResolutionEvidence } from "../../../../harness/types.js";
import type { HumanReviewRequest } from "../../../../harness/types.js";
import type { VerificationPlan } from "../../../../core/verification/types.js";

export interface PluginPrepareArgs {
  task: string;
  type?: PluginHarnessTaskType;
  sessionId?: string | null;
  forceRebuild?: boolean;
}

export interface PluginRetrieveArgs {
  task: string;
  topK?: number;
  taskType?: "bugfix" | "feature" | "refactor" | "auto";
  contextId?: string;
  file?: string;
  full?: boolean;
  annotationId?: string;
  includeStaleAnnotation?: boolean;
  sessionId?: string | null;
}

export interface PluginFeedbackArgs {
  entryId: string;
  source: string;
  version?: string;
  revision: number;
  target: "entry" | "file" | "retrieval-result" | "intervention";
  file?: string;
  retrievalId?: string;
  interventionId?: string;
  label: "useful" | "not-useful" | "outdated" | "inaccurate" | "incomplete" | "wrong-version" | "wrong-example" | "irrelevant";
}

export interface PluginHumanReviewArgs {
  taskId?: string;
  sessionId?: string | null;
  requestId?: string;
  action: "approve" | "reject";
  confirmed: boolean;
}

export interface PluginContextSearchArgs {
  query?: string;
  topK?: number;
  taskType?: "bugfix" | "feature" | "refactor" | "auto";
  language?: string;
  packageVersion?: string;
  source?: string;
  tags?: string[];
}

export interface PluginContextGetArgs {
  entryId: string;
  language?: string;
  packageVersion?: string;
  source?: string;
  file?: string;
  full?: boolean;
  withAnnotations?: boolean;
}

export interface PluginContextStatusArgs {
  taskId?: string;
  sessionId?: string | null;
}

export interface PluginInterventionsArgs {
  taskId?: string;
  sessionId?: string | null;
}

export interface PluginDashboardArgs {
  taskId?: string;
  sessionId?: string | null;
}

export interface PluginEvaluateArgs {
  taskId?: string;
  sessionId?: string | null;
}

export interface PluginNextArgs {
  taskId?: string;
  sessionId?: string | null;
}

export interface PluginHarnessSession {
  schemaVersion?: 1;
  revision?: number;
  taskId: string;
  task: string;
  type: PluginHarnessTaskType | "auto";
  sessionId?: string | null;
  updatedAt: string;
}

export interface PluginWorkflowState {
  schemaVersion?: 1;
  revision?: number;
  sessionId: string;
  phase: "created" | "prepared" | "editing" | "evaluated" | "next" | "finalize" | "blocked";
  taskId: string | null;
  contextFingerprint: string | null;
  initialWorkingTreeHash: string;
  currentWorkingTreeHash: string;
  editBoundary: { allowedEditGlobs: string[]; avoidEditGlobs: string[] };
  boundaryRevision: number;
  resumeCandidates?: TaskResumeCandidate[];
  resumedFromSessionId?: string;
  requiredTests: string[];
  lastEventKey: string | null;
  sourceChanged: boolean;
  updatedAt: string;
}

export type PluginHarnessToolKind = "prepare" | "retrieve" | "dashboard" | "evaluate" | "next" | "feedback" | "human-review" | "resume";
export type PluginTaskIdSource = "argument" | "session" | "created" | "none";

export type PluginPerformanceStatus = "completed" | "timeout";

export interface PluginPerformance {
  stage: "prepare" | "retrieve" | "evaluate";
  durationMs: number;
  targetMs: number;
  status: PluginPerformanceStatus;
  cache: "hit" | "miss";
  contextMode: "reused" | "incremental" | "rebuilt";
  selectedFiles: string[];
  rejectedFiles: string[];
}

export interface PluginInterventionRecord {
  interventionId: string;
  eventId: string;
  status: InterventionStatus;
  phase: string;
  category: string;
  findingId?: string;
  problem: string;
  targetFiles: string[];
  action: string;
  evidenceRefs: string[];
  confidence: number;
  source: string;
  timestamp: string;
  resolutionEvidence?: ResolutionEvidence[];
  traceRefs?: string[];
  decisionRefs?: string[];
}

export interface PluginContextAdvice {
  id: string;
  kind: string;
  disposition: "adopted" | "available" | "rejected";
  summary: string;
  reason: string;
  sourceFile?: string;
  suggestedCommand?: string;
}

export interface PluginInterventionSnapshot {
  ledgerPath: string;
  eventCount: number;
  selectedFiles: string[];
  excludedFiles: Array<{ path: string; reason: string }>;
  interventions: PluginInterventionRecord[];
  problems: string[];
  actions: string[];
  verifiedFixes: PluginInterventionRecord[];
  remainingProblems: PluginInterventionRecord[];
  humanReview: PluginInterventionRecord[];
  contextHelp?: string[];
  adoptedContextAdvice?: PluginContextAdvice[];
  rejectedContextAdvice?: PluginContextAdvice[];
  feedback?: PluginFeedbackSummary;
}

export interface PluginFeedbackSummary {
  kind: "maintainer-feedback";
  localOnly: boolean;
  networkEnabled: boolean;
  total: number;
  labels: Array<{ label: string; count: number }>;
  annotationSeparate: true;
  evidenceAuthority: false;
}

export interface PluginActionSummary {
  observed: string[];
  prevented: string[];
  requested: string[];
  repaired: string[];
  verified: string[];
  unresolved: string[];
  evidence: string[];
}

export interface PluginHarnessResult {
  schemaVersion: string;
  ok: boolean;
  tool: PluginHarnessToolKind;
  summary: string;
  humanReadable?: string;
  dashboard?: string;
  error?: {
    code: string;
    message: string;
    attribution?: "opencode-plusplus" | "opencode-host" | "model-provider" | "unknown";
    retryable?: boolean;
    nextStep?: string;
  };
  taskId: string | null;
  sessionId: string | null;
  taskIdSource: PluginTaskIdSource;
  repository: string;
  workingTreeHash: string;
  currentPhase: string;
  decision: string;
  blocking: boolean;
  findings: string[];
  missingEvidence: string[];
  requiredCommands: string[];
  mustInspect: string[];
  allowedEditGlobs: string[];
  avoidEditGlobs: string[];
  boundaryRevision?: number;
  artifacts: string[];
  nextAction: string;
  hits?: Array<{ path: string; score: number; reason: string; scoreBreakdown?: Record<string, number> }>;
  context?: import("../../../../context-registry/types.js").ContextFetchResult;
  performance?: PluginPerformance;
  verification?: VerificationPlan;
  interventions?: PluginInterventionSnapshot;
  humanReview?: HumanReviewRequest;
  resume?: PluginResumeState;
  actionSummary?: PluginActionSummary;
  compactStatus?: import("./compact-status.js").PluginCompactStatus;
  displayMode?: import("./compact-status.js").PluginHarnessDisplayMode;
  visualization?: import("./visualization.js").PluginHarnessVisualization;
}

export type PluginPrepareResult = PluginHarnessResult;
export type PluginRetrieveResult = PluginHarnessResult;
export type PluginEvaluateResult = PluginHarnessResult;
export type PluginNextResult = PluginHarnessResult;
export type PluginHumanReviewResult = PluginHarnessResult;
export type PluginResumeResult = PluginHarnessResult;

export interface PluginEvaluateState {
  schemaVersion: string;
  revision?: number;
  taskId: string;
  sessionId: string | null;
  taskIdSource: PluginTaskIdSource;
  workingTreeHash: string;
  currentPhase: string;
  decision: string;
  blocking: boolean;
  findings: string[];
  missingEvidence: string[];
  requiredCommands: string[];
  mustInspect: string[];
  allowedEditGlobs: string[];
  avoidEditGlobs: string[];
  boundaryRevision?: number;
  artifacts: string[];
  nextAction: string;
  summary: string;
  updatedAt: string;
  interventions?: PluginInterventionSnapshot;
  humanReview?: HumanReviewRequest;
  resume?: PluginResumeState;
  verification?: VerificationPlan;
  visualization?: import("./visualization.js").PluginHarnessVisualization;
}

export function emptyPluginInterventions(ledgerPath = ""): PluginInterventionSnapshot {
  return {
    ledgerPath,
    eventCount: 0,
    selectedFiles: [],
    excludedFiles: [],
    interventions: [],
    problems: [],
    actions: [],
    verifiedFixes: [],
    remainingProblems: [],
    humanReview: [],
    contextHelp: [],
    adoptedContextAdvice: [],
    rejectedContextAdvice: [],
    feedback: {
      kind: "maintainer-feedback",
      localOnly: true,
      networkEnabled: false,
      total: 0,
      labels: [],
      annotationSeparate: true,
      evidenceAuthority: false
    }
  };
}
