import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runRsrs } from '../lib/rsrs.js'

// A real OS process verifies the adapter's quoting/encoding independently of the
// controlled service used by the event tests. It does not open a memory library.
test('real process preserves Unicode, spaces, quotes, newlines, and shell metacharacters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'respire cli '))
  const windows = process.platform === 'win32'
  const executable = join(directory, windows ? 'mock rsrs.ps1' : 'mock rsrs')
  try {
    await writeFile(executable, windows
      ? '[Console]::Out.Write((@{status="ok"; details=@($args)} | ConvertTo-Json -Compress))'
      : '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({status:"ok",details:process.argv.slice(2)}))\n', 'utf8')
    if (!windows) await chmod(executable, 0o755)
    const subprocess = {
      terminalEnvironment: async () => ({ platform: windows ? 'windows' : 'posix' }),
      resolveExecutable: async command => command,
      spawn: spec => {
        const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true, signal: spec.signal, stdio: 'pipe' })
        let output = ''
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
        child.stderr.resume()
        const done = new Promise((resolve, reject) => {
          child.on('error', reject)
          child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
        })
        child.stdin.end(typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined)
        return { done, collected: { stdout: { readFrom: () => ({ text: output, lossy: false }) } }, terminate: () => child.kill(), waitForExit: async () => { await done; return true } }
      },
    }
    const args = ['--client-only', 'recall', '中文 "引号" & | $(echo unsafe)\n下一行', '--json']
    const result = await runRsrs(subprocess, executable, args, directory, new AbortController().signal, 10000)
    assert.deepEqual(result.details, args)
  } finally {
    await rm(directory, { recursive: true })
  }
})
