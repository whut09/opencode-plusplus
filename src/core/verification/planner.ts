import type { ContextPackage } from "../types.js";
import { isTestExecutionCommand } from "../test-command.js";
import { buildTestSelection } from "../../outputs/test-selector.js";
import { classifyVerificationChanges } from "./classifier.js";
import { discoverVerificationCommands } from "./discovery.js";
import type { VerificationCommand, VerificationCommandKind, VerificationPlan, VerificationPlannerOptions, VerificationScope } from "./types.js";

export function buildVerificationPlan(input: string | ContextPackage, options: VerificationPlannerOptions = {}): VerificationPlan {
  const root = typeof input === "string" ? input : input.scan.root;
  const context = typeof input === "string" ? undefined : input;
  const changedFiles = options.changedFiles ?? [];
  const classification = classifyVerificationChanges(changedFiles, { context });
  const discovery = discoverVerificationCommands(root);
  const commands = selectCommands(discovery.commands, classification, changedFiles, context, options);
  const verificationRequired = classification.codeTestRequired || commands.length > 0 || Boolean(options.docsBuildRequired && classification.docsOnly);

  return {
    classification,
    discovery,
    commands,
    codeTestRequired: classification.codeTestRequired,
    verificationRequired,
    reason: reasonForPlan(classification, commands, options.docsBuildRequired === true)
  };
}

export function renderVerificationPlan(plan: VerificationPlan): string {
  const lines = [
    `Change classification: ${plan.classification.primaryKind}`,
    `Code tests required: ${plan.codeTestRequired ? "yes" : "no"}`,
    `Verification required: ${plan.verificationRequired ? "yes" : "no"}`,
    plan.reason,
    "",
    "Recommended verification commands:"
  ];
  if (!plan.commands.length) lines.push("- none");
  for (const command of plan.commands) {
    lines.push(`- ${command.command} [${command.scope}/${command.estimatedCost}/${command.confidence}] — ${command.reason}`);
  }
  return lines.join("\n");
}

function selectCommands(
  discovered: VerificationCommand[],
  classification: VerificationPlan["classification"],
  changedFiles: string[],
  context: ContextPackage | undefined,
  options: VerificationPlannerOptions
): VerificationCommand[] {
  if (classification.docsOnly) {
    return options.docsBuildRequired ? selectDocsCommands(discovered) : selectDocsCommands(discovered);
  }

  const selected: VerificationCommand[] = [];
  const packagePaths = classification.affectedPackages;
  const packageScoped = (kind: VerificationCommandKind): VerificationCommand[] => {
    const packageCommands = discovered.filter((command) => command.kind === kind && command.packagePath && isRelevantPackageCommand(command, packagePaths));
    if (packageCommands.length) return packageCommands;
    return discovered.filter((command) => command.kind === kind && !command.packagePath && isRelevantPackageCommand(command, []));
  };
  const rootOrWorkspace = (kind: VerificationCommandKind): VerificationCommand[] =>
    discovered.filter((command) => command.kind === kind && (command.scope === "workspace" || command.scope === "repository"));

  if (classification.kinds.includes("tests-only")) {
    addUnique(selected, focusedTestCommands(context, changedFiles, discovered));
    addUnique(selected, packageScoped("test"));
    return selected;
  }

  addUnique(selected, changedFileLintCommands(packageScoped("lint"), changedFiles));
  addUnique(selected, focusedTestCommands(context, changedFiles, packageScoped("test")));
  addUnique(selected, packageScoped("test"));
  addUnique(selected, packageScoped("typecheck"));

  if (classification.kinds.some((kind) => ["source-cross-module", "dependency", "build-system", "ci", "security-sensitive"].includes(kind))) {
    addUnique(selected, rootOrWorkspace("test"));
  }
  if (classification.kinds.some((kind) => ["dependency", "build-system", "ci", "security-sensitive"].includes(kind))) {
    addUnique(selected, rootOrWorkspace("typecheck"));
    addUnique(selected, rootOrWorkspace("build"));
  }
  return selected;
}

function selectDocsCommands(discovered: VerificationCommand[]): VerificationCommand[] {
  return discovered
    .filter((command) => command.kind === "docs" || (command.kind === "lint" && /markdown|docs?/i.test(command.command + command.reason)))
    .sort(compareCommand)
    .slice(0, 2);
}

function changedFileLintCommands(commands: VerificationCommand[], changedFiles: string[]): VerificationCommand[] {
  if (!changedFiles.length || !commands.length) return [];
  const paths = changedFiles.filter((file) => !/^docs\//i.test(file) && !/\.mdx?$/i.test(file));
  if (!paths.length) return [];
  return commands.slice(0, 1).map((command) => ({
    ...command,
    command: `${command.command} -- ${paths.map(quoteCommandPath).join(" ")}`,
    scope: "file" as VerificationScope,
    reason: `Run the repository lint command against ${paths.length} changed file${paths.length === 1 ? "" : "s"}.`
  }));
}

function focusedTestCommands(context: ContextPackage | undefined, changedFiles: string[], fallback: VerificationCommand[]): VerificationCommand[] {
  if (!context || !changedFiles.length) return [];
  const selection = buildTestSelection(context, { forPaths: changedFiles });
  const executable = selection.minimalCommands.filter(isTestExecutionCommand);
  if (!executable.length) return [];
  const template = fallback[0];
  if (!template) return [];
  return executable.map((command) => ({
    ...template,
    command,
    scope: "file" as VerificationScope,
    estimatedCost: "low",
    reason: "A related test file was selected from the current repository dependency and test graph."
  }));
}

function isRelevantPackageCommand(command: VerificationCommand, packagePaths: string[]): boolean {
  if (!packagePaths.length) return command.scope === "repository" || command.scope === "workspace" || !command.packagePath;
  const commandPackagePath = command.packagePath;
  if (!commandPackagePath) return command.scope === "workspace" || command.scope === "repository";
  return packagePaths.some((packagePath) => commandPackagePath === packagePath || commandPackagePath.startsWith(`${packagePath}/`));
}

function addUnique(target: VerificationCommand[], additions: VerificationCommand[]): void {
  const seen = new Set(target.map(commandKey));
  for (const command of additions.sort(compareCommand)) {
    const key = commandKey(command);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(command);
  }
}

function commandKey(command: VerificationCommand): string {
  return [command.command, command.cwd, command.kind].join("\0");
}

function compareCommand(left: VerificationCommand, right: VerificationCommand): number {
  return [left.scope, left.kind, left.command, left.cwd].join("\0").localeCompare([right.scope, right.kind, right.command, right.cwd].join("\0"));
}

function quoteCommandPath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath.replace(/"/g, '\\"')}"` : filePath;
}

function reasonForPlan(classification: VerificationPlan["classification"], commands: VerificationCommand[], docsBuildRequired: boolean): string {
  if (classification.docsOnly && !docsBuildRequired && !commands.length) {
    return "Docs-only change: no code test is required and no repository docs verifier was discovered.";
  }
  if (!commands.length && classification.codeTestRequired) {
    return "Executable verification is required, but no deterministic repository command was discovered; human review must choose a command.";
  }
  return `Selected ${commands.length} minimal command${commands.length === 1 ? "" : "s"} for ${classification.primaryKind}; broader workspace checks are reserved for cross-module, dependency, build, CI, or security-sensitive changes.`;
}
