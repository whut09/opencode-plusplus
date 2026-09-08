# Permission 与 Guard 边界

[English](permission-boundaries.md) | 中文

OpenCode++ 有意把用户授权和工程语义分开：

| 层                      | 负责方           | 含义                             |
| ----------------------- | ---------------- | -------------------------------- |
| OpenCode Permission     | OpenCode Desktop | 用户是否允许执行操作。           |
| OpenCode++ Policy Guard | OpenCode++ 插件  | 操作是否符合当前任务和仓库边界。 |

## 兼容基线

仓库已验证的 Desktop 插件基线是 OpenCode Desktop 及其 `@opencode-ai/plugin` `1.18.18`。该版本的 agent 配置 schema 支持以下 permission 键：

```text
edit
bash
webfetch
doom_loop
external_directory
```

OpenCode++ primary agent 只使用这套 schema，不添加不受支持的 `read` 或 `search` 键。普通项目编辑不被 agent 覆盖，因此用户原有的 OpenCode 全局策略仍负责普通编辑。

## 三种结果

Command Guard 返回三种确定性结果：

- `allowed`：没有 OpenCode++ policy 阻断，也没有额外的宿主授权信号；
- `approval-required`：检测到应交给 OpenCode 原生权限弹窗决定的操作；
- `policy-blocked`：检测到任务或仓库语义边界违规，OpenCode++ 在执行前阻止工具。

需要用户授权的例子包括安装依赖、会影响网络的 Git 或下载命令，以及仓库外路径。插件会记录结果但不会抛错，让 OpenCode 原生权限层请求用户决定。

硬阻断的例子包括破坏性 reset/clean/delete、未知项目脚本、受保护的生成文件或密钥路径，以及可能篡改 Harness evidence 的命令。插件会在执行前抛错。即使 OpenCode 开启自动批准，宿主授权也不能绕过这个语义阻断。

结果仍保留旧的 `allowed` 布尔字段以兼容公开 API。它只在 `policy-blocked` 时为 `false`；需要区分三种结果时使用 `disposition`。

## Primary Agent 的最小覆盖

安装后的 `agents/opencode-plusplus.md` 只包含小范围的 agent-specific override：

- 包操作、网络、远程 Git 和仓库外路径先请求 OpenCode 用户授权；
- 拒绝常见破坏性 shell 模式和 doom-loop 行为；
- `webfetch` 需要用户授权；
- 不覆盖普通 `edit` 以及其他无关的全局权限。

这不是用户全局 OpenCode permission 配置的替代品。如果宿主不支持某条细粒度规则，插件对 `policy-blocked` 操作的确定性语义边界仍然有效。

## Evidence 边界

用户批准权限不等于验证证据。用户批准 `npm install` 只是授权命令；只有随后捕获的真实 command 或 CI evidence 才能满足 Harness 要求。同样，允许编辑也不代表任务正确。Guard、evidence freshness、policy 和 finalize 仍是独立判断。
