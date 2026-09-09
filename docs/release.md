# Release Checklist

[中文](release.zh-CN.md) | English

OpenCode++ ships one product deliverable and one developer deliverable:

- the Windows EXE is the product release: the user-level official OpenCode Desktop plugin and its `opencode-plusplus` primary mode;
- the npm package is a developer artifact that carries the CLI, MCP, Harness, and shared runtime code as development/CI tooling. Desktop users never install it.

Benchmark fixtures, agent runs, repository documentation, local runtime artifacts, and stale build output must not enter the npm package. The npm package must also exclude `release/`, `.installer-build/`, and `apps/desktop/`.

The product boundary is intentionally narrow: the EXE installs one OpenCode Desktop plugin and one `OpenCode++` primary mode. It does not patch `app.asar`, add Slash Commands, install a second model, or turn the operating system into a sandbox. The plugin is a user-level control and evidence layer around the tools already provided by OpenCode Desktop.

The release notes must describe the user-visible distinction between selected/rejected files, prevented risks, suggested repairs, verified fixes, and remaining human review. A `verified fix` requires fresh command or CI evidence matched to the current working tree; Context documents, annotations, manual claims, and earlier test results are not equivalent proof.

## Full Gate

```powershell
npm run check
npm run lint
npm run format:check
npm run docs:cli:check
npm run docs:bilingual:check
npm test
npm run benchmark
npm run benchmark:agent
npm run benchmark:desktop
npm run build
npm run build:installer:windows
npm run test:installer:windows
npm run release:verify
npm run release:verify:desktop
```

## npm Package

The root package.json version is the single version source. package-info:generate creates runtime constants used by CLI, MCP, freshness, and the plugin bundle.

Confirm that npm pack contains dist, README files, config examples, package metadata, and LICENSE, including the plugin entry `dist/integrations/opencode/global-plugin.js`. It must not contain node_modules, benchmark fixtures, agent-runs, local cache, .agent-context, release EXEs, `.installer-build/`, or stale UI build output.

## Windows EXE

Build on Windows with Node.js 20+ and .NET Framework 4.x build tools. esbuild minifies the plugin, gzip compresses it, and the Windows C# compiler embeds it in the installer. The release must include:

- opencode-plusplus-setup-win-x64.exe;
- opencode-plusplus-setup-win-x64.exe.sha256;
- opencode-plusplus-release.json;
- release notes that state the supported architecture, per-user install boundary, restart requirement, and unsigned SmartScreen behavior.

Smoke test with an isolated --config-dir:

1. install and inspect status JSON;
2. verify the plugin and `agents/opencode-plusplus.md` primary mode exist, and confirm legacy command files are removed;
3. disable and confirm enabled=false;
4. enable and confirm enabled=true;
5. load or syntax-check the installed plugin;
6. uninstall and confirm only owned files are removed;
7. run `npm run test:installer:windows` and enforce the 12 MiB installer size budget;
8. run `npm run release:verify:desktop` to verify the EXE, SHA256, release manifest, standalone plugin load, mode path, legacy cleanup, uninstall restoration, and installer health/repair metadata;
9. run `npm run benchmark:desktop`; it is a deterministic in-process plugin benchmark with zero paid model calls;
10. use the manual `Desktop smoke` workflow to install the official `SST.OpenCodeDesktop` winget package and run `npm run test:desktop:real` against it.

PR CI runs on Ubuntu and Windows. It never runs a paid executor. Linux verifies the npm developer package and deterministic proxy benchmarks; Windows builds the EXE, runs the installer/recovery gate, and runs the deterministic Desktop plugin benchmark. Real Desktop launch is manual only; the workflow installs the official Desktop package before launching it. The manual release workflow requires the same launch gate before assets are uploaded or published.

The default release path is offline. No remote Context Registry source or feedback transport is required for build, installer smoke, or deterministic benchmarks. If a release test enables a remote source, record its URL, timeout, size limit, content hash, and offline fallback behavior. Network failure, invalid registry data, permission denial, read-only repositories, non-ASCII Windows paths, and transient file locks must produce a diagnosable failure or review result, never a false pass.

The Windows installer performs a preflight before every mutating action. A running `OpenCode.exe`, invalid config path, unwritable target, or corrupt state blocks installation before any owned file is changed. `--doctor --json` is read-only; `--repair --json` restores only the plugin, primary agent, runtime state, manifest, and legacy files owned by OpenCode++. It must preserve a valid enabled state and must not rewrite user OpenCode configuration. The install dialog reports the version, config path, plugin/agent result, and restart/select/use steps instead of only saying “restart”.

## Publish Verification

After publishing, verify npm version, GitHub tag, Release assets, EXE digest, asset size, manifest version, and origin/main commit. `npm run release:verify` checks the npm developer package without requiring installer output; `npm run release:verify:desktop` adds the Windows EXE gates after the installer is built. A clean checkout must reproduce both checks without relying on local dist or release files. The root `package.json` remains the single version source; generated package info and the Desktop release manifest must match it.

Runtime files under `.agent-context/`, `benchmarks/results/`, `dist/`, `release/`, `.installer-build/`, local configuration, and secrets are build outputs or user data. They must not be committed or uploaded as source assets. Registry cache, usage, feedback, annotations, interventions, traces, and sidecar reports remain repository-local runtime state and are excluded from the npm package.
