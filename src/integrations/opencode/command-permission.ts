export type OpenCodeSidecarCommandDisposition = "allowed" | "approval-required" | "policy-blocked";

export type OpenCodeSidecarCommandAuthority = "none" | "opencode-permission" | "opencode-plusplus-policy";

export interface CommandFindingClassification {
  disposition: OpenCodeSidecarCommandDisposition;
  authority: OpenCodeSidecarCommandAuthority;
}

export interface CommandFindingLike {
  kind: string;
  severity: string;
  rule?: string;
  disposition?: OpenCodeSidecarCommandDisposition;
  authority?: OpenCodeSidecarCommandAuthority;
}

export function classifyCommandFinding(finding: CommandFindingLike): CommandFindingClassification {
  if (finding.disposition && finding.authority) return { disposition: finding.disposition, authority: finding.authority };
  if (finding.kind === "approval_required" || finding.kind === "external_path") {
    return { disposition: "approval-required", authority: "opencode-permission" };
  }
  if (finding.severity === "warning" && finding.rule === "dependency-build-output-uncertain") {
    return { disposition: "allowed", authority: "none" };
  }
  return { disposition: "policy-blocked", authority: "opencode-plusplus-policy" };
}

export function summarizeCommandFindings(findings: readonly CommandFindingLike[]): {
  disposition: OpenCodeSidecarCommandDisposition;
  allowed: boolean;
  approvalRequired: boolean;
} {
  const classifications = findings.map(classifyCommandFinding);
  if (classifications.some((finding) => finding.disposition === "policy-blocked")) {
    return { disposition: "policy-blocked", allowed: false, approvalRequired: false };
  }
  if (classifications.some((finding) => finding.disposition === "approval-required")) {
    return { disposition: "approval-required", allowed: true, approvalRequired: true };
  }
  return { disposition: "allowed", allowed: true, approvalRequired: false };
}
