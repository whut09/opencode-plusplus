export interface PluginEditBoundary {
  allowedEditGlobs: string[];
  avoidEditGlobs: string[];
  revision: number;
}

export interface PluginEditBoundaryAssessment {
  boundaryRevision: number;
  allowedEditGlobs: string[];
  avoidEditGlobs: string[];
  changedFiles: string[];
  outsideAllowed: string[];
  avoided: string[];
  expansionRequired: boolean;
}

export function assessPluginEditBoundary(changedFiles: string[], boundary: PluginEditBoundary): PluginEditBoundaryAssessment {
  const normalizedChanged = unique(changedFiles);
  const allowed = unique(boundary.allowedEditGlobs);
  const avoid = unique(boundary.avoidEditGlobs);
  const outsideAllowed = allowed.length ? normalizedChanged.filter((file) => !allowed.some((glob) => matchesPathGlob(file, glob))) : [];
  const avoided = normalizedChanged.filter((file) => avoid.some((glob) => matchesPathGlob(file, glob)));
  return {
    boundaryRevision: boundary.revision,
    allowedEditGlobs: allowed,
    avoidEditGlobs: avoid,
    changedFiles: normalizedChanged,
    outsideAllowed,
    avoided,
    expansionRequired: outsideAllowed.some((file) => !avoided.includes(file))
  };
}

export function matchesPathGlob(filePath: string, glob: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedGlob = normalizePath(glob);
  if (!normalizedGlob) return false;
  let pattern = "^";
  for (let index = 0; index < normalizedGlob.length; index += 1) {
    const character = normalizedGlob[index]!;
    const next = normalizedGlob[index + 1];
    if (character === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(character);
    }
  }
  pattern += "$";
  return new RegExp(pattern).test(normalizedFile);
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizePath).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
