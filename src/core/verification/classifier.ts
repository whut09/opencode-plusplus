import path from "node:path";
import type { ContextPackage } from "../types.js";
import type { VerificationChangeClassification, VerificationChangeKind } from "./types.js";

export interface VerificationClassificationOptions {
  context?: ContextPackage;
}

const kindPriority: VerificationChangeKind[] = [
  "security-sensitive",
  "dependency",
  "build-system",
  "ci",
  "source-cross-module",
  "source-local",
  "config",
  "tests-only",
  "docs-only"
];

export function classifyVerificationChanges(changedFiles: string[], options: VerificationClassificationOptions = {}): VerificationChangeClassification {
  const normalizedFiles = [...new Set(changedFiles.map(normalizePath).filter(Boolean))].sort();
  if (!normalizedFiles.length) {
    return {
      changedFiles: [],
      kinds: ["docs-only"],
      primaryKind: "docs-only",
      docsOnly: true,
      codeTestRequired: false,
      affectedPackages: [],
      reason: "No actionable files changed; code verification is not required."
    };
  }

  const docsOnly = normalizedFiles.every(isDocumentationPath);
  if (docsOnly) {
    return {
      changedFiles: normalizedFiles,
      kinds: ["docs-only"],
      primaryKind: "docs-only",
      docsOnly: true,
      codeTestRequired: false,
      affectedPackages: [],
      reason: "Only README, Markdown, or docs files changed; code tests are not required unless repository policy declares a docs verifier."
    };
  }

  const kinds = new Set<VerificationChangeKind>();
  if (normalizedFiles.every(isTestPath)) kinds.add("tests-only");
  if (normalizedFiles.some(isCiPath)) kinds.add("ci");
  if (normalizedFiles.some(isDependencyPath)) kinds.add("dependency");
  if (normalizedFiles.some(isBuildSystemPath)) kinds.add("build-system");
  if (normalizedFiles.some(isConfigPath)) kinds.add("config");
  if (normalizedFiles.some(isSecuritySensitivePath)) kinds.add("security-sensitive");

  const sourceFiles = normalizedFiles.filter(isSourcePath);
  if (sourceFiles.length) kinds.add(sourceKind(sourceFiles, options.context));
  if (!kinds.size) kinds.add("config");

  const orderedKinds = kindPriority.filter((kind) => kinds.has(kind));
  const primaryKind = orderedKinds[0] ?? "config";
  const affectedPackages = affectedPackageNames(normalizedFiles, options.context);
  return {
    changedFiles: normalizedFiles,
    kinds: orderedKinds,
    primaryKind,
    docsOnly: false,
    codeTestRequired: true,
    affectedPackages,
    reason: reasonForKinds(orderedKinds, affectedPackages)
  };
}

export function isDocumentationPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const base = path.posix.basename(normalized).toLowerCase();
  return normalized.toLowerCase().startsWith("docs/") || /^readme(?:\.|$)/i.test(base) || /\.(md|mdx)$/i.test(base);
}

export function isTestPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  const base = path.posix.basename(normalized);
  return (
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/__tests__/") ||
    /(?:^|[._-])(test|spec)(?:[._-]|$)/.test(base) ||
    /^test_[^/]+\.py$/.test(base) ||
    /_test\.go$/.test(base)
  );
}

export function requiresSourceVerification(classification: VerificationChangeClassification): boolean {
  return classification.kinds.some((kind) =>
    ["source-local", "source-cross-module", "config", "dependency", "build-system", "ci", "security-sensitive"].includes(kind)
  );
}

function sourceKind(sourceFiles: string[], context?: ContextPackage): VerificationChangeKind {
  const modules = new Set<string>();
  const indexed = new Map(context?.index.files.map((file) => [file.path, file.moduleName]) ?? []);
  for (const file of sourceFiles) {
    const moduleName = indexed.get(file);
    if (moduleName) modules.add(moduleName);
    else modules.add(fallbackModuleName(file));
  }
  if (modules.size > 1) return "source-cross-module";

  if (context) {
    const sourceSet = new Set(sourceFiles);
    const crossesModule = context.graph.fileEdges.some((edge) => {
      if (!sourceSet.has(edge.from) || edge.isExternal || !sourceSet.has(edge.to)) return false;
      return indexed.get(edge.from) !== indexed.get(edge.to);
    });
    if (crossesModule) return "source-cross-module";
  }
  return "source-local";
}

function affectedPackageNames(files: string[], context?: ContextPackage): string[] {
  const indexed = new Map(context?.index.files.map((file) => [file.path, file.moduleName]) ?? []);
  const packages = new Set<string>();
  for (const file of files) {
    const moduleName = indexed.get(file);
    if (moduleName && moduleName !== "root") {
      packages.add(moduleName);
      continue;
    }
    const segments = file.split("/");
    const packageIndex = segments.findIndex((segment) => /^(packages|apps|libs|modules)$/i.test(segment));
    if (packageIndex >= 0 && segments[packageIndex + 1]) packages.add(segments.slice(0, packageIndex + 2).join("/"));
  }
  return [...packages].sort();
}

function isDependencyPath(filePath: string): boolean {
  const base = path.posix.basename(filePath).toLowerCase();
  return (
    /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|go\.sum|poetry\.lock|pipfile\.lock|requirements[^/]*\.txt)$/.test(base) ||
    /(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod|setup\.cfg|pipfile)$/.test(filePath.toLowerCase())
  );
}

function isBuildSystemPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const base = path.posix.basename(normalized);
  return (
    /^(makefile|justfile|gnu makefile|cargo\.toml|tsconfig[^/]*\.json)$/.test(base) || /(^|\/)(vite|webpack|rollup|esbuild|turbo|nx)\.config\./.test(normalized)
  );
}

function isCiPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  return normalized.startsWith(".github/workflows/") || normalized === ".gitlab-ci.yml" || /(^|\/)(jenkinsfile|azure-pipelines\.yml)$/.test(normalized);
}

function isConfigPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  const base = path.posix.basename(normalized);
  return /\.(json|yaml|yml|toml|ini|cfg|conf|xml|env)$/.test(base) || /(^|\/)(config|configs?)\//.test(normalized);
}

function isSecuritySensitivePath(filePath: string): boolean {
  return /(^|\/)(auth|security|session|credential|credentials|secret|token|payment|billing|checkout|invoice)(\/|\.|$)/i.test(normalizePath(filePath));
}

function isSourcePath(filePath: string): boolean {
  if (isDocumentationPath(filePath) || isTestPath(filePath)) return false;
  const normalized = normalizePath(filePath).toLowerCase();
  if (isCiPath(normalized) || isDependencyPath(normalized) || isConfigPath(normalized) || isBuildSystemPath(normalized)) return false;
  return /\.(c|cxx|cc|cpp|go|java|js|jsx|mjs|py|rb|rs|php|swift|ts|tsx|vue|svelte)$/.test(normalized);
}

function fallbackModuleName(filePath: string): string {
  const segments = filePath.split("/");
  const packageIndex = segments.findIndex((segment) => /^(packages|apps|libs|modules)$/i.test(segment));
  if (packageIndex >= 0 && segments[packageIndex + 1]) return segments.slice(0, packageIndex + 2).join("/");
  const sourceIndex = segments.findIndex((segment) => /^(src|lib|app|cmd)$/i.test(segment));
  if (sourceIndex >= 0 && segments[sourceIndex + 1]) return segments.slice(0, sourceIndex + 2).join("/");
  return "root";
}

function reasonForKinds(kinds: VerificationChangeKind[], packages: string[]): string {
  const packageReason = packages.length ? ` Affected packages: ${packages.join(", ")}.` : "";
  return `Changed files classified as ${kinds.join(", ")}.${packageReason} Classification is deterministic and does not use model output.`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
