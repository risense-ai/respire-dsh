# Release notes

Every tag `v<version>` must carry a committed `release-notes/v<version>.md`
before it is pushed. The release workflow fails before `npm publish` when that
file is missing or empty, so a release can never publish with an auto-generated
one-line summary.

Generate a draft from the CHANGELOG, the complete commit range and the changed
files:

```sh
node scripts/release-notes.mjs > release-notes/v0.1.14.md
```

Then edit the draft before tagging. Required structure:

- version, channel, baseline tag and commit
- `Features` / `Fixes` / `Other changes`, each with commit links
- a complete `Commits` table covering every commit in the baseline range,
  including merges, docs, CI and version bumps
- changed files and the full comparison
- pinned install command
- source and validation (tag, workflow run, tests)
- notes and limitations

Do not replace the complete GitHub release body with a chat summary. Fixing a
published release's notes edits the GitHub release body only; do not republish
binaries.
