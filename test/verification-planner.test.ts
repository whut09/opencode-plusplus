import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyVerificationChanges } from "../src/core/verification/classifier.js";
import { discoverVerificationCommands } from "../src/core/verification/discovery.js";
import { buildVerificationPlan } from "../src/core/verification/planner.js";

function createFixture(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `opencode-plusplus-verification-${prefix}-`));
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function writeJsonFixture(root: string, relativePath: string, value: unknown): void {
  writeFixture(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("discovery finds Node root and workspace scripts without writing evidence", () => {
  const root = createFixture("node");
  try {
    writeJsonFixture(root, "package.json", {
      workspaces: ["packages/*"],
      scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" }
    });
    writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    writeFixture(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeJsonFixture(root, "packages/api/package.json", { scripts: { test: "node --test", lint: "eslint src" } });

    const report = discoverVerificationCommands(root);
    assert.deepEqual(report.diagnostics, []);
    assert.ok(report.commands.some((command) => command.command === "pnpm test" && command.scope === "workspace"));
    assert.ok(report.commands.some((command) => command.command === "pnpm test" && command.packagePath === "packages/api"));
    assert.ok(report.commands.some((command) => command.command === "pnpm lint" && command.packagePath === "packages/api"));
    assert.ok(report.commands.every((command) => command.source !== "evidence"));
    assert.equal(existsSync(path.join(root, ".agent-context")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery recognizes Python, Rust, Go, Make, Just, and CI sources", () => {
  const root = createFixture("polyglot");
  try {
    writeFixture(root, "pyproject.toml", "[tool.pytest.ini_options]\naddopts = '-q'\n[tool.ruff]\nline-length = 100\n");
    writeFixture(root, "Cargo.toml", "[workspace]\nmembers = ['crates/app']\n");
    writeFixture(root, "go.mod", "module example.test\n\ngo 1.23\n");
    writeFixture(root, "Makefile", "test:\n\tpytest\nlint:\n\truff check .\n");
    writeFixture(root, "Justfile", "check:\n\tjust test\n");
    writeFixture(root, ".github/workflows/ci.yml", "steps:\n  - run: npm test\n  - run: cargo test\n");

    const report = discoverVerificationCommands(root);
    assert.ok(report.commands.some((command) => command.command === "python -m pytest" && command.source === "pyproject.toml"));
    assert.ok(report.commands.some((command) => command.command === "ruff check ." && command.source === "pyproject.toml"));
    assert.ok(report.commands.some((command) => command.command === "cargo test" && command.source === "cargo.toml"));
    assert.ok(report.commands.some((command) => command.command === "go test ./..." && command.source === "go.mod"));
    assert.ok(report.commands.some((command) => command.command === "make test" && command.source === "makefile"));
    assert.ok(report.commands.some((command) => command.command === "just check" && command.source === "justfile"));
    assert.ok(report.commands.some((command) => command.command === "npm test" && command.source === "ci-workflow"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery is deterministic and reports malformed manifests", () => {
  const root = createFixture("diagnostics");
  try {
    writeFixture(root, "package.json", "{ invalid\n");
    const first = discoverVerificationCommands(root);
    const second = discoverVerificationCommands(root);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.match(first.diagnostics[0] ?? "", /package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifier distinguishes docs, tests, dependencies, modules, and security", () => {
  assert.equal(classifyVerificationChanges(["README.md", "docs/guide.md"]).primaryKind, "docs-only");
  assert.equal(classifyVerificationChanges(["tests/login.test.ts"]).primaryKind, "tests-only");
  assert.equal(classifyVerificationChanges(["package-lock.json"]).primaryKind, "dependency");
  assert.equal(classifyVerificationChanges(["packages/api/src/index.ts", "packages/web/src/index.ts"]).primaryKind, "source-cross-module");
  const security = classifyVerificationChanges(["src/auth/session.ts"]);
  assert.equal(security.primaryKind, "security-sensitive");
  assert.ok(security.kinds.includes("source-local"));
});

test("source-local Node plans lint, affected tests, and typecheck without a full build", () => {
  const root = createFixture("node-plan");
  try {
    writeJsonFixture(root, "package.json", {
      scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" }
    });
    writeFixture(root, "src/login.ts", "export const login = true;\n");
    const plan = buildVerificationPlan(root, { changedFiles: ["src/login.ts"] });
    assert.equal(plan.classification.primaryKind, "source-local");
    assert.deepEqual(
      plan.commands.map((command) => command.kind),
      ["lint", "test", "typecheck"]
    );
    assert.equal(plan.commands[0]?.scope, "file");
    assert.ok(plan.commands[0]?.command.includes("src/login.ts"));
    assert.ok(!plan.commands.some((command) => command.kind === "build"));
    assert.equal(plan.codeTestRequired, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docs-only plans do not require code tests, with optional docs verification", () => {
  const root = createFixture("docs-plan");
  try {
    writeJsonFixture(root, "package.json", { scripts: { test: "node --test", "docs:check": "markdownlint docs" } });
    const plan = buildVerificationPlan(root, { changedFiles: ["docs/guide.md"] });
    assert.equal(plan.classification.docsOnly, true);
    assert.equal(plan.codeTestRequired, false);
    assert.equal(plan.verificationRequired, true);
    assert.deepEqual(
      plan.commands.map((command) => command.command),
      ["npm run docs:check"]
    );

    const noDocsVerifierRoot = createFixture("docs-no-verifier");
    try {
      writeJsonFixture(noDocsVerifierRoot, "package.json", { scripts: { test: "node --test" } });
      const noVerifierPlan = buildVerificationPlan(noDocsVerifierRoot, { changedFiles: ["README.md"] });
      assert.equal(noVerifierPlan.verificationRequired, false);
      assert.equal(noVerifierPlan.commands.length, 0);
    } finally {
      rmSync(noDocsVerifierRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-test source projects remain explicitly verification-required", () => {
  const root = createFixture("no-test");
  try {
    writeJsonFixture(root, "package.json", { name: "no-test-project" });
    writeFixture(root, "src/main.py", "print('hello')\n");
    const plan = buildVerificationPlan(root, { changedFiles: ["src/main.py"] });
    assert.equal(plan.codeTestRequired, true);
    assert.equal(plan.verificationRequired, true);
    assert.equal(plan.commands.length, 0);
    assert.match(plan.reason, /no deterministic repository command/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner prefers affected workspace package commands", () => {
  const root = createFixture("workspace-plan");
  try {
    writeJsonFixture(root, "package.json", { workspaces: ["packages/*"], scripts: { test: "node --test" } });
    writeJsonFixture(root, "packages/api/package.json", { scripts: { test: "node --test", lint: "eslint src", typecheck: "tsc --noEmit" } });
    const plan = buildVerificationPlan(root, { changedFiles: ["packages/api/src/index.ts"] });
    assert.ok(plan.classification.affectedPackages.includes("packages/api"));
    assert.ok(plan.commands.some((command) => command.packagePath === "packages/api"));
    assert.ok(!plan.commands.some((command) => command.packagePath === undefined && command.scope === "workspace"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner output contains no evidence record or stale-proof claim", () => {
  const root = createFixture("evidence-boundary");
  try {
    writeJsonFixture(root, "package.json", { scripts: { test: "node --test" } });
    const plan = buildVerificationPlan(root, { changedFiles: ["src/main.ts"] });
    assert.equal(existsSync(path.join(root, ".agent-context")), false);
    assert.ok(!readFileSync(path.join(root, "package.json"), "utf8").includes("evidence"));
    assert.ok(plan.reason.includes("Selected") || plan.reason.includes("no deterministic"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance fixtures cover npm, workspace, Python, Rust, Go, docs-only, and no-test repositories", () => {
  const fixtureRoot = path.join(process.cwd(), "test", "fixtures", "verification-planner");
  const npmPlan = buildVerificationPlan(path.join(fixtureRoot, "npm-project"), { changedFiles: ["src/app.ts"] });
  assert.deepEqual(
    npmPlan.commands.map((command) => command.kind),
    ["lint", "test", "typecheck"]
  );

  const workspacePlan = buildVerificationPlan(path.join(fixtureRoot, "monorepo"), { changedFiles: ["packages/api/src/index.ts"] });
  assert.ok(workspacePlan.commands.some((command) => command.packagePath === "packages/api"));
  assert.equal(workspacePlan.classification.primaryKind, "source-local");

  const pythonPlan = buildVerificationPlan(path.join(fixtureRoot, "python-project"), { changedFiles: ["src/app.py"] });
  assert.ok(pythonPlan.commands.some((command) => command.command === "python -m pytest"));
  assert.ok(pythonPlan.commands.some((command) => command.command.startsWith("ruff check .")));

  const rustDiscovery = discoverVerificationCommands(path.join(fixtureRoot, "rust-project"));
  assert.ok(rustDiscovery.commands.some((command) => command.command === "cargo test"));
  assert.ok(rustDiscovery.commands.some((command) => command.command === "cargo check"));

  const goDiscovery = discoverVerificationCommands(path.join(fixtureRoot, "go-project"));
  assert.ok(goDiscovery.commands.some((command) => command.command === "go test ./..."));
  assert.ok(goDiscovery.commands.some((command) => command.command === "go vet ./..."));

  const docsPlan = buildVerificationPlan(path.join(fixtureRoot, "docs-only"), { changedFiles: ["README.md", "docs/guide.md"] });
  assert.equal(docsPlan.codeTestRequired, false);
  assert.equal(docsPlan.verificationRequired, false);

  const noTestPlan = buildVerificationPlan(path.join(fixtureRoot, "no-test"), { changedFiles: ["src/main.py"] });
  assert.equal(noTestPlan.codeTestRequired, true);
  assert.equal(noTestPlan.commands.length, 0);
  assert.equal(noTestPlan.verificationRequired, true);
});
