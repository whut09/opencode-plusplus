# Smart Verification Planner

[English](verification-planner.md) | 中文

Smart Verification Planner 会根据仓库 diff 生成一组小而可解释的**建议验证命令**。它是 Harness 的规划层，不执行命令，也绝不会写入 Evidence ledger。

## 为什么需要它

每个任务都运行完整测试套件会慢且打扰用户。只改文档不应该触发 monorepo 全量构建；而依赖或跨模块变更也不能只跑一个局部测试。Planner 使用仓库元数据和真实变更文件，选择当前变更所需的最小验证范围。

边界明确如下：

```text
仓库文件 + 真实 diff
       -> discovery
       -> 确定性分类
       -> 按成本规划
       -> 用户/Agent 可以执行命令
       -> Desktop command hook 记录 Evidence
       -> Policy 和 Loop 检查 freshness
```

Discovery 不是执行。计划中的 `npm run test` 只是建议；只有 Desktop command hook 或 CI importer 记录退出码、输出 hash 和当前 working-tree hash 后，才是 Evidence。

## 发现来源

`discoverVerificationCommands()` 只读取本地配置，不启动子进程。它识别：

- Node `package.json` 脚本（`test`、`lint`、`typecheck`、`check`、`build` 和文档检查），包括声明的 workspace；
- Python `pyproject.toml`、`pytest.ini`、`tox.ini`，以及 `setup.cfg` 中的 pytest/Ruff/mypy 配置；
- Rust `Cargo.toml`（`cargo test`、`cargo check`、`cargo build`）；
- Go `go.mod`（`go test ./...`、`go vet ./...`、`go build ./...`）；
- `Makefile`、`Justfile` 及其中识别出的 test/lint/check/build target；
- CI workflow 文件，作为较低可信度的本地建议；
- 当没有对应 package script 时，从 TypeScript 和 ESLint 配置给出 fallback 建议。

每条结果包含：

| 字段            | 含义                                                    |
| --------------- | ------------------------------------------------------- |
| `command`       | 用户或 Agent 可以选择执行的命令。                       |
| `cwd`           | 命令的绝对工作目录。                                    |
| `source`        | 触发发现的文件或来源类型。                              |
| `scope`         | `file`、`package`、`workspace` 或 `repository`。        |
| `estimatedCost` | `low`、`medium` 或 `high`，只是调度提示，不是 timeout。 |
| `confidence`    | 确定性元数据可信等级：`high`、`medium` 或 `low`。       |
| `reason`        | 面向人的建议原因。                                      |

配置损坏会返回诊断，不会静默变成空配置或验证通过。

## 变更分类

`classifyVerificationChanges()` 使用规范化路径、文件类型、package 边界和已有依赖图，不使用 LLM。

| 分类                  | 典型信号                                                           | 默认验证意图                                                |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `docs-only`           | 只有 `README*`、`docs/**`、`*.md`、`*.mdx`                         | 不要求代码测试；只有配置了 docs verifier 才建议运行。       |
| `tests-only`          | 测试目录和 test/spec 文件名                                        | 运行受影响测试。                                            |
| `source-local`        | 一个模块/package 内的源码变更                                      | 先做改文件 lint，再做相关测试，最后做可用的局部 typecheck。 |
| `source-cross-module` | 多个模块或 package 边界                                            | 增加 workspace 测试和更宽的 typecheck。                     |
| `config`              | 运行时、编译器或项目配置                                           | 验证受影响 package 及配置消费者。                           |
| `dependency`          | manifest 或 lockfile 变更                                          | 有条件时增加 workspace 检查和 build。                       |
| `build-system`        | build 脚本/配置、Cargo/Make/Just 构建输入                          | 根据发现到的命令加入 typecheck/build。                      |
| `ci`                  | CI workflow 或 pipeline 文件                                       | 验证变更 workflow 中表达的命令。                            |
| `security-sensitive`  | auth、session、credential、secret、payment、billing、checkout 路径 | 保留底层计划，并增加更宽的 review 信号。                    |

一组文件可以属于多个分类。主分类按固定严重度顺序选择，因此数组或文件枚举顺序不会改变结果。

## 最小计划

Planner 按以下顺序选择，并在适合当前分类的最小集合处停止：

```text
改动文件 lint
    -> 受影响 package test
    -> package typecheck
    -> 高风险变更的 workspace test
    -> 依赖/build/CI/security 变更的 full build（存在时）
```

受影响 workspace package 优先于根目录全量脚本。如果 package 没有验证器，才回退到 root/workspace 命令。命令按 command、工作目录和 kind 去重后稳定排序。

Planner 可以使用已有测试/依赖图，把 package test 细化为相关测试文件命令，但不会宣称该命令已经通过。

## docs-only 和没有测试的仓库

只改文档时，计划返回 `codeTestRequired: false`。若没有发现 Markdown 或文档验证器，`verificationRequired` 也为 false，Loop 不会伪造 `run-tests` blocker 或 human-review。若配置了 docs verifier，则返回可选择执行的 docs 命令。

源码/config 变更但没有可执行验证器时，`codeTestRequired` 仍为 true，`commands` 为空，`verificationRequired` 仍为 true。Loop 会进入 human-review，因为必须由人选择或配置检查命令；Planner 不会凭空发明命令。

## Evidence 与 freshness

Planner 不会削弱 `evidenceSatisfies()`：

- strict policy 只能由符合策略的 command 或 CI 记录满足；
- 结果必须成功退出，并带当前 working-tree hash；
- Evidence 必须发生在最后一次相关编辑之后；
- 再次编辑会使之前的成功证据 stale；
- Context、annotation、selector 输出和 planner 建议都不是测试证据。

Policy 和 Loop 消费同一个 `VerificationPlan`。报告会展示分类和命令原因，现有公开 `buildTestSelection()` API 继续兼容。

## 接入位置

- 核心 planner：`src/core/verification/`
- Policy：`src/harness/verification-plane/policy-engine.ts`
- Loop：`src/harness/control-plane/loop-controller.ts`
- 任务 artifact：`.agent-context/runs/<task-id>/verification-plan.md`
- Desktop 结果：结构化 Harness result 中的 `verification`
- 共用 application service：`src/application/verification-service.ts`

使用 `npm test` 和聚焦的 `test/verification-planner.test.ts` 验证改动。不要提交 `.agent-context/` 运行时输出或构建目录。
