import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getWindowsOpenCodePluginHealth,
  getWindowsOpenCodePluginStatus,
  installWindowsOpenCodePlugin,
  repairWindowsOpenCodePlugin,
  renderWindowsInstallSuccess,
  setWindowsOpenCodePluginEnabled,
  uninstallWindowsOpenCodePlugin
} from "../src/installer/windows-installer.js";
import { getOpenCodePlusplusPackageVersion } from "../src/core/package-info.js";

const payload = {
  pluginGzipBase64: gzipSync(
    Buffer.from(`export async function OpenCodePlusPlusGlobalPlugin() {}\n// OPENCODE_PLUS_PLUS_PLUGIN_VERSION: ${getOpenCodePlusplusPackageVersion()}\n`, "utf8")
  ).toString("base64")
};
const testInstallerOptions = { isOpenCodeDesktopRunning: () => false };

test("Windows installer writes the plugin and OpenCode++ primary mode", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-installer-test-"));
  try {
    const legacyFiles = ["opencode-plusplus-on.md", "opencode-plusplus-off.md", "opencode-plusplus-status.md", "plusplus-task.md", "plusplus-verify.md"].map(
      (name) => path.join(configDir, "commands", name)
    );
    const legacySkill = path.join(configDir, "skills", "opencode-plusplus", "SKILL.md");
    mkdirSync(path.dirname(legacyFiles[0]!), { recursive: true });
    for (const file of [...legacyFiles, legacySkill]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "legacy", "utf8");
    }

    const installed = installWindowsOpenCodePlugin(payload, configDir, testInstallerOptions);
    assert.equal(installed.ok, true);
    assert.equal(installed.commandsInstalled, 0);
    assert.equal(installed.modeInstalled, true);
    assert.equal(installed.agentFilesInstalled, 1);
    assert.equal(legacyFiles.some(existsSync), false);
    assert.equal(existsSync(legacySkill), false);
    assert.equal(existsSync(installed.paths.agentFile), true);
    assert.match(readFileSync(installed.paths.agentFile, "utf8"), /mode: primary/);
    assert.match(readFileSync(installed.paths.agentFile, "utf8"), /opencode_plusplus_prepare/);
    assert.equal(JSON.parse(readFileSync(installed.paths.stateFile, "utf8")).enabled, true);

    const manifest = JSON.parse(readFileSync(installed.paths.manifestFile, "utf8"));
    assert.equal(manifest.mode, "opencode-plusplus");
    assert.equal(manifest.agent, "agents/opencode-plusplus.md");
    assert.deepEqual(manifest.commands, []);

    setWindowsOpenCodePluginEnabled(false, configDir, testInstallerOptions);
    assert.equal(getWindowsOpenCodePluginStatus(configDir, testInstallerOptions).enabled, false);
    const upgraded = installWindowsOpenCodePlugin(payload, configDir, testInstallerOptions);
    assert.equal(upgraded.enabled, false);
    assert.equal(JSON.parse(readFileSync(upgraded.paths.stateFile, "utf8")).version, getOpenCodePlusplusPackageVersion());

    const removed = uninstallWindowsOpenCodePlugin(configDir, testInstallerOptions);
    assert.equal(removed.pluginExists, false);
    assert.equal(existsSync(removed.paths.pluginFile), false);
    assert.equal(existsSync(removed.paths.stateFile), false);
    assert.equal(removed.modeInstalled, false);
    assert.equal(existsSync(removed.paths.agentFile), false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("installer preflight stops before writing when OpenCode Desktop is running", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-installer-running-"));
  try {
    const health = getWindowsOpenCodePluginHealth(configDir, { isOpenCodeDesktopRunning: () => true });
    assert.equal(health.openCodeProcessDetected, true);
    assert.throws(
      () => installWindowsOpenCodePlugin(payload, configDir, { isOpenCodeDesktopRunning: () => true }),
      /Fully exit OpenCode Desktop/
    );
    assert.equal(existsSync(path.join(configDir, "plugins", "opencode-plusplus.js")), false);
    assert.equal(existsSync(path.join(configDir, "agents", "opencode-plusplus.md")), false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("installer preflight refuses corrupt state without leaving a partial installation", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-installer-corrupt-"));
  const stateFile = path.join(configDir, "opencode-plusplus", "state.json");
  try {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, "{", "utf8");
    const health = getWindowsOpenCodePluginHealth(configDir, testInstallerOptions);
    assert.equal(health.runtimeState.status, "corrupt");
    assert.throws(() => installWindowsOpenCodePlugin(payload, configDir, testInstallerOptions), /corrupt state file/);
    assert.equal(existsSync(path.join(configDir, "plugins", "opencode-plusplus.js")), false);
    assert.equal(existsSync(path.join(configDir, "agents", "opencode-plusplus.md")), false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("repair restores owned files, preserves enabled state, and recovers corrupt metadata", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-installer-repair-"));
  try {
    const installed = installWindowsOpenCodePlugin(payload, configDir, testInstallerOptions);
    setWindowsOpenCodePluginEnabled(false, configDir, testInstallerOptions);
    rmSync(installed.paths.pluginFile, { force: true });
    writeFileSync(installed.paths.agentFile, "not an agent", "utf8");
    writeFileSync(installed.paths.manifestFile, JSON.stringify({ schemaVersion: 2, version: "0.0.0" }), "utf8");

    const repaired = repairWindowsOpenCodePlugin(payload, configDir, testInstallerOptions);
    assert.equal(repaired.action, "repaired");
    assert.equal(repaired.enabled, false);
    assert.equal(repaired.health.healthy, true);
    assert.deepEqual(repaired.repairedItems, ["plugin", "agent", "installation manifest"]);

    writeFileSync(repaired.paths.stateFile, "{", "utf8");
    rmSync(repaired.paths.pluginFile, { force: true });
    const recovered = repairWindowsOpenCodePlugin(payload, configDir, testInstallerOptions);
    assert.equal(recovered.health.healthy, true);
    assert.equal(recovered.enabled, true);
    assert.ok(recovered.repairedItems.includes("runtime state"));
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("doctor exposes actionable installation health and install result next steps", () => {
  const configDir = mkdtempSync(path.join(tmpdir(), "opencode-plusplus-installer-doctor-"));
  try {
    const health = getWindowsOpenCodePluginHealth(configDir, testInstallerOptions);
    assert.equal(health.installed, false);
    assert.equal(health.problems.some((problem) => problem.code === "PLUGIN_MISSING"), true);
    assert.equal(health.recommendedActions[0], "Run the OpenCode++ Windows installer.");
    assert.match(renderWindowsInstallSuccess({
      action: "installed",
      ok: true,
      version: getOpenCodePlusplusPackageVersion(),
      paths: {
        configDir,
        pluginFile: path.join(configDir, "plugins", "opencode-plusplus.js"),
        stateFile: path.join(configDir, "opencode-plusplus", "state.json"),
        manifestFile: path.join(configDir, "opencode-plusplus", "installation.json"),
        agentFile: path.join(configDir, "agents", "opencode-plusplus.md"),
        legacyFiles: []
      },
      pluginExists: true,
      enabled: true,
      modeInstalled: true,
      commandsInstalled: 0,
      agentFilesInstalled: 1,
      legacyFilesRemoved: 0,
      message: "installed",
      health,
      repairedItems: []
    }), /Restart OpenCode Desktop/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("installer prompt defines a primary OpenCode mode and no Slash Commands", () => {
  const prompt = readFileSync(path.resolve("src/installer/opencode-plusplus-prompts.ts"), "utf8");
  assert.match(prompt, /PLUSPLUS_AGENT_FILE = "agents\/opencode-plusplus\.md"/);
  assert.match(prompt, /mode: primary/);
  assert.doesNotMatch(prompt, /PLUSPLUS_TASK_COMMAND|PLUSPLUS_VERIFY_COMMAND|PLUSPLUS_SKILL/);
});

test("real Desktop launch smoke is explicit and cleans up its process", () => {
  const smoke = readFileSync(path.resolve("scripts/smoke-windows-installer.mjs"), "utf8");
  assert.match(smoke, /process\.argv\.includes\("--require-real-desktop-launch"\)/);
  assert.match(smoke, /OPENCODE_DESKTOP_EXE/);
  assert.match(smoke, /isOpenCodeRunning\(\)/);
  assert.match(smoke, /taskkill\.exe/);
});
