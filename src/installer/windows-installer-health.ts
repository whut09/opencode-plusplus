import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readJsonDiagnostic } from "../core/atomic-store.js";
import { getOpenCodePlusplusPackageVersion } from "../core/package-info.js";
import { readOpenCodePlusPlusPluginStatus } from "../integrations/opencode/plugin-runtime/state.js";
import type { WindowsInstallPaths } from "./windows-installer.js";

export const WINDOWS_INSTALLER_HEALTH_SCHEMA_VERSION = 1;
export const OPEN_CODE_PLUS_PLUS_PLUGIN_VERSION_MARKER = "OPENCODE_PLUS_PLUS_PLUGIN_VERSION";

export type WindowsInstallerHealthProblemCode =
  | "CONFIG_PATH_INVALID"
  | "CONFIG_PATH_UNWRITABLE"
  | "PLUGIN_MISSING"
  | "PLUGIN_INVALID"
  | "PLUGIN_VERSION_UNKNOWN"
  | "PLUGIN_VERSION_MISMATCH"
  | "AGENT_MISSING"
  | "AGENT_INVALID"
  | "STATE_MISSING"
  | "STATE_CORRUPT"
  | "STATE_SCHEMA_UNSUPPORTED"
  | "STATE_VERSION_MISMATCH"
  | "MANIFEST_MISSING"
  | "MANIFEST_CORRUPT"
  | "MANIFEST_MISMATCH";

export interface WindowsInstallerHealthProblem {
  code: WindowsInstallerHealthProblemCode;
  severity: "warning" | "error";
  message: string;
  path?: string;
}

export interface WindowsInstallerFileState {
  status: "missing" | "valid" | "corrupt" | "unsupported";
  path: string;
  version: string | null;
  revision: number | null;
  diagnostic: string | null;
}

export interface WindowsInstallerHealthReport {
  schemaVersion: typeof WINDOWS_INSTALLER_HEALTH_SCHEMA_VERSION;
  checkedAt: string;
  version: string;
  configPath: string;
  pluginTarget: string;
  agentTarget: string;
  stateFile: string;
  manifestFile: string;
  configDirectoryExists: boolean;
  configDirectoryWritable: boolean;
  openCodeProcessDetected: boolean;
  existingInstallationVersion: string | null;
  pluginInstalled: boolean;
  pluginVersion: string | null;
  agentInstalled: boolean;
  enabled: boolean;
  installed: boolean;
  healthy: boolean;
  manifest: WindowsInstallerFileState;
  runtimeState: WindowsInstallerFileState;
  problems: WindowsInstallerHealthProblem[];
  recommendedActions: string[];
}

export interface WindowsInstallerHealthOptions {
  now?: () => Date;
  isOpenCodeDesktopRunning?: () => boolean;
}

export function inspectWindowsOpenCodeInstallation(paths: WindowsInstallPaths, options: WindowsInstallerHealthOptions = {}): WindowsInstallerHealthReport {
  const version = getOpenCodePlusplusPackageVersion();
  const stateStatus = readOpenCodePlusPlusPluginStatus(paths.stateFile);
  const runtimeState = readRuntimeState(paths.stateFile, stateStatus);
  const manifest = readManifest(paths.manifestFile);
  const pluginInstalled = existsSync(paths.pluginFile);
  const agentInstalled = existsSync(paths.agentFile);
  const pluginSource = pluginInstalled ? readText(paths.pluginFile) : null;
  const pluginValid = pluginSource !== null && pluginSource.includes("OpenCodePlusPlusGlobalPlugin");
  const pluginVersion = pluginSource ? extractPluginVersion(pluginSource) : null;
  const agentSource = agentInstalled ? readText(paths.agentFile) : null;
  const agentValid = agentSource !== null && /^mode:\s*primary\s*$/m.test(agentSource) && agentSource.includes("opencode_plusplus_prepare");
  const openCodeProcessDetected = (options.isOpenCodeDesktopRunning ?? isOpenCodeDesktopRunning)();
  const configDirectoryWritable = canWriteConfigPath(paths.configDir);
  const problems: WindowsInstallerHealthProblem[] = [];

  if (!isDirectoryOrMissing(paths.configDir)) {
    problems.push({
      code: "CONFIG_PATH_INVALID",
      severity: "error",
      message: "The OpenCode config path exists but is not a directory.",
      path: paths.configDir
    });
  }
  if (!configDirectoryWritable) {
    problems.push({
      code: "CONFIG_PATH_UNWRITABLE",
      severity: "error",
      message: "The OpenCode config directory is not writable for the current user.",
      path: paths.configDir
    });
  }
  if (!pluginInstalled) {
    problems.push({
      code: "PLUGIN_MISSING",
      severity: "error",
      message: "The OpenCode++ plugin file is missing.",
      path: paths.pluginFile
    });
  } else if (!pluginValid) {
    problems.push({
      code: "PLUGIN_INVALID",
      severity: "error",
      message: "The OpenCode++ plugin file does not contain the expected plugin entry.",
      path: paths.pluginFile
    });
  } else if (pluginVersion === null) {
    problems.push({
      code: "PLUGIN_VERSION_UNKNOWN",
      severity: "warning",
      message: "The installed plugin has no OpenCode++ version marker; run --repair to refresh it.",
      path: paths.pluginFile
    });
  } else if (pluginVersion !== version) {
    problems.push({
      code: "PLUGIN_VERSION_MISMATCH",
      severity: "error",
      message: `The installed plugin is version ${pluginVersion}, but this installer is version ${version}.`,
      path: paths.pluginFile
    });
  }
  if (!agentInstalled) {
    problems.push({
      code: "AGENT_MISSING",
      severity: "error",
      message: "The OpenCode++ primary agent file is missing.",
      path: paths.agentFile
    });
  } else if (!agentValid) {
    problems.push({
      code: "AGENT_INVALID",
      severity: "error",
      message: "The OpenCode++ agent file is not the expected primary mode.",
      path: paths.agentFile
    });
  }
  if (runtimeState.status === "missing") {
    problems.push({ code: "STATE_MISSING", severity: "error", message: "The OpenCode++ runtime state file is missing.", path: paths.stateFile });
  } else if (runtimeState.status === "corrupt") {
    problems.push({
      code: "STATE_CORRUPT",
      severity: "error",
      message: runtimeState.diagnostic ?? "The OpenCode++ runtime state file is corrupt.",
      path: paths.stateFile
    });
  } else if (runtimeState.status === "unsupported") {
    problems.push({
      code: "STATE_SCHEMA_UNSUPPORTED",
      severity: "error",
      message: runtimeState.diagnostic ?? "The OpenCode++ runtime state schema is unsupported.",
      path: paths.stateFile
    });
  } else if (runtimeState.version !== null && runtimeState.version !== version) {
    problems.push({
      code: "STATE_VERSION_MISMATCH",
      severity: "error",
      message: `The runtime state is version ${runtimeState.version}, but this installer is version ${version}.`,
      path: paths.stateFile
    });
  }
  if (manifest.status === "missing") {
    problems.push({ code: "MANIFEST_MISSING", severity: "error", message: "The OpenCode++ installation manifest is missing.", path: paths.manifestFile });
  } else if (manifest.status === "corrupt") {
    problems.push({
      code: "MANIFEST_CORRUPT",
      severity: "error",
      message: manifest.diagnostic ?? "The OpenCode++ installation manifest is corrupt.",
      path: paths.manifestFile
    });
  } else if (!manifestMatches(manifest, version, paths)) {
    problems.push({
      code: "MANIFEST_MISMATCH",
      severity: "error",
      message: "The installation manifest does not match the current OpenCode++ files or version.",
      path: paths.manifestFile
    });
  }

  const installed = pluginInstalled || agentInstalled || manifest.status !== "missing" || runtimeState.status !== "missing";
  const healthy = installed && problems.length === 0;
  return {
    schemaVersion: WINDOWS_INSTALLER_HEALTH_SCHEMA_VERSION,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    version,
    configPath: paths.configDir,
    pluginTarget: paths.pluginFile,
    agentTarget: paths.agentFile,
    stateFile: paths.stateFile,
    manifestFile: paths.manifestFile,
    configDirectoryExists: existsSync(paths.configDir),
    configDirectoryWritable,
    openCodeProcessDetected,
    existingInstallationVersion: manifest.version ?? runtimeState.version,
    pluginInstalled,
    pluginVersion,
    agentInstalled,
    enabled: stateStatus.enabled,
    installed,
    healthy,
    manifest,
    runtimeState,
    problems,
    recommendedActions: recommendedActions(problems, installed, openCodeProcessDetected)
  };
}

export function assertWindowsInstallerMutationAllowed(
  health: WindowsInstallerHealthReport,
  action: "install" | "repair" | "uninstall" | "enable" | "disable"
): void {
  if (health.openCodeProcessDetected) {
    throw new Error("OpenCode Desktop is running. Fully exit OpenCode Desktop before running the OpenCode++ installer.");
  }
  if (health.problems.some((problem) => problem.code === "CONFIG_PATH_INVALID" || problem.code === "CONFIG_PATH_UNWRITABLE")) {
    throw new Error(`Cannot ${action} OpenCode++: the OpenCode config directory is invalid or not writable (${health.configPath}).`);
  }
  if (action === "install" && health.problems.some((problem) => problem.code === "STATE_CORRUPT" || problem.code === "MANIFEST_CORRUPT")) {
    const damaged = health.problems
      .filter((problem) => problem.code === "STATE_CORRUPT" || problem.code === "MANIFEST_CORRUPT")
      .map((problem) => (problem.code === "STATE_CORRUPT" ? "corrupt state file" : "corrupt installation manifest"))
      .join(" and ");
    throw new Error(`Cannot install over ${damaged}. Run --repair first, or use --doctor --json for details.`);
  }
  if (action !== "uninstall" && action !== "repair" && health.problems.some((problem) => problem.code === "STATE_CORRUPT")) {
    throw new Error(`Cannot ${action} OpenCode++ while its state file is corrupt. Run --repair first.`);
  }
}

export function renderWindowsInstallerHealth(report: WindowsInstallerHealthReport): string {
  const problemLines = report.problems.length
    ? report.problems.map((problem) => `- [${problem.severity.toUpperCase()}] ${problem.code}: ${problem.message}`)
    : ["- none"];
  const actionLines = report.recommendedActions.length ? report.recommendedActions.map((action) => `- ${action}`) : ["- none"];
  return [
    "OpenCode++ Doctor",
    "",
    `Version: ${report.version}`,
    `Config: ${report.configPath}`,
    `Plugin: ${report.pluginInstalled ? "installed" : "missing"}${report.pluginVersion ? ` (${report.pluginVersion})` : ""}`,
    `Agent: ${report.agentInstalled ? "installed" : "missing"}`,
    `Enabled: ${report.enabled ? "yes" : "no"}`,
    `Manifest: ${report.manifest.status}`,
    `Runtime state: ${report.runtimeState.status}`,
    `OpenCode Desktop process: ${report.openCodeProcessDetected ? "detected" : "not detected"}`,
    `Overall: ${report.healthy ? "healthy" : report.installed ? "needs attention" : "not installed"}`,
    "",
    "Problems:",
    ...problemLines,
    "",
    "Recommended actions:",
    ...actionLines
  ].join("\n");
}

export function extractPluginVersion(source: string): string | null {
  const match = source.match(new RegExp(`${OPEN_CODE_PLUS_PLUS_PLUGIN_VERSION_MARKER}:\\s*([^\\s*]+)`));
  return match?.[1] ?? null;
}

function readRuntimeState(filePath: string, status: ReturnType<typeof readOpenCodePlusPlusPluginStatus>): WindowsInstallerFileState {
  const result = readJsonDiagnostic<Record<string, unknown>>(filePath);
  if (result.status === "missing") return { status: "missing", path: filePath, version: null, revision: null, diagnostic: null };
  if (result.status === "corrupt") return { status: "corrupt", path: filePath, version: null, revision: null, diagnostic: result.error };
  if (!isRecord(result.value)) {
    return { status: "corrupt", path: filePath, version: null, revision: null, diagnostic: "Runtime state must be a JSON object." };
  }
  const schemaVersion = result.value.schemaVersion;
  const supported = schemaVersion === 1;
  return {
    status: supported ? "valid" : "unsupported",
    path: filePath,
    version: stringValue(result.value.version) ?? status.version,
    revision: numberValue(result.value.revision),
    diagnostic: supported ? status.diagnostic : `Unsupported state schema ${String(schemaVersion)}.`
  };
}

function readManifest(filePath: string): WindowsInstallerFileState & { version: string | null; plugin?: unknown; mode?: unknown; agent?: unknown } {
  const result = readJsonDiagnostic<Record<string, unknown>>(filePath);
  if (result.status === "missing") return { status: "missing", path: filePath, version: null, revision: null, diagnostic: null };
  if (result.status === "corrupt") return { status: "corrupt", path: filePath, version: null, revision: null, diagnostic: result.error };
  if (!isRecord(result.value)) {
    return { status: "corrupt", path: filePath, version: null, revision: null, diagnostic: "Installation manifest must be a JSON object." };
  }
  return {
    status: typeof result.value.schemaVersion === "number" ? "valid" : "unsupported",
    path: filePath,
    version: stringValue(result.value.version),
    revision: numberValue(result.value.revision),
    diagnostic: typeof result.value.schemaVersion === "number" ? null : "Installation manifest has no numeric schemaVersion.",
    plugin: result.value.plugin,
    mode: result.value.mode,
    agent: result.value.agent
  };
}

function manifestMatches(
  manifest: WindowsInstallerFileState & { version: string | null; plugin?: unknown; mode?: unknown; agent?: unknown },
  version: string,
  paths: WindowsInstallPaths
): boolean {
  return (
    manifest.status === "valid" &&
    manifest.version === version &&
    manifest.plugin === path.basename(paths.pluginFile) &&
    manifest.agent === path.relative(paths.configDir, paths.agentFile).replaceAll("\\", "/") &&
    manifest.mode === "opencode-plusplus"
  );
}

function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isDirectoryOrMissing(directory: string): boolean {
  if (!existsSync(directory)) return true;
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function canWriteDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function recommendedActions(problems: WindowsInstallerHealthProblem[], installed: boolean, openCodeProcessDetected: boolean): string[] {
  if (problems.some((problem) => problem.code === "CONFIG_PATH_INVALID")) return ["Set OPENCODE_CONFIG_DIR to a directory used by OpenCode Desktop."];
  if (problems.some((problem) => problem.code === "CONFIG_PATH_UNWRITABLE")) return ["Choose a writable OpenCode config directory or fix its permissions."];
  if (!installed) return ["Run the OpenCode++ Windows installer."];
  if (problems.some((problem) => problem.code === "STATE_CORRUPT" || problem.code === "MANIFEST_CORRUPT")) {
    return [
      ...(openCodeProcessDetected ? ["Fully exit OpenCode Desktop before changing the installation."] : []),
      "Run the installer with --repair.",
      "Use --doctor --json to inspect the diagnostic report."
    ];
  }
  if (problems.length > 0) {
    return [
      ...(openCodeProcessDetected ? ["Fully exit OpenCode Desktop before changing the installation."] : []),
      "Run the installer with --repair.",
      "Restart OpenCode Desktop after repair."
    ];
  }
  return ["Restart OpenCode Desktop after changing enabled state or upgrading the plugin."];
}

function canWriteConfigPath(directory: string): boolean {
  if (existsSync(directory)) return canWriteDirectory(directory);
  let current = path.resolve(directory);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return canWriteDirectory(current);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenCodeDesktopRunning(): boolean {
  if (process.platform !== "win32") return false;
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq OpenCode.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 && /"OpenCode\.exe"/i.test(result.stdout);
}
