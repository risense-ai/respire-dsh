# Respire for DeepSeek Harness

**npm 包：[@rsrsai/dsh](https://www.npmjs.com/package/@rsrsai/dsh)** ·
[中文安装步骤](#中文安装) · [English installation](#install)

## 中文安装

需要 Node.js 24+、DeepSeek Harness **0.2.1-rc.2** 和已安装的 `rsrs`。
插件从 npm 安装到 Harness 当前 profile，通过组合包配置启用。

### 1. 准备 Respire 引擎

如果尚未安装 `rsrs`，先在终端执行：

```sh
npm install -g @rsrsai/cli@latest
rsrs --version
rsrs --client-only status --json
```

通过 `rsrs` 的交互流程完成账号配置、解锁记忆库，并确保宿主 runtime 正在运行。
已有可用的 `rsrs` 环境可跳过此步。

### 2. 在 Harness 中安装 npm 组合包

把下面这句话发给 **Harness 内的助手**：

```text
请使用 plugin_manager 的 install_bundle 安装 npm 组合包 @rsrsai/dsh，并确认 respire-memory 已启用。
```

对应工具参数如下；需要固定版本时将 `target` 改为 `@rsrsai/dsh@0.1.2`：

```json
{
  "action": "install_bundle",
  "target": "@rsrsai/dsh"
}
```

这里的 `@rsrsai/cli` 是引擎，`@rsrsai/dsh` 是 Harness 插件。
仅在普通终端运行 `npm install @rsrsai/dsh` 不会自动将插件接入 Harness profile。

### 3. 从之前的 Git 安装迁移

如果已安装旧组合包 `@rsrsai/respire-dsh`，先在 Harness 插件管理中移除旧组合包，
再按上面的步骤安装 `@rsrsai/dsh`。若提示仍在使用，先停用旧组合包再移除；
若管理器要求停止 profile，则按其提示停止后再操作。
保留现有记忆库、账号和 `rsrs` 配置，无需重新创建。

安装完成后重启 Harness，在插件管理中确认只有一条 `respire-memory`，
来源为 `@rsrsai/dsh` 且已启用。npm 安装与模块加载已验证；桌面完整对话链路尚未验收。

## Overview

Native TypeScript memory plugin for DeepSeek Harness. It registers stable rules
with `systemPrompt.section`, recalls memory through `agent/pre-step`, and checks
for new findings through `agent/turn-stopping`. Respire (`rsrs`) owns storage,
deduplication, encryption, model inference, accounts, and synchronization.

## Install

Requires Node.js 24+, DeepSeek Harness **0.2.1-rc.2**, and an installed `rsrs` CLI.
The plugin uses the Harness `agents`, `systemPrompt`, `subprocess`, and
`workingDirectory` services already provided by the standard desktop profile.
Other Harness versions have not been validated.

Install the engine separately if needed:

```sh
npm install -g @rsrsai/cli@latest
rsrs --version
rsrs --client-only status --json
```

Configure accounts, unlock the library, and install optional semantic models with
the CLI's own interactive workflow. The plugin does not install software, collect
passwords, start a runtime, or change account configuration. It always calls
`rsrs --client-only`, so a running host runtime is required.

In Harness, ask the agent to invoke `plugin_manager` with:

```json
{
  "action": "install_bundle",
  "target": "@rsrsai/dsh"
}
```

For local development, use this checkout's absolute directory as `target`.
Compiled `lib/` files are included in Git and release archives; installation
requires no build scripts. Restart Harness after replacing an installed version.
The published package is [@rsrsai/dsh](https://www.npmjs.com/package/@rsrsai/dsh).
Use a versioned target such as `@rsrsai/dsh@0.1.2` to pin an installation.

## Behavior

| Trigger | Result |
| --- | --- |
| First accepted user input per live agent | Read engine status; report missing runtime, locked library, missing session, or a small library when applicable |
| Accepted user message | `recall --titles --json`; inject at most 5 titles into the same model step |
| `记：`, `存：`, `记录：`, `记住：`, `remember:` | Attempt `remember` once, then inject a success, pending, or failure receipt |
| `/nomem` or `#nomem` followed by whitespace/end | Skip that message's automatic recall; status and stop checks remain enabled |
| `$skill: name` prefix | Remove the skill selector from the recall query |
| Natural stop | At most one reminder per agent/turn; a successful explicit store suppresses it |

Only messages attributed to the human (`source.kind === 'user'`) trigger work.
Plugin contexts, tool loops, and reminder continuations do not trigger recall or
store. Repeated admission of the same message ID in one turn is ignored. A new
user message with identical text is still processed. Downstream rejection and
cancellation prevent new work. A cancelled or timed-out write is **unconfirmed**,
not automatically retried: it may already have committed.

`pending` means **not written**. The agent must read candidates and decide whether
to update, merge, or attach to a parent. Success requires a valid returned ID.
Explicit storage initially uses an extracted title and `important`; the receipt
and rules tell the agent to refine the title and follow the library workflow.
The stop reminder asks the agent to evaluate new facts; it does not automatically
archive an entire transcript or guarantee that the model will store a finding.

## Configuration

Override the installed row in the user's Harness patch layer. A matching row's
`config` is replaced as a whole; unspecified plugin fields use the defaults.

```yaml
- id: respire-memory
  config:
    enabled: true
    rsrsPath: rsrs
    recallLimit: 5
    recallThreshold: 0
    budgetChars: 1500
    minPromptChars: 2
    storeNudgeEvery: 1
    timeoutMs: 20000
```

`rsrsPath` is an executable name or absolute path, not a shell command.
`storeNudgeEvery: 0` disables reminders; `N` checks every N user-bearing turns per
live agent. Changing profiles or reloading the plugin resets volatile reminder
state. Recall has a strict character budget; storage receipts are kept intact.

## Privacy and failure behavior

- Recall results and storage receipts become model-visible, persistent Harness
  messages. They may be sent to the configured model provider. Local encryption
  does not make injected context private from that provider.
- Common credential patterns are rejected before recall or explicit storage.
  This heuristic is not a complete secret scanner. Remove secrets from input;
  retain only safe purpose/location references in memory.
- Logs contain operation/error categories, not prompts, memory bodies, raw CLI
  errors, or credentials. No plugin-owned files are written to the library.
- Engine failure produces a bounded notice and lets the primary task continue.
  Windows arguments travel as JSON stdin to a constant PowerShell script;
  POSIX arguments are passed directly. Neither embeds user text in shell source.
- Processes run in the agent's verified working directory through the Harness
  subprocess provider. Its execution environment determines where `rsrs` and
  the memory runtime must be installed (including remote profiles).

## Development and release

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm pack
```

Tests exercise real Cordis event dispatch with a controlled subprocess service;
they never write the user's memory library. Production targets the published
Harness 0.2.1-rc.2 API. `package-lock.json` locks the verification dependencies.

CI runs type checking, build, tests, distribution checks, and generated-file
consistency on Linux, macOS, and Windows. To release, update `package.json` and
the lockfile, rebuild and commit `lib/`, then push `v<package version>`.
The release workflow reuses the full CI matrix before publishing `@rsrsai/dsh`
to npm with provenance, then uploads the same `.tgz` and SHA-256 checksum to
GitHub Releases. Stable versions use `latest`; prereleases use `next`.
Ordinary main/PR pushes do not publish.

npm publishing uses GitHub OIDC, not a stored npm token. After the initial
authenticated publish, configure the package's Trusted Publisher with owner
`risense-ai`, repository `respire-dsh`, workflow `release.yml`, and permission
to run `npm publish`. Leave the environment blank. The workflow requires
`id-token: write` and a GitHub-hosted runner.

## References

- [respire-dimcode](https://github.com/risense-ai/respire-dimcode): behavior reference.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): host APIs.

The icon is original artwork distributed under this repository's MIT license.
