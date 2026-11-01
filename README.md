# Respire for DeepSeek Harness

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/icon-respire-ai-memory.svg">
    <img src="docs/icon-respire-ai-memory-light.svg" alt="Respire AI memory icon" width="112">
  </picture>
</p>

English | [简体中文](https://github.com/risense-ai/respire-dsh/blob/main/README.zh-CN.md)

**npm package: [@rsrsai/dsh](https://www.npmjs.com/package/@rsrsai/dsh)**

## Install with AI — copy this prompt

Paste the entire prompt into **the assistant inside DeepSeek Harness**:

```text
Install the Respire memory plugin @rsrsai/dsh in my current DeepSeek Harness
profile. Read and follow https://github.com/risense-ai/respire-dsh#readme,
then perform the installation rather than only explaining the steps.

Check Node.js 24+, Harness compatibility (validated against 0.2.1-rc.2), and
plugin_manager availability. Reuse my existing rsrs environment; if rsrs is
missing, install it with npm install -g rsrs-cli@latest in the profile's
execution environment. Run rsrs --version and rsrs --client-only status --json.
Report any required login, library unlock, model setup, or host runtime action
for me to complete in rsrs; do not request secrets in chat or manage the runtime.

Inspect installed bundles first. If the old @rsrsai/respire-dsh bundle exists,
disable and remove that bundle through plugin management before installing its
replacement. If the manager requires a profile stop or restart, tell me the
required action before proceeding. Preserve my memory library, account, rsrs
configuration, and unrelated plugins. Avoid duplicate installation if the new
bundle is already present.

Use plugin_manager with {"action":"install_bundle","target":"@rsrsai/dsh"}.
Install the npm bundle, not a Git dependency or only a terminal npm install.
Verify that exactly one enabled respire-memory entry comes from @rsrsai/dsh.
Tell me when to restart Harness, then verify recall in a new conversation.
Ask me for a non-sensitive test fact before testing storage and check the actual
record. Verify the stop reminder in a separate recall turn without a successful
explicit store. Report the installed version, checks actually performed, and
remaining user actions; do not claim end-to-end success before observing it.
```

## Overview

Native TypeScript memory plugin for DeepSeek Harness. It registers stable rules
with `systemPrompt.section`, recalls memory through `agent/pre-step`, and checks
for new findings through `agent/turn-stopping` — at most once per request (a one-round bounded steer, no engine query at stop, skipped whenever this session never confirmed a working engine). Respire (`rsrs`) owns storage,
deduplication, encryption, model inference, accounts, and synchronization.

## Install

Requires Node.js 24+, DeepSeek Harness **0.2.1-rc.2**, and an installed `rsrs` CLI.
The plugin uses the Harness `agents`, `systemPrompt`, `subprocess`, and
`workingDirectory` services already provided by the standard desktop profile.
Other Harness versions have not been validated.

Install the engine separately if needed:

```sh
npm install -g rsrs-cli@latest
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
Use a versioned target such as `@rsrsai/dsh@0.1.3` to pin an installation.

`@rsrsai/cli` is the engine; `@rsrsai/dsh` is the Harness plugin. Running
`npm install @rsrsai/dsh` in a regular terminal does not activate the plugin in
a Harness profile. After installation, restart Harness and check that exactly
one enabled `respire-memory` entry comes from `@rsrsai/dsh`. npm installation
and module loading have been verified; a full desktop conversation has not.

### Migrate from the previous Git installation

If `@rsrsai/respire-dsh` is installed, remove that old bundle in Harness plugin
management, then install `@rsrsai/dsh` as above. Disable the old bundle first if
it is still in use; stop the profile if the manager requests it. Keep the existing
memory library, account, and `rsrs` configuration.

## Behavior

| Trigger | Result |
| --- | --- |
| First accepted user input per live agent | Read engine status; report missing runtime, locked library, missing session, or a small library when applicable |
| Accepted user message | `recall --titles --json`; inject at most 5 titles into the same model step |
| `记：`, `存：`, `记录：`, `记住：`, `remember:` | Attempt `remember` once, then inject a receipt per the result-state contract: `ok`/`warn` with a valid id are WRITTEN (warn carries engine warnings — never a failure, never re-sent, recognized on the production `--client-only` call path) and verified by a `show` read-back comparing the id, title, and full content (verified / mismatch / unavailable reported honestly); `ok`/`warn` without a valid id is UNKNOWN — verify read-only, never re-send; `fail` means the engine did not accept the write; `skip` and `pending` mean nothing was written (`pending` relays candidate ids plus engine-suggested actions, merge > attach > new); timeouts and unreadable receipts are unconfirmed — automatic retries forbidden |
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

The plugin icon is a single adaptive SVG: it shows the light variant by default
and switches to the dark variant when the Harness theme requests a dark color
scheme. The standalone light and dark variants live under `docs/`. The icon is
original artwork distributed under this repository's MIT license.
