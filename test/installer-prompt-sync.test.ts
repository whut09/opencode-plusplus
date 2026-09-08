import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PLUSPLUS_AGENT, PLUSPLUS_AGENT_FILE } from "../src/installer/opencode-plusplus-prompts.js";
import { OPENCODE_AGENT_PERMISSION_KEYS, VERIFIED_OPENCODE_PLUGIN_API_VERSION } from "../src/integrations/opencode/permission-compatibility.js";

const root = path.resolve(".");

test("installer: C# installer mirrors the primary agent content", () => {
  const cs = readFileSync(path.join(root, "src", "installer", "windows-installer.cs"), "utf8");
  const match = cs.match(/private const string AgentContent = "((?:[^"\\]|\\.)*)";/);
  assert.ok(match, "C# installer must define AgentContent");
  assert.equal(unescapeCSharp(match[1] ?? ""), PLUSPLUS_AGENT);
  assert.ok(cs.includes(`private const string AgentFileName = "${PLUSPLUS_AGENT_FILE}";`));
  assert.ok(cs.includes("agentFile = Path.Combine(root, AgentFileName.Replace('/', Path.DirectorySeparatorChar))"));
});

test("installer prompt is a primary mode and contains no command workflow", () => {
  assert.match(PLUSPLUS_AGENT, /^mode: primary/m);
  assert.match(PLUSPLUS_AGENT, /opencode_plusplus_prepare/);
  assert.match(PLUSPLUS_AGENT, /opencode_plusplus_evaluate/);
  assert.match(PLUSPLUS_AGENT, /opencode_plusplus_next/);
  assert.doesNotMatch(PLUSPLUS_AGENT, /\$ARGUMENTS|Slash Command|\/plusplus-task|\/plusplus-verify/);
});

test("primary agent uses the verified OpenCode permission schema with a minimal override", () => {
  assert.equal(VERIFIED_OPENCODE_PLUGIN_API_VERSION, "1.18.18");
  assert.match(PLUSPLUS_AGENT, /^permission:\n/m);
  for (const key of ["external_directory", "webfetch", "doom_loop"]) assert.match(PLUSPLUS_AGENT, new RegExp(`^\\x20{2}${key}:`, "m"));
  assert.match(PLUSPLUS_AGENT, /^\x20{2}bash:\n/m);
  assert.doesNotMatch(PLUSPLUS_AGENT, /^\x20{2}(read|search|edit):/m);
  for (const key of OPENCODE_AGENT_PERMISSION_KEYS) assert.ok(["edit", "bash", "webfetch", "doom_loop", "external_directory"].includes(key));
});

function unescapeCSharp(literal: string): string {
  let output = "";
  for (let index = 0; index < literal.length; index++) {
    const char = literal[index];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = literal[index + 1];
    assert.ok(next === "n" || next === '"' || next === "\\", `Unsupported C# escape \\${next ?? "end"}`);
    output += next === "n" ? "\n" : next;
    index++;
  }
  return output;
}
