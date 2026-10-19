import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface Envelope {
  status: string
  summary?: Record<string, unknown>
  details?: unknown
  items?: unknown[]
}

export class RsrsError extends Error {
  constructor(readonly code: 'unavailable' | 'timeout' | 'cancelled' | 'failed' | 'invalid-output') {
    super(`rsrs: ${code}`)
  }
}

// Arguments travel as JSON on stdin, never as PowerShell source or cmd.exe syntax.
const WINDOWS_RUNNER = Buffer.from([
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [Console]::OutputEncoding',
  '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$cliArgs = @($request.args)',
  '& $request.file @cliArgs',
  'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
].join('\n'), 'utf16le').toString('base64')

export async function runRsrs(
  subprocess: SubprocessRuntime,
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Envelope> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, deadline])
  let handle
  try {
    const environment = await subprocess.terminalEnvironment(combined)
    const windows = environment.platform === 'windows'
    const program = await subprocess.resolveExecutable(windows ? 'powershell.exe' : executable, undefined, combined)
    combined.throwIfAborted()
    handle = subprocess.spawn({
      argv: windows
        ? [program, '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_RUNNER]
        : [program, ...args],
      cwd,
      stdio: {
        stdin: windows ? { data: JSON.stringify({ file: executable, args }) } : 'ignore',
        stdout: { maxBytes: 1024 * 1024 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 1000,
      signal: combined,
    })
    const outcome = await handle.done
    combined.throwIfAborted()
    const output = handle.collected.stdout?.readFrom(0)
    if (!output || output.lossy) throw new RsrsError('invalid-output')
    let doc: unknown
    try {
      doc = JSON.parse(output.text)
    } catch {
      throw new RsrsError(outcome.exitCode === 0 ? 'invalid-output' : 'failed')
    }
    if (typeof doc !== 'object' || doc === null || !('status' in doc) || typeof doc.status !== 'string') {
      throw new RsrsError('invalid-output')
    }
    // A pending write is a valid result; it is never retried or reported as committed.
    if (outcome.exitCode !== 0 && doc.status !== 'pending') throw new RsrsError('failed')
    return doc as Envelope
  } catch (error) {
    if (signal.aborted) throw new RsrsError('cancelled')
    if (deadline.aborted) throw new RsrsError('timeout')
    if (error instanceof RsrsError) throw error
    // Child diagnostics may contain user text or credentials; do not echo them.
    throw new RsrsError(handle ? 'failed' : 'unavailable')
  } finally {
    if (handle) {
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(2000))) throw new RsrsError('failed')
    }
  }
}
