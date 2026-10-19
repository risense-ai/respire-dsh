import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'Tag must match package.json version')
const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json'], { encoding: 'utf8' }))
const hash = createHash('sha256').update(readFileSync(packed.filename)).digest('hex')
writeFileSync('SHA256SUMS', `${hash}  ${packed.filename}\n`, 'utf8')
console.log(`Release package: ${packed.filename}`)
