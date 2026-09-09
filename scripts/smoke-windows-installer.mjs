import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("The Windows installer smoke test must run on Windows.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "release", "opencode-plusplus-setup-win-x64.exe");
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const configDir = mkdtempSync(path.join(tmpdir(), "OpenCodePP 安装器-"));

try {
  assert.equal(existsSync(executable), true, "Build the Windows installer before running its smoke test.");
  assert.ok(statSync(executable).size < 12 * 1024 * 1024);
  if (isOpenCodeRunning()) throw new Error("Close OpenCode Desktop before running the Windows installer smoke test.");
  await runConfigSmoke();
  verifyRealBundle();
  if (process.argv.includes("--require-real-desktop-launch")) await verifyRealDesktopLaunch();
  console.log(`Windows installer smoke test passed (${statSync(executable).size} bytes).`);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

async function runConfigSmoke() {
  const freshDoctor = runInstallerRaw(["--config-dir", configDir, "--skip-host-patch", "--doctor", "--json"]);
  assert.equal(freshDoctor.status, 1);
  const freshHealth = JSON.parse(freshDoctor.stdout);
  assert.equal(freshHealth.installed, false);
  assert.equal(freshHealth.pluginInstalled, false);
  assert.equal(freshHealth.agentInstalled, false);
  assert.ok(freshHealth.recommendedActions.length > 0);

  const legacyFiles = ["opencode-plusplus-on.md", "opencode-plusplus-off.md", "opencode-plusplus-status.md", "plusplus-task.md", "plusplus-verify.md"].map(
    (name) => path.join(configDir, "commands", name)
  );
  const legacySkill = path.join(configDir, "skills", "opencode-plusplus", "SKILL.md");
  for (const file of [...legacyFiles, legacySkill]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "legacy", "utf8");
  }
  const installed = runInstaller(["--config-dir", configDir, "--skip-host-patch", "--json"]);
  assert.equal(installed.action, "installed");
  assert.equal(installed.version, packageVersion);
  assert.equal(installed.commandsInstalled, 0);
  assert.equal(installed.modeInstalled, true);
  assert.equal(installed.health.healthy, true);
  assert.equal(installed.health.openCodeProcessDetected, false);
  assert.equal(installed.repairedItems.length, 0);
  const agentFile = path.join(configDir, "agents", "opencode-plusplus.md");
  assert.equal(existsSync(agentFile), true);
  assert.match(readFileSync(agentFile, "utf8"), /mode: primary/);
  assert.equal(legacyFiles.some(existsSync), false);
  assert.equal(existsSync(legacySkill), false);
  const pluginFile = path.join(configDir, "plugins", "opencode-plusplus.js");
  const pluginModule = await import(`${pathToFileURL(pluginFile).href}?smoke=${Date.now()}`);
  assert.equal([...new Set(Object.values(pluginModule))].length, 1);
  assert.equal(typeof [...new Set(Object.values(pluginModule))][0], "function");
  const doctorAfterInstall = runInstaller(["--config-dir", configDir, "--skip-host-patch", "--doctor", "--json"]);
  assert.equal(doctorAfterInstall.healthy, true);
  assert.equal(doctorAfterInstall.existingInstallationVersion, packageVersion);
  assert.equal(runInstaller(["--config-dir", configDir, "--skip-host-patch", "--disable", "--json"]).enabled, false);
  assert.equal(runInstaller(["--config-dir", configDir, "--skip-host-patch", "--enable", "--json"]).enabled, true);

  writeFileSync(pluginFile, "broken plugin", "utf8");
  writeFileSync(agentFile, "broken agent", "utf8");
  writeFileSync(path.join(configDir, "opencode-plusplus", "installation.json"), JSON.stringify({ schemaVersion: 2, version: "0.0.0" }), "utf8");
  const repaired = runInstaller(["--config-dir", configDir, "--skip-host-patch", "--repair", "--json"]);
  assert.equal(repaired.action, "repaired");
  assert.equal(repaired.health.healthy, true);
  assert.equal(repaired.enabled, true);
  assert.ok(repaired.repairedItems.includes("plugin"));
  assert.ok(repaired.repairedItems.includes("agent"));
  assert.ok(repaired.repairedItems.includes("installation manifest"));

  writeFileSync(path.join(configDir, "opencode-plusplus", "state.json"), "{", "utf8");
  const recovered = runInstaller(["--config-dir", configDir, "--skip-host-patch", "--repair", "--json"]);
  assert.equal(recovered.health.healthy, true);
  assert.equal(recovered.enabled, true);
  assert.ok(recovered.repairedItems.includes("runtime state"));
  runInstaller(["--config-dir", configDir, "--skip-host-patch", "--uninstall", "--json"]);
  assert.equal(existsSync(pluginFile), false);
  assert.equal(existsSync(agentFile), false);
  const afterUninstall = runInstallerRaw(["--config-dir", configDir, "--skip-host-patch", "--doctor", "--json"]);
  assert.equal(afterUninstall.status, 1);
  assert.equal(JSON.parse(afterUninstall.stdout).installed, false);
}

function runInstaller(args) {
  const result = runInstallerRaw(args);
  if (result.status !== 0) throw new Error(`Installer failed (${result.status}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function runInstallerRaw(args) {
  return spawnSync(executable, args, { encoding: "utf8", windowsHide: true, env: process.env });
}

function verifyRealBundle() {
  const local = process.env.LOCALAPPDATA;
  const candidates = local
    ? [path.join(local, "Programs", "@opencode-aidesktop", "resources", "app.asar"), path.join(local, "Programs", "OpenCode", "resources", "app.asar")]
    : [];
  const asar = candidates.find(existsSync);
  if (!asar) return;
  const marker = readFileSync(asar).includes(Buffer.from("OPENCODE_PLUSPLUS_NATIVE_COMMANDS"));
  console.log(`Real OpenCode Desktop bundle found read-only (${asar}, legacy patch=${marker ? "present" : "absent"}).`);
}

async function verifyRealDesktopLaunch() {
  const executablePath = findRealDesktopExecutable();
  if (!executablePath) throw new Error("Real OpenCode Desktop executable was not found. Set OPENCODE_DESKTOP_EXE on the Windows smoke runner.");
  if (isOpenCodeRunning()) throw new Error("Close the existing OpenCode Desktop process before the real launch smoke test.");
  const desktop = spawn(executablePath, [], { cwd: path.dirname(executablePath), stdio: "ignore", windowsHide: true });
  try {
    await delay(5000);
    assert.equal(desktop.exitCode, null, `OpenCode Desktop exited before the launch smoke completed (${String(desktop.exitCode)}).`);
    assert.equal(isOpenCodeRunning(), true, "OpenCode Desktop process was not observable after launch.");
    console.log(`Real OpenCode Desktop launch passed (${executablePath}).`);
  } finally {
    if (desktop.pid) spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(desktop.pid)], { stdio: "ignore", windowsHide: true });
  }
}

function findRealDesktopExecutable() {
  const configured = process.env.OPENCODE_DESKTOP_EXE;
  if (configured) return existsSync(configured) ? configured : undefined;
  const local = process.env.LOCALAPPDATA;
  if (!local) return undefined;
  return [path.join(local, "Programs", "@opencode-aidesktop", "OpenCode.exe"), path.join(local, "Programs", "OpenCode", "OpenCode.exe")].find(existsSync);
}

function isOpenCodeRunning() {
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq OpenCode.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 && /"OpenCode\.exe"/i.test(result.stdout);
}

function delay(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
