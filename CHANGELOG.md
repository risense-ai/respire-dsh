# Changelog

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
