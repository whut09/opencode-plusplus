import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, ".installer-build");
const release = path.join(root, "release");
const pluginPath = path.join(staging, "opencode-plusplus-plugin.cjs");
const pluginGzipPath = path.join(staging, "opencode-plusplus-plugin.cjs.gz");
const installerTemplate = path.join(root, "src/installer/windows-installer.cs");
const installerSource = path.join(staging, "windows-installer.generated.cs");
const executable = path.join(release, "opencode-plusplus-setup-win-x64.exe");
const releaseManifest = path.join(release, "opencode-plusplus-release.json");
const maximumInstallerBytes = 12 * 1024 * 1024;
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(release, { recursive: true });

await build({
  stdin: {
    contents:
      'import { OpenCodePlusPlusGlobalPlugin } from "./src/integrations/opencode/global-plugin.ts";\n' + "module.exports = OpenCodePlusPlusGlobalPlugin;\n",
    resolveDir: root,
    sourcefile: "opencode-plusplus-plugin-entry.ts",
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: pluginPath,
  minify: true,
  legalComments: "none"
});

writeFileSync(pluginPath, `${readFileSync(pluginPath, "utf8")}\n// OPENCODE_PLUS_PLUS_PLUGIN_VERSION: ${packageVersion}\n`, "utf8");
const pluginModule = await import(`${pathToFileURL(pluginPath).href}?build=${Date.now()}`);
const pluginExports = [...new Set(Object.values(pluginModule))];
if (pluginExports.length !== 1 || typeof pluginExports[0] !== "function") {
  throw new Error("Bundled plugin must expose exactly one OpenCode plugin function.");
}

const pluginGzip = gzipSync(readFileSync(pluginPath), { level: 9 });
writeFileSync(pluginGzipPath, pluginGzip);
writeFileSync(installerSource, readFileSync(installerTemplate, "utf8").replaceAll("__PACKAGE_VERSION__", packageVersion), "utf8");

const csc = findCsc();
run(csc, [
  "/nologo",
  "/target:exe",
  "/optimize+",
  "/platform:x64",
  "/utf8output",
  `/out:${executable}`,
  `/resource:${pluginGzipPath},OpenCodePlusPlus.Plugin.gz`,
  "/reference:System.Web.Extensions.dll",
  "/reference:System.Windows.Forms.dll",
  installerSource
]);

const executableBytes = statSync(executable).size;
if (executableBytes > maximumInstallerBytes) throw new Error(`Installer is ${executableBytes} bytes; maximum is ${maximumInstallerBytes}.`);
const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
writeFileSync(`${executable}.sha256`, `${digest}  ${path.basename(executable)}\n`, "utf8");
writeFileSync(
  releaseManifest,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      version: packageVersion,
      product: "OpenCode++ Desktop plugin",
      platform: "win32",
      architecture: "x64",
      installer: {
        file: path.basename(executable),
        bytes: executableBytes,
        maximumBytes: maximumInstallerBytes,
        sha256: digest,
        checksumFile: `${path.basename(executable)}.sha256`
      },
      plugin: {
        entry: "src/integrations/opencode/global-plugin.ts",
        bundleBytes: statSync(pluginPath).size,
        compressedBytes: pluginGzip.length,
        exportCount: pluginExports.length
      },
      mode: "opencode-plusplus",
      agent: "agents/opencode-plusplus.md",
      legacyCommandsRemoved: ["opencode-plusplus-status", "opencode-plusplus-on", "opencode-plusplus-off", "plusplus-task", "plusplus-verify"],
      hostPatch: "removed-on-install"
    },
    null,
    2
  )}\n`,
  "utf8"
);
console.log(`Built ${executable}`);
console.log(`Installer size ${executableBytes} bytes; compressed plugin ${pluginGzip.length} bytes`);
console.log(`SHA256 ${digest}`);
console.log(`Release manifest ${releaseManifest}`);

function findCsc() {
  const windows = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
  ];
  const compiler = candidates.find(existsSync);
  if (!compiler) throw new Error(".NET Framework C# compiler was not found. Windows 10/11 with .NET Framework 4.x is required.");
  return compiler;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}`);
}
