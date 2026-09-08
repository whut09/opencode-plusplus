export const VERIFIED_OPENCODE_PLUGIN_API_VERSION = "1.18.18";

export const OPENCODE_AGENT_PERMISSION_KEYS = ["edit", "bash", "webfetch", "doom_loop", "external_directory"] as const;

export type OpenCodeAgentPermissionKey = (typeof OPENCODE_AGENT_PERMISSION_KEYS)[number];

export const OPENCODE_PLUSPLUS_PERMISSION_BOUNDARY = {
  hostOwns: ["user authorization", "normal edit policy", "permission prompts"],
  pluginOwns: ["task boundaries", "protected paths", "evidence integrity", "artifact integrity"],
  approvalRequiredCommands: ["package installation", "network-affecting commands", "external paths", "git push"],
  policyBlockedCommands: ["destructive commands", "unknown project commands", "generated artifact edits", "evidence tampering"]
} as const;
