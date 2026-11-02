#!/usr/bin/env bash
# Publish the generated marketplace.json to the dedicated market-index branch.
#
# Users read https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json
# so the index is kept off `main`: main is protected by a pull-request ruleset
# that a bot push cannot satisfy. The branch holds a single generated commit and
# is force-pushed on every refresh.
#
# Used by .github/workflows/release.yml (after a tagged publish) and by
# .github/workflows/market-index.yml (manual or scheduled refresh).
# Expects marketplace.json to be generated already by scripts/market-index.mjs.

set -euo pipefail

version=$(node -p "require('./package.json').version")
staging=$(mktemp -d)
cp marketplace.json icon.svg "$staging/"

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

# Skip the push when the published copy already matches the regenerated one.
if git fetch --no-tags origin market-index 2>/dev/null \
  && git show origin/market-index:marketplace.json 2>/dev/null | cmp -s - marketplace.json; then
  echo "index already current for ${version}"
  exit 0
fi

git checkout --orphan market-index-publish
git rm -rf .
cp "$staging/marketplace.json" "$staging/icon.svg" .
cat > README.md <<'EOF'
# Plugin market index

Generated from the npm registry by `scripts/market-index.mjs` for `@rsrsai/dsh`.
Do not edit this branch by hand: the release workflow force-pushes it after every
tagged publish, and maintainers can refresh it with the `Market index` workflow.
EOF
git add marketplace.json icon.svg README.md
git commit -m "chore: refresh plugin market index for ${version}"

for attempt in 1 2 3; do
  if git push --force origin HEAD:refs/heads/market-index; then
    exit 0
  fi
  sleep 5
done
exit 1
