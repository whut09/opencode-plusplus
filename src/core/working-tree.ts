import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";

export function currentWorkingTreeFingerprint(root: string): string {
  const pathspec = ["--", ".", ":(exclude).agent-context/**", ":(exclude)AGENTS.md"];
  const diff = runGit(root, ["diff", "--binary", "HEAD", ...pathspec]);
  if (diff.status !== 0) return hashFileTree(root);
  const untracked = untrackedFileManifest(root, pathspec);
  if (untracked === undefined) return hashFileTree(root);
  return hashText([gitOutput(diff), untracked].join("\n"));
}

function hashFileTree(root: string): string {
  const files: string[] = [];
  walk(root, root, files);
  return hashText(
    files
      .sort()
      .map((file) => `${file}\0${hashBytes(readFileSync(path.join(root, file)))}`)
      .join("\n")
  );
}

function untrackedFileManifest(root: string, pathspec: string[]): string | undefined {
  const result = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec]);
  if (result.status !== 0) return undefined;
  const files = result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return files
    .map((file) => {
      const absolute = path.resolve(root, file);
      try {
        const stats = lstatSync(absolute);
        if (stats.isSymbolicLink()) return `${file}\0symlink\0${readlinkSync(absolute)}`;
        if (!stats.isFile()) return `${file}\0non-file\0${stats.mode.toString(8)}`;
        return `${file}\0file\0${stats.mode.toString(8)}\0${hashBytes(readFileSync(absolute))}`;
      } catch (error) {
        return `${file}\0unreadable\0${error instanceof Error ? error.message : String(error)}`;
      }
    })
    .join("\n");
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function runGit(root: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error?.message
  };
}

function walk(root: string, directory: string, files: string[]): void {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (item.name === ".git" || item.name === ".agent-context" || item.name === "node_modules") continue;
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) walk(root, absolute, files);
    else if (item.isFile() && existsSync(absolute) && statSync(absolute).size <= 16 * 1024 * 1024)
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
}

function gitOutput(result: GitResult): string {
  return [
    `status=${typeof result.status === "number" ? result.status : "unknown"}`,
    result.stdout,
    result.status === 0 ? "" : typeof result.stderr === "string" ? result.stderr : "",
    result.error ?? ""
  ].join("\n");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
