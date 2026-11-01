import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runRsrs } from '../lib/rsrs.js'

function provider({ platform = 'posix', output = '{"status":"ok"}', exitCode = 0, lossy = false, hang = false } = {}) {
  const specs = []
  let terminated = false
  return {
    specs,
    get terminated() { return terminated },
    terminalEnvironment: async () => ({ platform }),
    resolveExecutable: async command => command,
    spawn: spec => {
      specs.push(spec)
      return {
        done: hang ? new Promise((_, reject) => spec.signal.addEventListener('abort', () => reject(spec.signal.reason), { once: true }))
          : Promise.resolve({ exitCode, signal: null }),
        collected: { stdout: { readFrom: () => ({ text: output, lossy }) } },
        terminate: () => { terminated = true },
        waitForExit: async () => true,
      }
    },
  }
}

test('POSIX arguments are passed verbatim without shell interpretation', async () => {
  const p = provider()
  const args = ['--client-only', 'recall', '中文 "quoted" $(echo unsafe); & x', '--json']
  await runRsrs(p, '/path with spaces/rsrs', args, process.cwd(), new AbortController().signal, 1000)
  assert.deepEqual(p.specs[0].argv, ['/path with spaces/rsrs', ...args])
  assert.equal(p.terminated, true)
})

test('Windows user text travels as JSON stdin, not executable source', async () => {
  const p = provider({ platform: 'windows' })
  const args = ['recall', '中文 & | $(Write-Output unsafe) "quotes"\nnext', '--json']
  await runRsrs(p, 'C:\\path with spaces\\rsrs.ps1', args, process.cwd(), new AbortController().signal, 1000)
  const spec = p.specs[0]
  assert.equal(spec.argv[0], 'powershell.exe')
  assert.deepEqual(JSON.parse(spec.stdio.stdin.data).args, args)
  const script = Buffer.from(spec.argv.at(-1), 'base64').toString('utf16le')
  assert.doesNotMatch(script, /Write-Output unsafe/)
})

test('malformed, truncated, failed, and pending CLI output are distinguished', async () => {
  for (const option of [{ output: 'not-json' }, { lossy: true }, { output: '[]' }, { exitCode: 1 }]) {
    await assert.rejects(runRsrs(provider(option), 'rsrs', [], process.cwd(), new AbortController().signal, 1000), /invalid-output|failed/)
  }
  assert.equal((await runRsrs(provider({ output: '{"status":"pending"}', exitCode: 1 }), 'rsrs', [], process.cwd(), new AbortController().signal, 1000)).status, 'pending')
})

test('production --client-only remember warn (exit 2) is a receipt, not a failure', async () => {
  const output = '{"status":"warn","summary":{"id":"33333333-3333-4333-8333-333333333333"},"errors":["parent (cause) cannot be resolved; stored independently"]}'
  const args = ['--client-only', 'remember', '项目采用 TypeScript', '--title', '项目采用 TypeScript', '--importance', 'important', '--json']
  const doc = await runRsrs(provider({ output, exitCode: 2 }), 'rsrs', args, process.cwd(), new AbortController().signal, 1000)
  assert.equal(doc.status, 'warn')
  assert.equal(doc.summary.id, '33333333-3333-4333-8333-333333333333')
  // the allowance is scoped to remember: warn on any other subcommand still fails
  await assert.rejects(runRsrs(provider({ output, exitCode: 2 }), 'rsrs', ['--client-only', 'recall', 'query', '--json'], process.cwd(), new AbortController().signal, 1000), /failed/)
})

test('deadline and user cancellation terminate the managed command', async () => {
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const p = provider({ hang: true })
    await assert.rejects(runRsrs(p, 'rsrs', [], process.cwd(), new AbortController().signal, 10), /timeout/)
    assert.equal(p.terminated, true)
    const cancelled = new AbortController()
    cancelled.abort()
    const q = provider()
    await assert.rejects(runRsrs(q, 'rsrs', [], process.cwd(), cancelled.signal, 1000), /cancelled/)
    assert.equal(q.specs.length, 0)
  } finally {
    clearTimeout(keepAlive)
  }
})
