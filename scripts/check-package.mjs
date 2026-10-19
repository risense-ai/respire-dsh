import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }))
const files = new Set(packed.files.map(file => file.path))
for (const path of ['lib/index.js', 'lib/index.d.ts', 'lib/memory.js', 'lib/rsrs.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'LICENSE', 'README.md']) {
  assert.ok(files.has(path), `Missing distribution file: ${path}`)
}
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
for (const path of files) assert.doesNotMatch(path, /^(?:test|tools|docs|node_modules|\.github|\.serena)\//)
for (const locale of ['en', 'zh']) {
  const { meta } = JSON.parse(readFileSync(`locale/${locale}.json`, 'utf8'))
  assert.ok(meta.title && meta.description)
}
const icon = readFileSync('icon.svg', 'utf8')
assert.match(icon, /<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/)
assert.ok(Buffer.byteLength(icon) < 256 * 1024)
console.log(`Verified ${packed.filename}: ${files.size} files, no development fixtures.`)
