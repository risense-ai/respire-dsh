// Generate the DeepSeek Harness plugin market index (format 1) for @rsrsai/dsh.
//
// The index lists every published npm version, so the Harness "Discover" tab can
// list, install and update the plugin from a single URL:
//   https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json
//
// It is published on the dedicated `market-index` branch rather than on `main`:
// the repository protects `main` with a ruleset that requires pull requests and
// passing CI, which a bot push cannot satisfy. The release workflow regenerates
// the index after every tagged publish and force-pushes it to that branch.
//
// Validation rules come from @deepseek-ai/dsh-plugin-market-index (format 1):
//   - `format` must be the number 1.
//   - `version` is an exact SemVer 2.0.0 version; `publishTimestamp` an integer
//     count of Unix seconds in [0, 10^11).
//   - `source` is `{ type: "npm", registry?: url }` or a commit-pinned `git`
//     source; this index publishes npm sources only, pinned to the npm registry.
//   - `engines.dsh` is a SemVer range; Harness refuses to install versions whose
//     range does not accept the running Harness.
//   - `icon` is an https URL or a reference resolved against the index URL; this
//     index uses a relative path so the branch copy is self-contained.
//
// Deprecated versions and prereleases are skipped: Harness already refuses
// prereleases for its default version, and listing a deprecated version only
// invites failed installs.
//
// Usage:
//   node scripts/market-index.mjs          # write marketplace.json for the release job
//   node scripts/market-index.mjs --check  # compare the registry with the published index

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const MANIFEST = JSON.parse(readFileSync('package.json', 'utf8'))
const REPO = 'https://github.com/risense-ai/respire-dsh'
const RAW_MAIN = 'https://raw.githubusercontent.com/risense-ai/respire-dsh/main'
const RAW_INDEX = 'https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index'
const PUBLISHED_URL = `${RAW_INDEX}/marketplace.json`
const REGISTRY = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 15000

function compareSemver(a, b) {
  const left = a.split('-')[0].split('.').map(Number)
  const right = b.split('-')[0].split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

async function fetchText(url, accept) {
  const response = await fetch(url, {
    headers: accept ? { accept } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text()
}

const manifest = JSON.parse(await fetchText(`${REGISTRY}/${encodeURIComponent(MANIFEST.name).replace(/^%40/, '@')}`, 'application/json'))
const published = Object.entries(manifest.time)
  .filter(([version, time]) => version !== 'created' && version !== 'modified')
  // The format requires an integer number of Unix seconds; registry times carry milliseconds.
  .map(([version, time]) => ({ version, time: Math.floor(Date.parse(time) / 1000) }))

const versions = []
const skipped = []
for (const { version, time } of published) {
  const entry = manifest.versions[version]
  assert.ok(entry, `registry manifest lacks metadata for ${version}`)
  if (version === '0.0.0-stage') continue
  if (version.includes('-')) {
    skipped.push(`${version} (prerelease)`)
    continue
  }
  if (entry.deprecated) {
    skipped.push(`${version} (deprecated)`)
    continue
  }
  const engines = entry.engines ?? {}
  assert.ok(engines.dsh, `${version} declares no engines.dsh; refusing to publish it as installable`)
  versions.push({
    version,
    publishTimestamp: time,
    source: { type: 'npm', registry: REGISTRY },
    engines: { dsh: engines.dsh },
  })
}
assert.ok(versions.length > 0, 'no installable versions found in the registry')
versions.sort((left, right) => compareSemver(right.version, left.version))

const index = {
  format: 1,
  title: { en: 'Respire', zh: 'Respire' },
  description: {
    en: 'Respire memory plugins for DeepSeek Harness, published by risense-ai.',
    zh: 'risense-ai 发布的 DeepSeek Harness 记忆插件。',
  },
  metadata: {
    categories: {
      memory: { title: { en: 'Memory', zh: '记忆' } },
    },
  },
  plugins: [
    {
      name: MANIFEST.name,
      title: { en: 'Respire Memory', zh: 'Respire 记忆' },
      description: {
        en: 'Local-first encrypted memory: recalls titles before each answer, stores explicit facts (记： prefix), and checks for unsaved findings before stopping. Requires the rsrs CLI engine.',
        zh: '本地优先的端侧加密记忆：回答前自动召回标题、「记：」一前缀即落库、收尾检查未存结论。需要 rsrs CLI 引擎。',
      },
      icon: './icon.svg',
      author: MANIFEST.author,
      homepage: `${REPO}#readme`,
      repository: {
        url: `${REPO}.git`,
      },
      metadata: {
        category: 'memory',
        keywords: ['memory', 'respire', 'rsrs', 'recall', '记忆', '召回', '落库'],
      },
      versions,
    },
  ],
}

const body = `${JSON.stringify(index, null, 2)}\n`
const summary = `${versions.length} versions${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`

if (process.argv.includes('--check')) {
  // Compare with the published copy so a fresh clone needs no generated file and a
  // broken release job is visible: the registry moved ahead of the published branch.
  const remote = await fetchText(PUBLISHED_URL)
  assert.equal(remote, body, `the published index at ${PUBLISHED_URL} is stale — the release workflow refreshes it after each tagged publish`)
  console.log(`published index matches the registry: ${summary}`)
} else {
  writeFileSync('marketplace.json', body)
  console.log(`Wrote marketplace.json: ${summary}`)
  console.log(`Publish URL: ${PUBLISHED_URL} (the release workflow force-pushes this file to the market-index branch)`)
}
