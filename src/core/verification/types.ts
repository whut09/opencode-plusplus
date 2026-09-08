export type VerificationChangeKind =
  | "docs-only"
  | "tests-only"
  | "config"
  | "source-local"
  | "source-cross-module"
  | "dependency"
  | "build-system"
  | "ci"
  | "security-sensitive";

export type VerificationCommandKind = "test" | "lint" | "typecheck" | "build" | "docs" | "contract" | "other";
export type VerificationScope = "file" | "package" | "workspace" | "repository";
export type VerificationCost = "low" | "medium" | "high";
export type VerificationConfidence = "high" | "medium" | "low";

export interface VerificationCommand {
  command: string;
  cwd: string;
  source: string;
  scope: VerificationScope;
  estimatedCost: VerificationCost;
  confidence: VerificationConfidence;
  reason: string;
  kind: VerificationCommandKind;
  packagePath?: string;
}

export interface VerificationDiscoveryReport {
  root: string;
  commands: VerificationCommand[];
  detectedFiles: string[];
  diagnostics: string[];
}

export interface VerificationChangeClassification {
  changedFiles: string[];
  kinds: VerificationChangeKind[];
  primaryKind: VerificationChangeKind;
  docsOnly: boolean;
  codeTestRequired: boolean;
  affectedPackages: string[];
  reason: string;
}

export interface VerificationPlannerOptions {
  changedFiles?: string[];
  docsBuildRequired?: boolean;
}

export interface VerificationPlan {
  classification: VerificationChangeClassification;
  discovery: VerificationDiscoveryReport;
  commands: VerificationCommand[];
  codeTestRequired: boolean;
  verificationRequired: boolean;
  reason: string;
}
