import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { containsSecret, currentParent, MCP_WRITE_DENIAL, memoryToolWrite, memoryWrite, parentExists, recallText, record, RULES, SKILL_PREFIX, SKIP_PREFIX, STORE_PREFIX } from './memory.js'
import { RsrsError, runRsrs } from './rsrs.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    respire: { kind: 'respire' } & ContextFormed
  }
}

export const name = 'respire'
export const inject = ['agents', 'systemPrompt', 'subprocess', 'workingDirectory', 'tools']

export interface Config {
  enabled?: boolean
  rsrsPath?: string
  recallLimit?: number
  recallThreshold?: number
  budgetChars?: number
  minPromptChars?: number
  storeNudgeEvery?: number
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  rsrsPath: z.string().default('rsrs'),
  recallLimit: z.number().default(5),
  recallThreshold: z.number().default(0),
  budgetChars: z.number().default(1500),
  minPromptChars: z.number().default(2),
  storeNudgeEvery: z.number().default(1),
  timeoutMs: z.number().default(20000),
})

interface TurnState {
  turn: number
  processed: Set<string>
  hadUser: boolean
  stored: boolean
  reminded: boolean
}

interface AgentState {
  checked: boolean
  ready: boolean
  rounds: number
  turn?: TurnState
}

function contextMessage(text: string, summary?: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: summary ? `${summary}\n${text}` : text }],
    source: summary ? { kind: 'respire', form: 'notice', summary } : { kind: 'respire' } })
}

// Structural tools contract keeps the existing host dependency versions unchanged.
interface MemoryExecution { name: string, arguments: unknown, agent?: Agent, signal: AbortSignal }
interface ToolDecision { kind: string, reason?: string, [key: string]: unknown }
interface ToolsContext {
  tools: { guard(check: (exec: MemoryExecution) => string | undefined): unknown }
  on(event: 'tools/pre-execute', listener: (exec: MemoryExecution, next: () => Promise<ToolDecision>) => Promise<ToolDecision>): unknown
}

export function apply(ctx: Context, options: Config = {}): void {
  const config = { enabled: true, rsrsPath: 'rsrs', recallLimit: 5, recallThreshold: 0,
    budgetChars: 1500, minPromptChars: 2, storeNudgeEvery: 1, timeoutMs: 20000, ...options }
  for (const [key, minimum, maximum] of [
    ['recallLimit', 1, 20], ['budgetChars', 200, 20000], ['minPromptChars', 1, 1000],
    ['storeNudgeEvery', 0, 1000], ['timeoutMs', 1, 120000],
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < minimum || config[key] > maximum) {
      throw new TypeError(`respire: invalid ${key}`)
    }
  }
  if (!Number.isFinite(config.recallThreshold) || config.recallThreshold < 0 || config.recallThreshold > 1) {
    throw new TypeError('respire: invalid recallThreshold')
  }
  if (!config.rsrsPath.trim()) throw new TypeError('respire: rsrsPath must not be empty')
  if (!config.enabled) return

  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const states = new WeakMap<Agent, AgentState>()
  const stateOf = (agent: Agent): AgentState => {
    let state = states.get(agent)
    if (!state) {
      state = { checked: false, ready: false, rounds: 0 }
      states.set(agent, state)
    }
    return state
  }

  const toolHost = ctx as unknown as ToolsContext
  if (typeof toolHost.tools?.guard !== 'function') throw new Error('respire: this Harness version must support tools.guard()')
  const commandOf = (exec: MemoryExecution) => ['bash', 'pwsh', 'terminal_send'].includes(exec.name)
    ? record(exec.arguments)?.[exec.name === 'terminal_send' ? 'text' : 'command'] : undefined
  const shellOf = (exec: MemoryExecution) => exec.name === 'bash' ? 'bash' : exec.name === 'pwsh' ? 'powershell' : 'unknown'
  const checks = new WeakMap<MemoryExecution, { command: unknown, reason?: string }>()
  const unverified = 'Respire blocked this tool call before execution: parent validation did not complete. Keep placement pending; for important updates, attach the target first if it has no valid parent. DO NOT guess, force, downgrade, or automatically retry an earlier unknown write.'
  toolHost.tools.guard(exec => {
    if (memoryToolWrite(exec.name)) return MCP_WRITE_DENIAL
    if (!memoryWrite(commandOf(exec), config.rsrsPath, shellOf(exec))) return
    const check = checks.get(exec)
    return check && check.command === commandOf(exec) ? check.reason : unverified
  })
  toolHost.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    if (memoryToolWrite(exec.name)) return { kind: 'deny', reason: MCP_WRITE_DENIAL }
    const command = commandOf(exec)
    const write = memoryWrite(command, config.rsrsPath, shellOf(exec))
    if (!write) return decision
    let reason = write.reason
    if (!reason && (write.parent || write.target)) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal, AbortSignal.timeout(Math.min(config.timeoutMs, 5000))])
      try {
        if (!exec.agent) throw new Error('agent unavailable')
        signal.throwIfAborted()
        const cwd = await ctx.workingDirectory.ensure(exec.agent, signal)
        const read = (id: string) => runRsrs(ctx.subprocess, config.rsrsPath,
          ['--client-only', 'show', id, '--json'], cwd, signal, Math.min(config.timeoutMs, 5000))
        let parent = write.parent
        if (write.target) {
          const target = await read(write.target)
          if (!parentExists(target, write.target)) reason = unverified
          else {
            parent = currentParent(target, write.target)
            if (!parent) reason = 'Respire blocked this tool call before execution: attach this record under a real parent before requesting important. Keep it pending; DO NOT automatically retry any earlier unknown write.'
          }
        }
        if (!reason && parent && !parentExists(await read(parent), parent)) reason = unverified
        signal.throwIfAborted()
      } catch { reason = unverified }
    }
    checks.set(exec, { command, reason })
    return reason ? { kind: 'deny', reason } : decision
  })

  ctx.systemPrompt.section({ name: 'respire:rules', order: 850, text: RULES, interpolate: false })

  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || lifetime.signal.aborted) return decision
    const humans = decision.messages.filter(message => message.source.kind === 'user')
    if (!humans.length) return decision
    const state = stateOf(agent)
    if (state.turn?.turn !== turn) {
      state.rounds++
      state.turn = { turn, processed: new Set(), hadUser: false, stored: false, reminded: false }
    }
    const current = state.turn
    const additions: UserMessage[] = []
    const combined = AbortSignal.any([signal, lifetime.signal])
    const call = async (args: string[]) => {
      const cwd = await ctx.workingDirectory.ensure(agent, combined)
      return runRsrs(ctx.subprocess, config.rsrsPath, ['--client-only', ...args, '--json'], cwd, combined, config.timeoutMs)
    }

    for (const message of humans) {
      if (current.processed.has(message.id)) continue
      current.processed.add(message.id)
      const prompt = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
      if (!prompt) continue
      current.hadUser = true
      if (!state.checked) {
        state.checked = true
        try {
          const status = await call(['status'])
          state.ready = status.status === 'ok'
          const summary = record(status.summary)
          if (record(summary?.session)?.has_session === false) additions.push(contextMessage('【respire · status】Not signed in. Configure the account and sync per the rsrs status output.'))
          if (typeof summary?.local_alive === 'number' && summary.local_alive < 10) additions.push(contextMessage('【respire · status】The store has few records; empty recall may be normal. Explicitly save confirmed project agreements; the semantic model is configured by rsrs as needed.'))
          if (summary?.unlocked === false) additions.push(contextMessage('【respire · status】The store is locked. Ask the user to unlock it via the rsrs interactive flow; never collect passwords.'))
        } catch (error) {
          if (combined.aborted) return decision
          ctx.logger.warn(`respire: status ${error instanceof RsrsError ? error.code : 'failed'}`)
          additions.push(contextMessage('【respire · status】Engine or runtime unavailable. Verify rsrs --version and rsrs --client-only status; if the engine is missing, install rsrs-cli. The current task continues.'))
        }
      }
      if (SKIP_PREFIX.test(prompt)) {
        additions.push(contextMessage('Automatic recall was skipped for this message.', 'Memory: skipped'))
        continue
      }
      const store = STORE_PREFIX.exec(prompt)
      if (containsSecret(prompt)) {
        additions.push(contextMessage('【respire · skipped】The input looks like it contains a credential and was not sent to the memory engine. Provide only the fact with the secret removed, or a safe location pointer.', store ? 'Save: needs review' : 'Memory: skipped'))
        continue
      }
      try {
        if (store) {
          const content = prompt.slice(store[0].length).trim()
          if (!content) {
            additions.push(contextMessage('【respire · not stored】The content is empty; ask the user for the fact to save.', 'Save: needs review'))
            continue
          }
          state.ready = true
          additions.push(contextMessage('【respire · store pending】Nothing was written; the hook made no write request. You MUST resolve this storage request in this turn with the rsrs CLI, subject to engine mode and permission rules. Save ONLY the stated fact; DO NOT execute the engineering task it describes. Before any write, you MUST read prompt and agent-config, recall same-subject candidates, and show their full bodies. Prefer update, then an authorized merge, then attach, then a new record. A new important record is permitted ONLY AFTER inspecting taxonomy --list or tree and reading a suitable parent with show; pass its full ID with --parent. If no justified parent exists, you MUST remain pending; DO NOT guess a parent, force a root write, or downgrade to trivial. Preserve the user’s meaning. After every actual write, you MUST read it back with show. If an actual write outcome is unknown, DO NOT retry automatically or claim success; first verify the store read-only. Verification does not authorize an automatic retry. If already stored, you MUST show and verify the existing record instead of writing again.', 'Save: needs review'))
        } else if (prompt.length >= config.minPromptChars) {
          const query = prompt.replace(SKILL_PREFIX, '').trim() || prompt
          const doc = await call(['recall', query, '--limit', String(config.recallLimit), '--titles'])
          const { text, count } = recallText(doc, config.recallLimit, config.recallThreshold,
            config.budgetChars - `Memory: ${config.recallLimit} found\n`.length)
          state.ready = true
          const summary = doc.status === 'skip' && record(doc.summary)?.count !== 0
            ? 'Memory: skipped' : count ? `Memory: ${count} found` : 'Memory: no match'
          additions.push(contextMessage(text, summary))
        } else {
          additions.push(contextMessage('Automatic recall was skipped for this short message.', 'Memory: skipped'))
        }
      } catch (error) {
        if (combined.aborted) return decision
        const code = error instanceof RsrsError ? error.code : 'invalid-output'
        ctx.logger.warn(`respire: recall ${code}`)
        additions.push(contextMessage(`【respire · recall unavailable】${code}. No memory was obtained; continue with the current materials.`, 'Memory: unavailable'))
      }
    }
    if (combined.aborted || !additions.length) return decision
    return { ...decision, messages: [...decision.messages, ...additions] }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const state = states.get(agent)
    const current = state?.turn
    if (signal.aborted || lifetime.signal.aborted || !state?.ready || !current || current.turn !== turn
      || !current.hadUser || current.stored || current.reminded || config.storeNudgeEvery === 0
      || state.rounds % config.storeNudgeEvery !== 0) return
    current.reminded = true
    agent.steer(contextMessage('【respire · wrap-up check, this round only】If this turn produced new facts, decisions, agreements, or lessons, check same-subject candidates, read them, then update or store with a chosen parent; use a fact-sentence title. If already stored or nothing needs storing, end directly and do not repeat the answer.'))
  })
}
