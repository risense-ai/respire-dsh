# Changelog

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
