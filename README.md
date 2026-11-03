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

Check Node.js 24+, Harness compatibility (validated against 0.2.1-rc.5), and
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

After the installation is verified, offer to configure market-based updates:
enable Custom plugin markets in Harness, add the index source
https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json,
then confirm the Discover card reports the installed version. Do not install an
update without my confirmation.
```

## Overview

Native TypeScript memory plugin for DeepSeek Harness. It registers stable rules
with `systemPrompt.section`, recalls memory through `agent/pre-step`, and checks
for new findings through `agent/turn-stopping` — at most once per request (a one-round bounded steer, no engine query at stop, skipped whenever this session never confirmed a working engine). Respire (`rsrs`) owns storage,
deduplication, encryption, model inference, accounts, and synchronization.

## Install

Requires Node.js 24+, DeepSeek Harness **0.2.1-rc.5**, and an installed `rsrs` CLI.
The plugin uses the Harness `agents`, `systemPrompt`, `subprocess`, and
`workingDirectory`, and `tools` services already provided by the standard desktop profile.
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

## Updates through the plugin market

The npm registry remains the source of truth, but Harness can also discover,
install and update `@rsrsai/dsh` from a **plugin market index** published by
this repository (format 1, regenerated from npm by `scripts/market-index.mjs`
after every tagged release):

- `https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json`
- mirror, when GitHub is unreachable: `https://cdn.jsdelivr.net/gh/risense-ai/respire-dsh@market-index/marketplace.json`

The index is published on the dedicated `market-index` branch; the repository
protects `main` with a pull-request ruleset, so the release workflow cannot
commit there. It lists every published version that is neither a prerelease nor
deprecated, pins the npm registry, and uses a same-origin relative icon, so the
branch copy is self-contained. Harness validates the index before use and treats
its content as third-party content. The jsDelivr mirror is a third-party CDN and
may lag behind the raw URL; treat the raw URL as the reference.

The branch is a generated artifact: every refresh force-pushes a single commit,
so it carries no review history — review `scripts/market-index.mjs` and the npm
registry instead. Maintainers refresh it with the **Market index** workflow
(manual dispatch or weekly schedule) or a tagged release.

### Configure market-based updates

1. Open **Plugins** in Harness, choose **More** next to **Experimental plugins**,
   and enable **Custom plugin markets**. A **Discover** tab appears.
2. In **Discover**, choose **Add index source** and paste one of the URLs above.
3. The Respire card lists the published versions. When the newest compatible
   version is newer than the installed one, the card is marked **Update
   available**. Harness fetches the index when the page loads or is refreshed
   and caches it for ten minutes; it does not poll in the background.
4. To install, open the entry's version list and choose **Install**. Third-party
   entries have no one-click **Update** button: installing a new version removes
   the old bundle first, then installs the new one, so restart Harness when the
   manager reports completion. The running process keeps the old module until
   the restart.
5. Verify after the restart: the Plugins page or
   `dsh plugin --profile <profile> list` should show the new version, and the
   profile's `package.json` should pin it exactly.

To pin a version, run `dsh plugin --profile <profile> add @rsrsai/dsh@<version>
--save-exact` (the desktop profile requires the bundled CLI). To roll back, run
the same command with the previous version. If a bad version keeps Harness from
starting, quit Harness first — the desktop process holds the profile — run the
command from the bundled CLI, then restart. To withdraw a published version,
deprecate it with `npm deprecate @rsrsai/dsh@<version>`; the next index refresh
(the next tagged release, the **Market index** workflow, or
`node scripts/market-index.mjs` followed by `bash scripts/publish-market-index.sh`)
drops it from the list.

The plugin never updates itself and never changes the Harness profile on its
own. Harness plugin management performs installs and updates with a confirmation
dialog; the `dsh plugin` CLI only does what you run.

### Ask your agent to configure updates

Paste this into a Harness conversation when you want the assistant to configure
market-based updates and check for a newer version:

```text
Configure market-based updates for the Respire memory plugin @rsrsai/dsh.

1. Read the Harness version and profile name, and the installed @rsrsai/dsh
   version from the profile's package.json.
2. If custom plugin markets are off, enable them: Plugins → More (Experimental
   plugins) → Custom plugin markets.
3. Add the plugin market index source
   https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json
   Use https://cdn.jsdelivr.net/gh/risense-ai/respire-dsh@market-index/marketplace.json
   when raw.githubusercontent.com is unreachable.
4. Open Discover and confirm the Respire card loads and reports the installed
   version or Update available. Report the version list you see.
5. Do not install or change anything yet. Tell me the installed version, the
   newest compatible version, and the exact steps you would take. After I
   confirm, install that version (third-party entries remove the old bundle
   first), tell me to restart Harness, and verify the installed version after
   the restart.
```

## Behavior

| Trigger | Result |
| --- | --- |
| First accepted user input per live agent | Read engine status; report missing runtime, locked library, missing session, or a small library when applicable |
| Accepted user message | `recall --titles --json`; inject at most 5 titles into the same model step |
| `记：`, `存：`, `记录：`, `记住：`, `remember:` | Leave pending without writing; the main assistant completes policy and candidate review, then update > authorized merge > attach > new storage |
| `/nomem` or `#nomem` followed by whitespace/end | Skip that message's automatic recall; status and stop checks remain enabled |
| `$skill: name` prefix | Remove the skill selector from the recall query |
| Goal round (`source.kind === 'goal'`) | `goalRecall: 'first'` (default) recalls once per goal revision; `'every'` recalls on round 1 and every `goalRecallEvery` rounds; `'off'` keeps the previous human-only behavior. The query is the goal objective: the goal service when available, otherwise the `<goal_round>` Objective text |
| Goal round stop | `goalNudgeEvery: N` adds at most one wrap-up reminder per matching goal round; `0` (default) leaves goal rounds without extra model steps |
| Natural stop | At most one reminder per agent/turn; prefix pending leaves the reminder available; already-stored facts must not be written again |

Human messages (`source.kind === 'user'`) always trigger work. Automatic goal
rounds (`source.kind === 'goal'`) trigger recall only when `goalRecall` is enabled;
the `<goal_complete>` notice does not trigger recall or store. Plugin contexts,
tool loops, and reminder continuations do not trigger work. Repeated admission of
the same message ID in one turn is ignored. A new user message with identical
text is still processed. Downstream rejection and cancellation prevent new work.
A cancelled or timed-out write is **unconfirmed**, not automatically retried: it
may already have committed.

The hook leaves prefix requests pending without sending a write. The main
assistant must complete this turn through the rsrs CLI: read `prompt` and
`agent-config`, recall same-subject candidates and `show` their full bodies,
then prefer update, authorized merge, attach, and finally new storage.
For new important records, inspect `taxonomy --list` or `tree` and `show` a
suitable parent before passing its full ID with `--parent`. Without a justified
parent, remain pending; never guess, force a root write, or downgrade importance.
Save only the stated fact; do not execute tasks described in it. Read back actual
writes with `show`. If an actual write outcome is unknown, DO NOT retry automatically or claim
success. Verify the store read-only; verification does not authorize an automatic
retry. Hook pending does not block the first compliant write.

The stop reminder asks the agent to evaluate new facts; it does not automatically
archive an entire transcript or guarantee that the model will store a finding.

### Visible memory status

The plugin supplies native notice metadata for Harness to render a collapsible
row with a one-line summary. The validated rc.5 client consumes this metadata;
inserting context alone does not prove the row was rendered or seen by the user.

- `Memory: N found` counts the titles actually injected after validation,
  credential-pattern filtering, the threshold, the result limit, and the context budget. It is not the
  library's record count and does not mean the model adopted those candidates.
- `Memory: no match`, `Memory: skipped`, and `Memory: unavailable` distinguish
  an empty filtered result, skipped recall, and failed or invalid recall output.
- `Save: needs review` marks a prefix storage request. The hook has made no
  write request, including when the fact is empty or needs credential removal.

For ordinary prose, the model is instructed to repeat the current short status
in its first visible reply. It may report `Used:` only after reading a record's
body and actually using it. Each real short ID carries `[basis]`, `[ref]`, or
`[history]` and a real title shortened to at most 24 Unicode characters. Use a
longer ID prefix when needed to disambiguate; empty or sensitive titles use
`(untitled)` or `(title hidden)`. Bodies and full IDs are not displayed by default.

`[ref]` is the default. `[basis]` requires a verified source that holds in the
current scope; `[history]` is only for outdated, superseded, or conflicting
material used as historical context. An agreement proves the agreement, not its
execution. A high score, importance, a body's claim of verification, or a save
and readback cannot alone establish credibility. Mixed records use the most
conservative role for the part actually used. `Used:` is the model's account,
not independent adoption measurement. Without adoption, ordinary prose ends
with `Memory: unused` and omits `Used:`.

Strict JSON, fixed-format, and exact-output requests suppress all these labels
in the response body. The independent native notice can still appear in the UI.
Status reporting does not add a reply or a stop continuation. The plugin does
not track save receipts, so it supplies no `Last save`, `Earlier save`, or
`verified` save label. The existing mandatory storage and readback rules remain
in force.

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
    goalRecall: first
    goalRecallEvery: 1
    goalNudgeEvery: 0
    timeoutMs: 20000
```

`rsrsPath` is an executable name or absolute path, not a shell command.
`storeNudgeEvery: 0` disables reminders; `N` checks every N user-bearing turns per
live agent. `goalRecall` accepts `off`, `first` (default), or `every`: `first`
recalls once per goal revision and dedupes by `goalId:revision`; `every` recalls on
round 1 and every `goalRecallEvery` rounds. `goalNudgeEvery` is a separate
goal-round wrap-up cadence; `0` (default) adds no extra model step. `/goal` itself
is a UI command and never enters a model request; the first automatic goal round
is what triggers the goal recall. Changing profiles or reloading the plugin resets
volatile reminder state. Recall has a strict character budget; storage receipts
are kept intact.

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
Harness 0.2.1-rc.5 API. `package-lock.json` locks the verification dependencies.

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

## Before-tool memory write checks

The extension checks recognized literal rsrs writes before tool execution. It
blocks important remember calls with missing or empty parents and all force calls.
Every merge-ids request also needs an explicit parent, even when importance says
trivial, because a merge can inherit importance. A nonempty literal parent
ID must resolve through read-only `rsrs --client-only show <id> --json`; failure,
cancellation or timeout blocks the shell call and leaves placement pending. This
check uses the configured executable and never starts a runtime. Parent checks
have a five-second deadline, leaving time for tool feedback and cleanup.

Before update --importance important, the gate reads the target and verifies its
current parent_id with a second show. An orphan or invalid/missing parent blocks
the update; attach the record under a real parent first. Current rsrs update does
not expose parent-changing flags; the gate rejects those unsupported options,
without claiming they could otherwise perform a parent change.

Known memory_remember and memory_update tool basenames, including server-qualified
MCP names, are blocked because their target library cannot be bound to this CLI.
Use an explicit command through the guarded CLI tools instead; no automatic
retry of an earlier unknown write is permitted. Other tool names pass unchanged.
Opaque hashed or truncated MCP tool names cannot be mapped to raw basenames by this check.

Known shell -c/-Command code arguments and active command substitutions are
inspected only to recognize writes and deny the enclosing call. Simple leading
NAME=value assignments cannot hide a recognized write. Ordinary quoted text
without expansion remains text. Bash and PowerShell escaping are distinguished;
terminal_send uses conservative checks because its persistent shell is unknown.
No shell code is evaluated by this check.

Known read commands and unrelated tools pass unchanged. Current remember/update
metadata flags remain supported. Recognized writes in compound commands, command
substitutions, wrappers or dynamic arguments are denied: use one explicit command
with literal arguments. A `--parent` phrase inside the memory body is not an option.
This is a targeted check, not a shell sandbox: arbitrary scripts, aliases, hidden
executables and terminal fragments are outside its coverage. It does not grant
permissions, choose a parent, write a record, or authorize an automatic retry. The
model MUST still read policy and candidate bodies, justify placement, respect
read-only/off modes, and verify actual writes. Unknown issued writes MUST NOT be
retried automatically or reported as successful.

Coverage: Harness `bash`, `pwsh`, and `terminal_send` text, including nested calls.
The asynchronous pre-execute check is followed by a synchronous monotonic guard;
a later allow decision cannot erase a denial or reuse validation for changed arguments.
Harness must provide `tools.guard()` (validated with 0.2.1-rc.5); an incompatible
host fails plugin initialization rather than silently disabling enforcement.
Setting `enabled: false` disables this integration and its gate together.

Checks cover arguments observed at this gate. Extensions that replace arguments
after the guard or execute outside the host tool pipeline are outside this scope.
The CLI/Core must enforce the parent invariant atomically at the actual write.
