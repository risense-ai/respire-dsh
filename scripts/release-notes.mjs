// Generate complete GitHub release notes for @rsrsai/dsh.
//
// Structure: version/channel, baseline, CHANGELOG highlights, Features/Fixes/
// Other changes itemized by commit, the complete commit table, changed files,
// full comparison, pinned install commands, and source/validation links.
//
// Usage: node scripts/release-notes.mjs > release-notes.md
// The release workflow runs this at the tag commit with full history.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = pkg.version
const prerelease = version.includes('-')
const channel = prerelease ? 'next (prerelease)' : 'latest (stable)'
const repo = process.env.GITHUB_REPOSITORY || 'risense-ai/respire-dsh'
const server = process.env.GITHUB_SERVER_URL || 'https://github.com'
const tag = `v${version}`

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const tryGit = (...args) => {
  try { return git(...args) } catch { return '' }
}

// The previous stable tag reachable from the tag commit's parent. Prereleases
// baseline against the last stable release, not another prerelease.
const tags = tryGit('tag', '--merged', 'HEAD^', '--sort=-v:refname').split('\n').filter(Boolean)
const base = tags.find(candidate => /^v\d+\.\d+\.\d+$/.test(candidate)) ?? ''
const baseHash = base ? tryGit('rev-parse', '--short', base) : ''
const headHash = tryGit('rev-parse', '--short', 'HEAD')
const range = base ? `${base}..HEAD` : 'HEAD'

const commits = tryGit('log', '--format=%H%x09%h%x09%an%x09%s', range)
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const [hash, short, author, ...rest] = line.split('\t')
    return { hash, short, author, title: rest.join('\t') }
  })

const stat = base
  ? tryGit('diff', '--stat', `${base}..HEAD`)
  : tryGit('show', '--stat', '--format=', 'HEAD')
const status = base ? tryGit('diff', '--name-status', `${base}..HEAD`) : ''
const statusRows = status.split('\n').filter(Boolean).map(line => {
  const [code, ...paths] = line.split('\t')
  const label = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied' }[code[0]] ?? code
  return `| ${label} | ${paths.join(' → ')} |`
})

const changelog = readFileSync('CHANGELOG.md', 'utf8').split('\n')
const start = changelog.findIndex(line => line.trim() === `## ${version}`)
const end = start < 0 ? -1 : changelog.findIndex((line, index) => index > start && /^## /.test(line))
const section = start < 0 ? [] : changelog.slice(start + 1, end < 0 ? undefined : end)
const highlights = section.map(line => line.trim()).filter(line => line && !line.startsWith('#'))

const groups = { Features: [], Fixes: [], 'Other changes': [] }
for (const commit of commits) {
  const title = commit.title.toLowerCase()
  const key = title.startsWith('feat') ? 'Features' : title.startsWith('fix') ? 'Fixes' : 'Other changes'
  groups[key].push(commit)
}
const prs = [...new Set(commits.flatMap(commit =>
  [...commit.title.matchAll(/\(#(\d+)\)/g)].map(match => `#${match[1]}`)))]

const commitLink = hash => `${server}/${repo}/commit/${hash}`
const lines = []
lines.push(`# ${version} — ${new Date().toISOString().slice(0, 10)}`, '')
lines.push(`**Channel:** \`${channel}\`  `)
lines.push(`**Baseline:** ${base ? `\`${base}\` (\`${baseHash}\`)` : 'initial release'}  `)
lines.push(`**Tag:** \`${tag}\` (\`${headHash}\`)  `)
if (prs.length) lines.push(`**PRs:** ${prs.join(', ')}  `)
lines.push(`**Full comparison:** ${server}/${repo}/compare/${base || 'HEAD'}...${tag}`, '')
lines.push('## Changes', '')
lines.push(...(highlights.length ? highlights : ['See the commit list and changed files below.']), '')
for (const name of ['Features', 'Fixes', 'Other changes']) {
  lines.push(`## ${name}`, '')
  if (groups[name].length === 0) {
    lines.push('- None.', '')
    continue
  }
  for (const commit of groups[name]) {
    lines.push(`- [\`${commit.short}\`](${commitLink(commit.hash)}) ${commit.title} — ${commit.author}`)
  }
  lines.push('')
}
lines.push('## Commits', '', '| Commit | Title | Author |', '| --- | --- | --- |')
for (const commit of commits) {
  lines.push(`| [\`${commit.short}\`](${commitLink(commit.hash)}) | ${commit.title.replace(/\|/g, '\\|')} | ${commit.author} |`)
}
if (commits.length === 0) lines.push('| — | No commits in this range | — |')
lines.push('', '## Changed files', '')
if (statusRows.length > 0) {
  lines.push('| Status | File |', '| --- | --- |', ...statusRows, '')
}
lines.push('```text', stat || 'No file changes in this range.', '```', '')
lines.push('## Install / upgrade', '')
lines.push('Pin this exact version:', '')
lines.push('```sh', `dsh plugin --profile <profile> add @rsrsai/dsh@${version} --save-exact`, '```', '')
lines.push('Or through `plugin_manager`:', '')
lines.push('```json', `{"action":"install_bundle","target":"@rsrsai/dsh@${version}"}`, '```', '')
lines.push('Restart Harness after replacing the bundle. `npm install -g @rsrsai/dsh` alone does not activate the plugin in a profile.', '')
lines.push('## Source and validation', '')
lines.push(`- Tag \`${tag}\`${process.env.GITHUB_SHA ? ` at \`${process.env.GITHUB_SHA}\`` : ''}.`)
if (process.env.GITHUB_RUN_ID) {
  lines.push(`- Workflow run: ${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`)
}
lines.push('- `npm run check`, `npm run build`, `npm test`, `npm run verify:package`.', '')
lines.push('## Notes', '')
lines.push('- Generated from the CHANGELOG, the complete commit range, and the changed-file list. Review behavior/configuration changes before publishing.')

process.stdout.write(`${lines.join('\n')}\n`)
