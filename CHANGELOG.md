# Changelog

## 0.1.12

- Publish a DeepSeek Harness plugin market index (`marketplace.json`, format 1) on the dedicated `market-index` branch, generated from the npm registry by `scripts/market-index.mjs`, so the Discover tab can list and install every published, non-deprecated `@rsrsai/dsh` version. The release workflow refreshes that branch after each tagged publish; a `Market index` workflow provides a manual and weekly refresh, and `npm run market:check` compares the published index with the registry.
- Skip prereleases and deprecated versions, pin entries to the npmjs registry, sort versions newest-first, and use a same-origin relative icon so the branch copy is self-contained.
- Document how to enable custom plugin markets, add the index source, verify, install and restart, plus pin, rollback and withdrawal steps, with an agent-facing configuration prompt in both READMEs.

## 0.1.11

- Exclude credential-like candidate titles before rendering, budgeting or counting them, using the existing credential filter.
- Supply native Harness notice summaries for actual injected candidate counts, no match, skipped/unavailable recall, and prefix requests needing review.
- Request short prose status and body-read adoption labels with explicit source-trust roles; preserve strict JSON/fixed-output exceptions and keep native notices independent.
- Keep prefix storage pending, save/readback requirements and parent guards unchanged; do not infer save receipts or add status-only continuations.

## 0.1.10

- Reject recognized writes inside known shell code arguments, command substitutions and environment-assignment prefixes; preserve literal quoted text and normal reads.
- Block visible memory_remember/memory_update MCP basenames when their target library cannot be verified; verify importance options before the update target in existing assertions.
- Block recognized unsafe rsrs writes before shell execution: important remember requires a literal parent, force and unsupported parent-changing options are denied, and explicit parents must exist.
- Recognize redirections before the executable and between executable/subcommand; require explicit parents for every merge and verify an existing target parent before important updates.
- Verify parents through bounded read-only --client-only show calls; failures and timeouts leave storage pending without dispatching the shell.
- Keep read commands, unrelated tools, prefix zero-write handoff and unknown-write no-retry rules unchanged. Compound or dynamic recognized writes require one literal command; scripts and aliases are not a universal enforcement boundary.


## 0.1.9

- Preserve mandatory candidate, parent and read-back requirements with explicit MUST/ONLY AFTER language.
- Forbid automatic retries and success claims after unknown writes; read-only verification does not authorize a retry.

## 0.1.8

- Delegate explicit prefix storage to the main assistant without an unchecked write.
- Require policy, full candidate review and a justified parent before new important storage; keep pending distinct from unknown actual writes.

## 0.1.7

- Record ids are now validated against the engine's actual formats — a UUID or a
  long hex string — instead of any 8+ character mix of hex and dashes. A receipt
  whose id is dashes-only (`"--------"`), wrongly grouped, or a path fragment is
  an **unknown** outcome (verify read-only, never retry), never a write
  credential; the same whitelist filters recall hits.
- The post-store read-back now checks the returned entry itself, not just the
  envelope: `details.entry.id` must equal the written id, and `title`/`content`
  must be strings with the content matching after trimming. A correct
  `summary.id` with a missing or different `entry.id`, or a content that is an
  array/number/object (even when its string coercion equals the sent text),
  reports a mismatch — the Saved receipt is kept, nothing is rewritten, and the
  read-back stays read-only.

## 0.1.6

- The written-with-warnings path is now reachable in production: `remember` warn
  receipts (exit 2, `status:"warn"` after the write committed) are recognized
  regardless of the `--client-only` argument wrapper the plugin prepends, so the
  full chain — warn receipt, `show` read-back, stop-reminder suppression — works
  with the exact arguments sent to the CLI.
- The post-store read-back now verifies the full record: the returned id, the
  title, and the complete content must all match. A wrong id or an identical
  40-character prefix with a tampered tail reports a mismatch; only a failed or
  malformed `show` reports unavailable, and the receipt wording states exactly
  what was checked.
- `ok`/`warn` receipts without a valid record id are reported as **unknown** —
  verify read-only, never re-send — instead of "store failed". Only an explicit
  `fail` receipt states the engine did not accept the write; `skip` reports
  nothing was written.

## 0.1.5

- Quick-store result-state contract: written-with-warnings receipts, `pending`
  relay of engine-suggested actions (merge > attach > new), and a post-store
  `show` read-back with honest verified / mismatch / unavailable wording.
