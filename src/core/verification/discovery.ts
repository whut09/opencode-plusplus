import { readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type {
  VerificationCommand,
  VerificationCommandKind,
  VerificationConfidence,
  VerificationCost,
  VerificationDiscoveryReport,
  VerificationScope
} from "./types.js";

interface PackageManifest {
  scripts?: Record<string, unknown>;
  workspaces?: string[] | { packages?: string[] };
}

interface CommandSpec {
  name: string;
  command: string;
  kind: VerificationCommandKind;
  source: string;
  cwd: string;
  scope: VerificationScope;
  estimatedCost: VerificationCost;
  confidence: VerificationConfidence;
  reason: string;
  packagePath?: string;
}

const ignoredPatterns = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.agent-context/**"];

export function discoverVerificationCommands(root: string): VerificationDiscoveryReport {
  const absoluteRoot = path.resolve(root);
  const detectedFiles = discoverProjectFiles(absoluteRoot);
  const diagnostics: string[] = [];
  const commands: CommandSpec[] = [];

  discoverNodeCommands(absoluteRoot, detectedFiles, commands, diagnostics);
  discoverPythonCommands(absoluteRoot, detectedFiles, commands);
  discoverRustCommands(absoluteRoot, detectedFiles, commands);
  discoverGoCommands(absoluteRoot, detectedFiles, commands);
  discoverMakeAndJustCommands(absoluteRoot, detectedFiles, commands);
  discoverCiCommands(absoluteRoot, detectedFiles, commands);
  discoverConfigFallbacks(absoluteRoot, detectedFiles, commands);

  return {
    root: absoluteRoot,
    commands: stableCommands(commands),
    detectedFiles: detectedFiles.sort(),
    diagnostics: [...new Set(diagnostics)].sort()
  };
}

function discoverProjectFiles(root: string): string[] {
  return fg
    .sync(
      [
        "package.json",
        "**/package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "pyproject.toml",
        "pytest.ini",
        "tox.ini",
        "setup.cfg",
        "Makefile",
        "makefile",
        "GNUmakefile",
        "Justfile",
        "justfile",
        "Cargo.toml",
        "go.mod",
        "tsconfig*.json",
        "eslint.config.*",
        ".eslintrc*",
        ".github/workflows/**/*.{yml,yaml}",
        ".gitlab-ci.yml",
        "Jenkinsfile",
        "azure-pipelines.yml",
        "pnpm-workspace.yaml"
      ],
      { cwd: root, dot: true, onlyFiles: true, unique: true, ignore: ignoredPatterns }
    )
    .map((file) => normalizePath(file))
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith(".agent-context/"));
}

function discoverNodeCommands(root: string, files: string[], commands: CommandSpec[], diagnostics: string[]): void {
  const packageFiles = files.filter((file) => file.endsWith("package.json")).sort();
  const manifests: Array<{ relativePath: string; absolutePath: string; manifest: PackageManifest }> = [];

  for (const relativePath of packageFiles) {
    const absolutePath = path.join(root, relativePath);
    const manifest = readJson<PackageManifest>(absolutePath);
    if (!manifest) {
      diagnostics.push(`Could not parse ${relativePath}; package scripts were not discovered.`);
      continue;
    }
    manifests.push({ relativePath, absolutePath, manifest });
  }

  const rootManifest = manifests.find((item) => item.relativePath === "package.json");
  if (!rootManifest) return;

  const workspacePackages = workspacePackagePaths(root, files, rootManifest.manifest);
  const workspaceSet = new Set(workspacePackages);
  const runner = nodeRunner(files);
  const rootScope: VerificationScope = workspacePackages.length ? "workspace" : "repository";

  addPackageScriptCommands(root, rootManifest, runner, "package-script", rootScope, commands);
  for (const item of manifests.filter((candidate) => workspaceSet.has(candidate.relativePath)).sort(byRelativePath)) {
    const packageRoot = path.dirname(item.relativePath);
    addPackageScriptCommands(root, item, runner, "workspace-package-script", "package", commands, packageRoot);
  }
}

function addPackageScriptCommands(
  root: string,
  item: { relativePath: string; manifest: PackageManifest },
  runner: string,
  source: string,
  scope: VerificationScope,
  commands: CommandSpec[],
  packagePath?: string
): void {
  const scripts = item.manifest.scripts ?? {};
  const cwd = path.resolve(root, packagePath ?? ".");
  for (const [name, value] of Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof value !== "string") continue;
    const kind = kindForScript(name, value);
    if (!kind) continue;
    commands.push({
      name,
      command: formatNodeScript(runner, name),
      kind,
      source,
      cwd,
      scope,
      estimatedCost: costForKind(kind, name),
      confidence: "high",
      reason: `${relativePathLabel(item.relativePath)} declares the ${name} script.`,
      packagePath
    });
  }
}

function workspacePackagePaths(root: string, files: string[], manifest: PackageManifest): string[] {
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces && Array.isArray(manifest.workspaces.packages)
      ? manifest.workspaces.packages
      : [];
  const pnpmWorkspace = files.find((file) => file === "pnpm-workspace.yaml");
  const workspacePatterns = [...patterns, ...(pnpmWorkspace ? readWorkspacePatterns(path.join(root, pnpmWorkspace)) : [])];
  if (!workspacePatterns.length) return [];

  const matches = new Set<string>();
  for (const pattern of workspacePatterns) {
    const normalized = normalizePath(pattern).replace(/\/$/, "");
    const packagePattern = normalized.endsWith("package.json") ? normalized : `${normalized}/package.json`;
    for (const file of fg.sync(packagePattern, { cwd: root, dot: true, onlyFiles: true, unique: true, ignore: ignoredPatterns })) {
      const relative = normalizePath(file);
      if (relative !== "package.json") matches.add(relative);
    }
  }
  return [...matches].sort();
}

function readWorkspacePatterns(filePath: string): string[] {
  try {
    return readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s*["']?([^"']+?)["']?\s*$/)?.[1])
      .filter((pattern): pattern is string => Boolean(pattern))
      .map((pattern) => pattern.replace(/\/$/, ""));
  } catch {
    return [];
  }
}

function discoverPythonCommands(root: string, files: string[], commands: CommandSpec[]): void {
  const pyproject = files.find((file) => file === "pyproject.toml");
  if (pyproject) {
    const content = readText(path.join(root, pyproject));
    if (hasSection(content, "tool.pytest") || /pytest/i.test(content) || existsInFiles(files, /(^|\/)tests?\//i)) {
      commands.push(
        pythonCommand(
          root,
          "python -m pytest",
          "pyproject.toml",
          "test",
          "repository",
          "medium",
          "high",
          "Python project exposes pytest configuration or test dependencies."
        )
      );
    }
    if (hasSection(content, "tool.ruff") || /\bruff\b/i.test(content)) {
      commands.push(pythonCommand(root, "ruff check .", "pyproject.toml", "lint", "repository", "low", "medium", "pyproject.toml configures Ruff."));
    }
    if (hasSection(content, "tool.mypy") || /\bmypy\b/i.test(content)) {
      commands.push(
        pythonCommand(root, "python -m mypy .", "pyproject.toml", "typecheck", "repository", "medium", "medium", "pyproject.toml configures mypy.")
      );
    }
  }

  if (files.includes("pytest.ini") || (files.includes("setup.cfg") && hasSection(readText(path.join(root, "setup.cfg")), "tool:pytest"))) {
    commands.push(
      pythonCommand(
        root,
        "python -m pytest",
        files.includes("pytest.ini") ? "pytest.ini" : "setup.cfg",
        "test",
        "repository",
        "medium",
        "high",
        "pytest configuration was discovered."
      )
    );
  }
  if (files.includes("tox.ini")) {
    commands.push(pythonCommand(root, "tox", "tox.ini", "test", "repository", "high", "medium", "tox defines the project validation environment."));
  }
}

function discoverRustCommands(root: string, files: string[], commands: CommandSpec[]): void {
  if (!files.includes("Cargo.toml")) return;
  const content = readText(path.join(root, "Cargo.toml"));
  const scope: VerificationScope = /\[workspace\]/i.test(content) ? "workspace" : "repository";
  commands.push(rustCommand(root, "cargo test", "test", scope, "medium", "high", "Cargo.toml defines a Rust test target."));
  commands.push(
    rustCommand(root, "cargo check", "typecheck", scope, "medium", "high", "cargo check validates Rust compilation without producing a release build.")
  );
  commands.push(rustCommand(root, "cargo build", "build", scope, "high", "medium", "Cargo.toml defines the Rust build."));
}

function discoverGoCommands(root: string, files: string[], commands: CommandSpec[]): void {
  if (!files.includes("go.mod")) return;
  commands.push(goCommand(root, "go test ./...", "test", "workspace", "medium", "high", "go.mod defines a module-wide Go test command."));
  commands.push(goCommand(root, "go vet ./...", "lint", "workspace", "medium", "medium", "go vet checks the Go module for suspicious constructs."));
  commands.push(goCommand(root, "go build ./...", "build", "workspace", "high", "medium", "go.mod defines a module-wide Go build."));
}

function discoverMakeAndJustCommands(root: string, files: string[], commands: CommandSpec[]): void {
  for (const file of files.filter((candidate) => /(^|\/)(Makefile|makefile|GNUmakefile|Justfile|justfile)$/.test(candidate)).sort()) {
    const content = readText(path.join(root, file));
    const isJust = /(^|\/)Justfile$|(^|\/)justfile$/.test(file);
    const runner = isJust ? "just" : "make";
    const source = isJust ? "justfile" : "makefile";
    const targetNames = [...content.matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((match) => match[1]);
    for (const name of [...new Set(targetNames)].sort()) {
      const kind = kindForScript(name, "");
      if (!kind) continue;
      commands.push({
        name,
        command: `${runner} ${name}`,
        kind,
        source,
        cwd: root,
        scope: "repository",
        estimatedCost: costForKind(kind, name),
        confidence: "high",
        reason: `${file} defines the ${name} target.`
      });
    }
  }
}

function discoverCiCommands(root: string, files: string[], commands: CommandSpec[]): void {
  const ciFiles = files.filter((file) => isCiFile(file)).sort();
  for (const file of ciFiles) {
    for (const line of readText(path.join(root, file)).split(/\r?\n/)) {
      const command = extractValidationCommand(line);
      if (!command) continue;
      const kind = kindForCommand(command);
      commands.push({
        name: command,
        command,
        kind,
        source: "ci-workflow",
        cwd: root,
        scope: "repository",
        estimatedCost: costForKind(kind, command),
        confidence: "medium",
        reason: `${file} contains a validation command.`
      });
    }
  }
}

function discoverConfigFallbacks(root: string, files: string[], commands: CommandSpec[]): void {
  if (!files.some((file) => file === "package.json" || file.endsWith("/package.json"))) return;
  if (files.some((file) => /^tsconfig[^/]*\.json$/i.test(file)) && !commands.some((item) => item.kind === "typecheck")) {
    commands.push({
      name: "tsconfig",
      command: "npx tsc --noEmit",
      kind: "typecheck",
      source: "project-config",
      cwd: root,
      scope: "workspace",
      estimatedCost: "medium",
      confidence: "low",
      reason: "tsconfig was discovered but no package typecheck script was declared."
    });
  }
  if (files.some((file) => /^eslint\.config\.|^\.eslintrc/i.test(file)) && !commands.some((item) => item.kind === "lint")) {
    commands.push({
      name: "eslint-config",
      command: "npx eslint .",
      kind: "lint",
      source: "project-config",
      cwd: root,
      scope: "repository",
      estimatedCost: "medium",
      confidence: "low",
      reason: "An ESLint configuration was discovered but no package lint script was declared."
    });
  }
}

function pythonCommand(
  cwd: string,
  command: string,
  source: string,
  kind: VerificationCommandKind,
  scope: VerificationScope,
  estimatedCost: VerificationCost,
  confidence: VerificationConfidence,
  reason: string
): CommandSpec {
  return { name: command, command, source, kind, cwd, scope, estimatedCost, confidence, reason };
}

function rustCommand(
  cwd: string,
  command: string,
  kind: VerificationCommandKind,
  scope: VerificationScope,
  estimatedCost: VerificationCost,
  confidence: VerificationConfidence,
  reason: string
): CommandSpec {
  return { name: command, command, source: "cargo.toml", kind, cwd, scope, estimatedCost, confidence, reason };
}

function goCommand(
  cwd: string,
  command: string,
  kind: VerificationCommandKind,
  scope: VerificationScope,
  estimatedCost: VerificationCost,
  confidence: VerificationConfidence,
  reason: string
): CommandSpec {
  return { name: command, command, source: "go.mod", kind, cwd, scope, estimatedCost, confidence, reason };
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function nodeRunner(files: string[]): string {
  if (files.includes("pnpm-lock.yaml") || files.includes("pnpm-workspace.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  return "npm";
}

function formatNodeScript(runner: string, name: string): string {
  return runner === "npm" ? `npm run ${name}` : runner === "yarn" ? `yarn ${name}` : `pnpm ${name}`;
}

function kindForScript(name: string, command: string): VerificationCommandKind | null {
  const value = `${name} ${command}`.toLowerCase();
  if (/test|spec|coverage|e2e|integration/.test(value)) return "test";
  if (/lint|format|ruff|eslint|prettier/.test(value)) return "lint";
  if (/typecheck|type-check|check-types|tsc|mypy|pyright|check$/.test(value)) return "typecheck";
  if (/markdownlint|docs?|typedoc/.test(value)) return "docs";
  if (/build|compile|bundle|package/.test(value)) return "build";
  return null;
}

function kindForCommand(command: string): VerificationCommandKind {
  return kindForScript(command, command) ?? "other";
}

function costForKind(kind: VerificationCommandKind, name: string): VerificationCost {
  if (kind === "build" || /all|full|workspace|\.\.\./i.test(name)) return "high";
  if (kind === "lint" || kind === "typecheck" || kind === "docs") return "medium";
  return "medium";
}

function extractValidationCommand(line: string): string | null {
  const trimmed = line.trim().replace(/^[-|>]+\s*/, "");
  const patterns = [
    /\b(?:npm|pnpm)\s+(?:run\s+)?(?:test|lint|check|typecheck|build)\b/i,
    /\byarn\s+(?:test|lint|check|typecheck|build)\b/i,
    /\b(?:python(?:\s+-m)?\s+pytest|pytest|tox)\b/i,
    /\bcargo\s+(?:test|check|build)\b/i,
    /\bgo\s+(?:test|vet|build)\s+\.\/\.\.\b/i,
    /\b(?:make|just)\s+(?:test|lint|check|typecheck|build)\b/i
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[0]) return match[0].trim();
  }
  return null;
}

function hasSection(content: string, section: string): boolean {
  return new RegExp(`^\\[${escapeRegExp(section)}(?:\\.|\\])`, "im").test(content);
}

function existsInFiles(files: string[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file));
}

function isCiFile(file: string): boolean {
  return file.startsWith(".github/workflows/") || file === ".gitlab-ci.yml" || file === "Jenkinsfile" || file === "azure-pipelines.yml";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function relativePathLabel(relativePath: string): string {
  return relativePath === "package.json" ? "root package.json" : relativePath;
}

function stableCommands(commands: CommandSpec[]): VerificationCommand[] {
  const seen = new Set<string>();
  return [...commands]
    .map(({ name: _name, ...command }) => command)
    .filter((command) => {
      const key = [command.command, command.cwd, command.source, command.kind].join("\0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      [left.cwd, left.scope, left.kind, left.command, left.source]
        .join("\0")
        .localeCompare([right.cwd, right.scope, right.kind, right.command, right.source].join("\0"))
    );
}

function byRelativePath(left: { relativePath: string }, right: { relativePath: string }): number {
  return left.relativePath.localeCompare(right.relativePath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
