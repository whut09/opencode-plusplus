export type HarnessDecisionAction =
  | "finalize"
  | "repair"
  | "repack"
  | "run-tests"
  | "rollback"
  | "block"
  | "human-review"
  | "executor-failure"
  | "no-progress"
  | "max-loops-reached";

export type HumanReviewReasonCode =
  | "NO_EXECUTABLE_TEST"
  | "BOUNDARY_EXPANSION_REQUIRED"
  | "EXTERNAL_SIDE_EFFECT"
  | "UNVERIFIABLE_RESULT"
  | "PLUGIN_FAILURE"
  | "AMBIGUOUS_REPOSITORY_STATE";

export type HumanReviewStatus = "pending" | "approved" | "rejected" | "resumed" | "resolved";

export interface HumanReviewRequest {
  schemaVersion: "opencode-plusplus.human-review.v1";
  revision?: number;
  requestId: string;
  taskId: string | null;
  sessionId: string | null;
  reasonCode: HumanReviewReasonCode;
  title: string;
  explanation: string;
  requiredUserAction: string;
  suggestedCommands: string[];
  affectedFiles: string[];
  resumeCondition: string;
  status: HumanReviewStatus;
  currentBoundary?: string[];
  requestedBoundary?: string[];
  boundaryRevision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRef {
  path: string;
  kind?: "context" | "trace" | "policy" | "guard" | "loop" | "decision" | "report" | "diff" | "checkpoint" | "run" | "other";
  description?: string;
}

export type HarnessDecisionCandidateSource = "executor" | "policy" | "guard-gate" | "loop" | "risk" | "fallback";

export interface HarnessDecisionCandidate {
  id: string;
  source: HarnessDecisionCandidateSource;
  action: HarnessDecisionAction;
  priority: number;
  blocking: boolean;
  confidence: number;
  reasons: string[];
  requiredCommands: string[];
  artifacts: ArtifactRef[];
  interventionIds?: string[];
}

export interface HarnessDecisionArbitration {
  selectedCandidate: HarnessDecisionCandidate;
  selectedPriority: number;
  supportingCandidates: HarnessDecisionCandidate[];
  interventionIds?: string[];
}

export interface HarnessDecision {
  action: HarnessDecisionAction;
  blocking: boolean;
  confidence: number;
  reasons: string[];
  requiredCommands: string[];
  artifacts: ArtifactRef[];
  interventionIds?: string[];
  humanReview?: HumanReviewRequest;
  arbitration?: HarnessDecisionArbitration;
}

export type InterventionStatus = "observed" | "prevented" | "requested" | "repaired" | "verified" | "unresolved" | "human-review" | "stale";

export type InterventionPhase = "plan" | "prepare" | "retrieve" | "execute" | "collect" | "evaluate" | "decide" | "persist" | "finalize";
export type InterventionCategory =
  | "boundary"
  | "evidence"
  | "policy"
  | "context"
  | "hallucination"
  | "regression"
  | "repair"
  | "executor"
  | "decision"
  | "other";
export type InterventionSource = "guard" | "policy" | "evidence" | "executor" | "decision" | "human" | "system";

export interface ResolutionEvidence {
  kind: "command" | "ci" | "manual" | "trace";
  ref: string;
  workingTreeHash?: string;
  currentWorkingTree?: boolean;
  valid: boolean;
  details?: string[];
}

export interface InterventionEvent {
  schemaVersion: "opencode-plusplus.intervention.v1";
  revision?: number;
  eventId: string;
  sequence?: number;
  interventionId: string;
  taskId: string;
  sessionId: string;
  timestamp: string;
  phase: InterventionPhase;
  category: InterventionCategory;
  findingId?: string;
  problem: string;
  targetFiles: string[];
  action: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  evidenceRefs: string[];
  status: InterventionStatus;
  confidence: number;
  source: InterventionSource;
  resolutionEvidence?: ResolutionEvidence[];
  supersedes?: string[];
  traceRefs?: string[];
  decisionRefs?: string[];
}

export interface InterventionSummary {
  total: number;
  byStatus: Record<InterventionStatus, number>;
  active: InterventionEvent[];
  verified: InterventionEvent[];
}

export type GuardResultSource = "policy" | "hallucination" | "regression" | "context" | "boundary" | "evidence";
export type GuardResultKind = "forbidden" | "required" | "risk" | "info";
export type GuardResultStatus = "failed" | "missing" | "warning" | "satisfied" | "passed";
export type GuardResultSeverity = "error" | "warning" | "required" | "info";

export interface GuardResult {
  id: string;
  source: GuardResultSource;
  kind: GuardResultKind;
  status: GuardResultStatus;
  severity: GuardResultSeverity;
  message: string;
  blocking: boolean;
  confidence: number;
  reasons: string[];
  requiredCommands: string[];
  artifacts: ArtifactRef[];
  file?: string;
  evidence: string[];
  interventionIds?: string[];
}

export function createHarnessDecision(input: HarnessDecision): HarnessDecision {
  return {
    action: input.action,
    blocking: input.blocking,
    confidence: clampConfidence(input.confidence),
    reasons: dedupe(input.reasons.filter(Boolean)),
    requiredCommands: dedupe(input.requiredCommands.filter(Boolean)),
    artifacts: dedupeArtifacts(input.artifacts),
    ...(input.interventionIds ? { interventionIds: dedupe(input.interventionIds.filter(Boolean)).sort((a, b) => a.localeCompare(b)) } : {}),
    ...(input.arbitration ? { arbitration: normalizeArbitration(input.arbitration) } : {})
  };
}

export function createGuardResult(input: GuardResult): GuardResult {
  return {
    ...input,
    confidence: clampConfidence(input.confidence),
    reasons: dedupe(input.reasons.filter(Boolean)),
    requiredCommands: dedupe(input.requiredCommands.filter(Boolean)),
    artifacts: dedupeArtifacts(input.artifacts),
    evidence: dedupe(input.evidence.filter(Boolean)),
    ...(input.interventionIds ? { interventionIds: dedupe(input.interventionIds.filter(Boolean)).sort((a, b) => a.localeCompare(b)) } : {})
  };
}

export function clampConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function dedupeArtifacts(items: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const result: ArtifactRef[] = [];
  for (const item of items) {
    const key = `${item.kind ?? "other"}:${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeArbitration(arbitration: HarnessDecisionArbitration): HarnessDecisionArbitration {
  return {
    selectedCandidate: normalizeCandidate(arbitration.selectedCandidate),
    selectedPriority: arbitration.selectedPriority,
    supportingCandidates: arbitration.supportingCandidates.map(normalizeCandidate),
    ...(arbitration.interventionIds ? { interventionIds: dedupe(arbitration.interventionIds.filter(Boolean)).sort((a, b) => a.localeCompare(b)) } : {})
  };
}

function normalizeCandidate(candidate: HarnessDecisionCandidate): HarnessDecisionCandidate {
  return {
    ...candidate,
    confidence: clampConfidence(candidate.confidence),
    reasons: dedupe(candidate.reasons.filter(Boolean)),
    requiredCommands: dedupe(candidate.requiredCommands.filter(Boolean)),
    artifacts: dedupeArtifacts(candidate.artifacts),
    ...(candidate.interventionIds ? { interventionIds: dedupe(candidate.interventionIds.filter(Boolean)).sort((a, b) => a.localeCompare(b)) } : {})
  };
}
