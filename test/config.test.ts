import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { resolveConfig, shouldRecallGoal } from '../lib/index.js'

// Offline coverage for the three previously unverified items (U1/U2/U3):
// ① the cordis.patch.yml respire-memory row expands through apply()'s config path
//    (resolveConfig is the exact assembly+validation apply calls) over the shipped
//    defaults 20000 / first / 1;
// ② the goalRecall: every gate and the 120000 / 1000 bounds;
// ③ the real profile file readback (committed copy as the CI fallback).

const ENTRY = { timeoutMs: 60000, goalRecall: 'every', goalRecallEvery: 2 }

const REAL_PATH = `${process.env.HOME}/.dsh/profiles/web/cordis.patch.yml`
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/cordis.patch.yml', import.meta.url))

// Targeted extraction for this fixed-shape row: the `- id: respire-memory` line,
// then the `key: value` pairs under its `config:` block until the next row entry.
// No YAML dependency: the package is not declared by this repo.
function readRespireMemoryEntry(file: string): Record<string, string | number> {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex(line => /^-\s+id:\s*respire-memory\s*$/.test(line))
  assert.notEqual(start, -1, `respire-memory entry not found in ${file}`)
  const config: Record<string, string | number> = {}
  let inConfig = false
  for (const line of lines.slice(start + 1)) {
    if (/^-\s/.test(line)) break
    if (/^\s+config:\s*$/.test(line)) { inConfig = true; continue }
    if (!inConfig) continue
    const pair = /^\s+([A-Za-z][A-Za-z0-9]*):\s*(\S+)\s*$/.exec(line)
    if (!pair) { if (/^\S/.test(line)) break; continue }
    const raw = pair[2]!.replace(/^['"]|['"]$/g, '')
    config[pair[1]!] = /^-?\d+$/.test(raw) ? Number(raw) : raw
  }
  return config
}

test('① entry config overrides defaults through resolveConfig (the path apply uses)', () => {
  const defaults = resolveConfig()
  assert.equal(defaults.timeoutMs, 20000, 'shipped default timeoutMs')
  assert.equal(defaults.goalRecall, 'first', 'shipped default goalRecall')
  assert.equal(defaults.goalRecallEvery, 1, 'shipped default goalRecallEvery')

  const configured = resolveConfig(ENTRY)
  assert.equal(configured.timeoutMs, 60000)
  assert.equal(configured.goalRecall, 'every')
  assert.equal(configured.goalRecallEvery, 2)
  // fields the row does not mention keep their defaults
  assert.equal(configured.rsrsPath, 'rsrs')
  assert.equal(configured.recallLimit, 5)
  assert.equal(configured.recallThreshold, 0)
  assert.equal(configured.budgetChars, 1500)
  assert.equal(configured.minPromptChars, 2)
  assert.equal(configured.storeNudgeEvery, 1)
  assert.equal(configured.goalNudgeEvery, 0)
  assert.equal(configured.enabled, true)
})

test('② bounds: timeoutMs <= 120000 and goalRecallEvery <= 1000 are enforced', () => {
  assert.doesNotThrow(() => resolveConfig({ timeoutMs: 120000, goalRecallEvery: 1000 }))
  assert.throws(() => resolveConfig({ timeoutMs: 120001 }), /invalid timeoutMs/)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /invalid timeoutMs/)
  assert.throws(() => resolveConfig({ timeoutMs: 1.5 }), /invalid timeoutMs/)
  assert.throws(() => resolveConfig({ goalRecallEvery: 1001 }), /invalid goalRecallEvery/)
  assert.throws(() => resolveConfig({ goalRecallEvery: 0 }), /invalid goalRecallEvery/)
  assert.throws(() => resolveConfig({ goalRecall: 'sometimes' as never }), /invalid goalRecall/)
})

test('② shouldRecallGoal every gate: round 1 recalls, %2===0 rounds recall, round 3 does not', () => {
  const state = { checked: false, ready: false, rounds: 0 } as never
  const source = (round: number) => ({ kind: 'goal' as const, goalId: 'goal-1', revision: 1, round })
  // README: "'every' recalls on round 1 and every goalRecallEvery rounds"
  assert.equal(shouldRecallGoal(state, source(1), 'every', 2), true, 'round 1 always recalls')
  assert.equal(shouldRecallGoal(state, source(2), 'every', 2), true, 'round 2: 2 % 2 === 0')
  assert.equal(shouldRecallGoal(state, source(3), 'every', 2), false, 'round 3 is skipped')
  assert.equal(shouldRecallGoal(state, source(4), 'every', 2), true, 'round 4: 4 % 2 === 0')
  // first: once per goal revision
  assert.equal(shouldRecallGoal({ goalKey: undefined } as never, source(1), 'first', 2), true)
  assert.equal(shouldRecallGoal({ goalKey: 'goal-1:1' } as never, source(1), 'first', 2), false)
  assert.equal(shouldRecallGoal({ goalKey: undefined } as never, source(3), 'first', 2), true)
  // off: never
  assert.equal(shouldRecallGoal({ goalKey: undefined } as never, source(1), 'off', 2), false)
})

test('③ real cordis.patch.yml readback matches the entry values apply receives', () => {
  const useReal = existsSync(REAL_PATH)
  const file = useReal ? REAL_PATH : FIXTURE_PATH
  assert.ok(useReal || existsSync(FIXTURE_PATH), 'neither the profile file nor its committed copy exists')
  const entry = readRespireMemoryEntry(file)
  assert.equal(entry.timeoutMs, 60000, `${file}: timeoutMs`)
  assert.equal(entry.goalRecall, 'every', `${file}: goalRecall`)
  assert.equal(entry.goalRecallEvery, 2, `${file}: goalRecallEvery`)

  const configured = resolveConfig(entry as never)
  assert.equal(configured.timeoutMs, 60000)
  assert.equal(configured.goalRecall, 'every')
  assert.equal(configured.goalRecallEvery, 2)
})
