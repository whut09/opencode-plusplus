import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { readJsonDiagnostic, writeJsonAtomic, writeTextAtomic } from "../core/atomic-store.js";
import { getOpenCodePlusplusPackageVersion } from "../core/package-info.js";
import { PLUSPLUS_AGENT, PLUSPLUS_AGENT_FILE } from "./opencode-plusplus-prompts.js";
import {
  assertWindowsInstallerMutationAllowed,
  extractPluginVersion,
  inspectWindowsOpenCodeInstallation,
  renderWindowsInstallerHealth,
  type WindowsInstallerHealthOptions,
  type WindowsInstallerHealthReport
} from "./windows-installer-health.js";
import { readOpenCodePlusPlusPluginStatus, setOpenCodePlusPlusPluginEnabled } from "../integrations/opencode/plugin-runtime/state.js";

export const WINDOWS_INSTALLER_SCHEMA_VERSION = 2;
export const WINDOWS_PLUGIN_FILE = "opencode-plusplus.js";

export interface WindowsInstallerPayload {
  pluginGzipBase64: string;
}

export interface WindowsInstallPaths {
  configDir: string;
  pluginFile: string;
  stateFile: string;
  manifestFile: string;
  agentFile: string;
  legacyFiles: string[];
}

export interface WindowsInstallReport {
  action: "installed" | "uninstalled" | "enabled" | "disabled" | "status" | "repaired";
  ok: boolean;
  version: string;
  paths: WindowsInstallPaths;
  pluginExists: boolean;
  enabled: boolean;
  modeInstalled: boolean;
  commandsInstalled: number;
  agentFilesInstalled: number;
  legacyFilesRemoved: number;
  message: string;
  health: WindowsInstallerHealthReport;
  repairedItems: string[];
}

export function resolveWindowsInstallPaths(configDir = defaultOpenCodeConfigDir()): WindowsInstallPaths {
  const root = path.resolve(configDir);
  return {
    configDir: root,
    pluginFile: path.join(root, "plugins", WINDOWS_PLUGIN_FILE),
    stateFile: path.join(root, "opencode-plusplus", "state.json"),
    manifestFile: path.join(root, "opencode-plusplus", "installation.json"),
    agentFile: path.join(root, ...PLUSPLUS_AGENT_FILE.split("/")),
    legacyFiles: ["opencode-plusplus-on.md", "opencode-plusplus-off.md", "opencode-plusplus-status.md", "plusplus-task.md", "plusplus-verify.md"]
      .map((file) => path.join(root, "commands", file))
      .concat(path.join(root, "skills", "opencode-plusplus", "SKILL.md"))
  };
}

export function installWindowsOpenCodePlugin(
  payload: WindowsInstallerPayload,
  configDir?: string,
  options: WindowsInstallerHealthOptions = {}
): WindowsInstallReport {
  const paths = resolveWindowsInstallPaths(configDir);
  const preflight = inspectWindowsOpenCodeInstallation(paths, options);
  assertWindowsInstallerMutationAllowed(preflight, "install");
  const plugin = gunzipSync(Buffer.from(payload.pluginGzipBase64, "base64")).toString("utf8");
  if (!plugin.includes("OpenCodePlusPlusGlobalPlugin")) throw new Error("Installer payload does not contain the OpenCode++ plugin entry.");

  mkdirSync(path.dirname(paths.pluginFile), { recursive: true });
  writeTextAtomic(paths.pluginFile, plugin);
  mkdirSync(path.dirname(paths.agentFile), { recursive: true });
  writeTextAtomic(paths.agentFile, PLUSPLUS_AGENT);
  const legacyFilesRemoved = removeLegacyFiles(paths);

  const existingState = readJsonDiagnostic<Record<string, unknown>>(paths.stateFile);
  if (existingState.status === "corrupt") throw new Error(`Cannot install over corrupt state file: ${existingState.error}`);
  const enabled = existingState.status === "ok" ? existingState.value.enabled !== false : true;
  setOpenCodePlusPlusPluginEnabled(enabled, paths.stateFile);
  writeInstallationManifest(paths, legacyFilesRemoved);
  return makeReport("installed", paths, `OpenCode++ ${getOpenCodePlusplusPackageVersion()} installed successfully.`, legacyFilesRemoved, options);
}

export function repairWindowsOpenCodePlugin(
  payload: WindowsInstallerPayload,
  configDir?: string,
  options: WindowsInstallerHealthOptions = {}
): WindowsInstallReport {
  const paths = resolveWindowsInstallPaths(configDir);
  const preflight = inspectWindowsOpenCodeInstallation(paths, options);
  assertWindowsInstallerMutationAllowed(preflight, "repair");
  const plugin = gunzipSync(Buffer.from(payload.pluginGzipBase64, "base64")).toString("utf8");
  if (!plugin.includes("OpenCodePlusPlusGlobalPlugin")) throw new Error("Installer payload does not contain the OpenCode++ plugin entry.");

  const repairedItems: string[] = [];
  if (!preflight.pluginInstalled || preflight.pluginVersion !== getOpenCodePlusplusPackageVersion() || !pluginSourceIsValid(paths.pluginFile)) {
    mkdirSync(path.dirname(paths.pluginFile), { recursive: true });
    writeTextAtomic(paths.pluginFile, plugin);
    repairedItems.push("plugin");
  }
  if (!preflight.agentInstalled || readFileOrNull(paths.agentFile) !== PLUSPLUS_AGENT) {
    mkdirSync(path.dirname(paths.agentFile), { recursive: true });
    writeTextAtomic(paths.agentFile, PLUSPLUS_AGENT);
    repairedItems.push("agent");
  }

  const stateNeedsRepair = preflight.runtimeState.status !== "valid";
  if (stateNeedsRepair) {
    const now = new Date().toISOString();
    writeJsonAtomic(paths.stateFile, {
      schemaVersion: 1,
      revision: (preflight.runtimeState.revision ?? 0) + 1,
      enabled: preflight.runtimeState.status === "corrupt" ? true : preflight.enabled,
      version: getOpenCodePlusplusPackageVersion(),
      installedAt: now,
      updatedAt: now
    });
    repairedItems.push("runtime state");
  } else if (preflight.runtimeState.version !== getOpenCodePlusplusPackageVersion()) {
    const current = readJsonDiagnostic<Record<string, unknown>>(paths.stateFile);
    if (current.status !== "ok") throw new Error(`Cannot repair runtime state: ${current.status}.`);
    const now = new Date().toISOString();
    writeJsonAtomic(paths.stateFile, {
      ...current.value,
      schemaVersion: 1,
      revision: (preflight.runtimeState.revision ?? 0) + 1,
      enabled: preflight.enabled,
      version: getOpenCodePlusplusPackageVersion(),
      installedAt: preflight.runtimeState.version ? String(current.value.installedAt ?? now) : now,
      updatedAt: now
    });
    repairedItems.push("runtime state version");
  }

  if (preflight.manifest.status !== "valid" || preflight.problems.some((problem) => problem.code === "MANIFEST_MISMATCH")) {
    writeInstallationManifest(paths, removeLegacyFiles(paths));
    repairedItems.push("installation manifest");
  } else {
    const removed = removeLegacyFiles(paths);
    if (removed > 0) repairedItems.push("legacy files");
  }
  return makeReport(
    "repaired",
    paths,
    repairedItems.length ? `OpenCode++ repaired: ${repairedItems.join(", ")}.` : "OpenCode++ installation is healthy.",
    0,
    options,
    repairedItems
  );
}

export function uninstallWindowsOpenCodePlugin(configDir?: string, options: WindowsInstallerHealthOptions = {}): WindowsInstallReport {
  const paths = resolveWindowsInstallPaths(configDir);
  const preflight = inspectWindowsOpenCodeInstallation(paths, options);
  assertWindowsInstallerMutationAllowed(preflight, "uninstall");
  for (const file of [paths.pluginFile, paths.manifestFile, paths.stateFile, paths.agentFile, ...paths.legacyFiles]) {
    if (existsSync(file)) rmSync(file, { force: true });
  }
  removeEmptyDirectory(path.dirname(paths.manifestFile));
  removeEmptyDirectory(path.dirname(paths.agentFile));
  removeEmptyDirectory(path.dirname(paths.legacyFiles[paths.legacyFiles.length - 1] ?? paths.agentFile));
  removeEmptyDirectory(path.dirname(path.dirname(paths.legacyFiles[paths.legacyFiles.length - 1] ?? paths.agentFile)));
  return makeReport("uninstalled", paths, "OpenCode++ was removed from the current Windows user.", 0, options);
}

export function setWindowsOpenCodePluginEnabled(enabled: boolean, configDir?: string, options: WindowsInstallerHealthOptions = {}): WindowsInstallReport {
  const paths = resolveWindowsInstallPaths(configDir);
  const preflight = inspectWindowsOpenCodeInstallation(paths, options);
  assertWindowsInstallerMutationAllowed(preflight, enabled ? "enable" : "disable");
  setOpenCodePlusPlusPluginEnabled(enabled, paths.stateFile);
  return makeReport(enabled ? "enabled" : "disabled", paths, `OpenCode++ is now ${enabled ? "enabled" : "disabled"}.`, 0, options);
}

export function getWindowsOpenCodePluginStatus(configDir?: string, options: WindowsInstallerHealthOptions = {}): WindowsInstallReport {
  const paths = resolveWindowsInstallPaths(configDir);
  return makeReport("status", paths, "OpenCode++ installation status.", 0, options);
}

export function getWindowsOpenCodePluginHealth(configDir?: string, options: WindowsInstallerHealthOptions = {}): WindowsInstallerHealthReport {
  return inspectWindowsOpenCodeInstallation(resolveWindowsInstallPaths(configDir), options);
}

export async function runWindowsInstaller(argv: string[], payload: WindowsInstallerPayload): Promise<void> {
  if (process.platform !== "win32" && !argv.includes("--allow-non-windows")) {
    throw new Error("The OpenCode++ installer EXE is intended for Windows.");
  }
  const configDir = argumentValue(argv, "--config-dir");
  const doctor = argv.includes("--doctor") || argv.includes("--health");
  if (doctor) {
    const health = getWindowsOpenCodePluginHealth(configDir);
    if (argv.includes("--json") || argv.includes("--silent")) console.log(JSON.stringify(health, null, 2));
    else console.log(renderWindowsInstallerHealth(health));
    return;
  }
  const report = argv.includes("--uninstall")
    ? uninstallWindowsOpenCodePlugin(configDir)
    : argv.includes("--repair")
      ? repairWindowsOpenCodePlugin(payload, configDir)
      : argv.includes("--status")
        ? getWindowsOpenCodePluginStatus(configDir)
        : argv.includes("--enable")
          ? setWindowsOpenCodePluginEnabled(true, configDir)
          : argv.includes("--disable")
            ? setWindowsOpenCodePluginEnabled(false, configDir)
            : installWindowsOpenCodePlugin(payload, configDir);
  const output = JSON.stringify(report, null, 2);
  if (argv.includes("--json") || argv.includes("--silent")) {
    console.log(output);
  } else {
    console.log(report.message);
    console.log(`Config: ${report.paths.configDir}`);
    console.log(`Plugin: ${report.pluginExists ? "installed" : "not installed"}`);
    console.log(`Enabled: ${report.enabled ? "yes" : "no"}`);
    if (report.action === "installed" || report.action === "repaired") showWindowsMessage(renderWindowsInstallSuccess(report), "OpenCode++");
  }
}

export function renderWindowsInstallSuccess(report: WindowsInstallReport): string {
  return [
    `OpenCode++ ${report.version} ${report.action === "repaired" ? "repaired successfully" : "installed successfully"}`,
    "",
    `Config:\n${report.paths.configDir}`,
    `Plugin:\n${report.pluginExists ? "OK" : "FAILED"}`,
    `Agent:\n${report.modeInstalled ? "OK" : "FAILED"}`,
    "",
    "Next:",
    "1. Restart OpenCode Desktop",
    "2. Select OpenCode++",
    "3. Describe your task normally"
  ].join("\n");
}

function makeReport(
  action: WindowsInstallReport["action"],
  paths: WindowsInstallPaths,
  message: string,
  legacyFilesRemoved = 0,
  options: WindowsInstallerHealthOptions = {},
  repairedItems: string[] = []
): WindowsInstallReport {
  const status = readOpenCodePlusPlusPluginStatus(paths.stateFile);
  const health = inspectWindowsOpenCodeInstallation(paths, options);
  return {
    action,
    ok: action === "uninstalled" || existsSync(paths.pluginFile),
    version: getOpenCodePlusplusPackageVersion(),
    paths,
    pluginExists: existsSync(paths.pluginFile),
    enabled: status.enabled,
    modeInstalled: existsSync(paths.agentFile),
    commandsInstalled: 0,
    agentFilesInstalled: existsSync(paths.agentFile) ? 1 : 0,
    legacyFilesRemoved,
    message,
    health,
    repairedItems
  };
}

function defaultOpenCodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
}

function argumentValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function removeLegacyFiles(paths: WindowsInstallPaths): number {
  let removed = 0;
  for (const file of paths.legacyFiles) {
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    removed++;
  }
  return removed;
}

function writeInstallationManifest(paths: WindowsInstallPaths, legacyFilesRemoved: number): void {
  writeJsonAtomic(paths.manifestFile, {
    schemaVersion: WINDOWS_INSTALLER_SCHEMA_VERSION,
    revision: Date.now(),
    version: getOpenCodePlusplusPackageVersion(),
    installedAt: new Date().toISOString(),
    plugin: WINDOWS_PLUGIN_FILE,
    mode: "opencode-plusplus",
    agent: PLUSPLUS_AGENT_FILE,
    commands: [],
    legacyFilesRemoved
  });
}

function pluginSourceIsValid(filePath: string): boolean {
  const source = readFileOrNull(filePath);
  return source !== null && source.includes("OpenCodePlusPlusGlobalPlugin") && extractPluginVersion(source) === getOpenCodePlusplusPackageVersion();
}

function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function removeEmptyDirectory(directory: string): void {
  try {
    if (existsSync(directory) && statSync(directory).isDirectory() && readdirSync(directory).length === 0) rmdirSync(directory);
  } catch {
    // Keep user-created files and directories intact.
  }
}

function showWindowsMessage(message: string, title: string): void {
  if (process.platform !== "win32") return;
  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)}) | Out-Null`;
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore" });
}
