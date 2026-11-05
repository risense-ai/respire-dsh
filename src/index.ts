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

export type GoalRecall = 'off' | 'first' | 'every'

export interface Config {
  enabled?: boolean
  rsrsPath?: string
  recallLimit?: number
  recallThreshold?: number
  budgetChars?: number
  minPromptChars?: number
  storeNudgeEvery?: number
  goalRecall?: GoalRecall
  goalRecallEvery?: number
  goalNudgeEvery?: number
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
  goalRecall: z.union([z.const('off'), z.const('first'), z.const('every')]).default('first'),
  goalRecallEvery: z.number().default(1),
  goalNudgeEvery: z.number().default(0),
  timeoutMs: z.number().default(20000),
})

interface GoalMessageSource {
  kind: 'goal'
  goalId: string
  revision: number
  round: number
}

interface GoalViewLike {
  id: string
  revision: number
  objective: string
}

interface TurnState {
  turn: number
  processed: Set<string>
  hadUser: boolean
  hadGoal: boolean
  goalRound: number
  goalNudged: boolean
  stored: boolean
  reminded: boolean
}

interface AgentState {
  checked: boolean
  ready: boolean
  rounds: number
  goalKey?: string
  statusRetryRound?: number
  turn?: TurnState
}

function contextMessage(text: string, summary?: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: summary ? `${summary}\n${text}` : text }],
    source: summary ? { kind: 'respire', form: 'notice', summary } : { kind: 'respire' } })
}

function messageText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

function goalSource(message: UserMessage): GoalMessageSource | undefined {
  const source = message.source as unknown as Record<string, unknown>
  if (source.kind !== 'goal') return
  const { goalId, revision, round } = source
  if (typeof goalId !== 'string' || typeof revision !== 'number' || !Number.isSafeInteger(revision)
    || typeof round !== 'number' || !Number.isSafeInteger(round) || round <= 0) return
  return { kind: 'goal', goalId, revision, round }
}

function goalKeyOf(source: GoalMessageSource): string {
  return `${source.goalId}:${source.revision}`
}

function goalObjectiveText(text: string): string | undefined {
  const match = /<goal_round>\s*Objective:\s*("(?:[^"\\]|\\.)*")/.exec(text)
  const quoted = match?.[1]
  if (!quoted) return
  try {
    const value: unknown = JSON.parse(quoted)
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch { return }
}

function goalQuery(ctx: Context, agent: Agent, source: GoalMessageSource, text: string): string | undefined {
  try {
    const goals = (ctx as unknown as { get?: (name: string) => unknown }).get?.('goals') as
      { get?: (agent: Agent) => GoalViewLike | undefined } | undefined
    const view = goals?.get?.(agent)
    if (view && view.id === source.goalId && view.revision === source.revision
      && typeof view.objective === 'string' && view.objective.trim()) return view.objective.trim()
  } catch { /* optional goal service: fall back to the retained prompt text */ }
  return goalObjectiveText(text) ?? (text || undefined)
}

function shouldRecallGoal(state: AgentState, source: GoalMessageSource, goalRecall: GoalRecall, every: number): boolean {
  if (goalRecall === 'off') return false
  if (goalRecall === 'first') return state.goalKey !== goalKeyOf(source)
  return source.round === 1 || source.round % every === 0
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
    budgetChars: 1500, minPromptChars: 2, storeNudgeEvery: 1, goalRecall: 'first' as GoalRecall,
    goalRecallEvery: 1, goalNudgeEvery: 0, timeoutMs: 20000, ...options }
  for (const [key, minimum, maximum] of [
    ['recallLimit', 1, 20], ['budgetChars', 200, 20000], ['minPromptChars', 1, 1000],
    ['storeNudgeEvery', 0, 1000], ['goalRecallEvery', 1, 1000], ['goalNudgeEvery', 0, 1000],
    ['timeoutMs', 1, 120000],
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < minimum || config[key] > maximum) {
      throw new TypeError(`respire: invalid ${key}`)
    }
  }
  if (!['off', 'first', 'every'].includes(config.goalRecall)) throw new TypeError('respire: invalid goalRecall')
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
  const unverified = 'Respire blocked this tool call before execution: the parent record does not exist. Keep placement pending; for important updates, attach the target first if it has no valid parent. DO NOT guess, force, downgrade, or automatically retry an earlier unknown write.'
  const strictUnavailable = 'Respire blocked this tool call before execution: parent validation did not complete (the engine or runtime did not answer). This write needs a real parent (important/merge), and the engine would store it without one, so nothing was dispatched. Re-run the same single command once rsrs --client-only status answers; do not change the parent.'
  const noAgentUnavailable = 'Respire blocked this tool call before execution: parent validation could not complete and this call cannot be told about it. Nothing was dispatched; re-run the same single command once the engine answers, and do not change the parent.'
  const validationSkipped = '【respire · parent check skipped】Parent validation is unavailable right now (engine or runtime did not answer), so the write is dispatched anyway; the engine stores what it can and reports the parent it cannot resolve. Verify the placement afterwards; do not guess or force a parent.'
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
    let skipped = false
    // A read that cannot answer proves nothing about the parent. Never dispatch a write the engine
    // would store WITHOUT that parent (important/merge): measured behaviour is status=warn plus an
    // orphan record, which is worse than a denial the caller can retry. Ordinary writes proceed and
    // are told why the placement was not verified.
    const unavailable = (): void => {
      if (!exec.agent) reason = noAgentUnavailable
      else if (write.strict) reason = strictUnavailable
      else skipped = true
    }
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
          // Only a real ok envelope is authoritative. A non-ok envelope is "could not answer",
          // exactly like a thrown read: it must not be read as "the record does not exist".
          if (target.status !== 'ok') unavailable()
          else if (!parentExists(target, write.target)) reason = unverified
          else {
            parent = currentParent(target, write.target)
            if (!parent) reason = 'Respire blocked this tool call before execution: attach this record under a real parent before requesting important. Keep it pending; DO NOT automatically retry any earlier unknown write.'
          }
        }
        if (!skipped && !reason && parent) {
          const doc = await read(parent)
          if (doc.status !== 'ok') unavailable()
          else if (!parentExists(doc, parent)) reason = unverified
        }
        signal.throwIfAborted()
      } catch { unavailable() }
    }
    if (skipped && exec.agent) {
      try { exec.agent.steer(contextMessage(validationSkipped)) } catch (error) {
        // A notice that cannot be delivered must never turn a dispatched write into a failure.
        ctx.logger.warn(`respire: steer ${error instanceof Error ? error.message : 'failed'}`)
      }
    }
    checks.set(exec, { command, reason })
    return reason ? { kind: 'deny', reason } : decision
  })

  ctx.systemPrompt.section({ name: 'respire:rules', order: 850, text: RULES, interpolate: false })

  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || lifetime.signal.aborted) return decision
    const state = stateOf(agent)
    const triggers = decision.messages.filter(message => message.source.kind === 'user'
      || (goalSource(message) !== undefined && config.goalRecall !== 'off'))
    if (!triggers.length) return decision
    if (state.turn?.turn !== turn) {
      if (triggers.some(message => message.source.kind === 'user')) state.rounds++
      state.turn = { turn, processed: new Set(), hadUser: false, hadGoal: false, goalRound: 0, goalNudged: false, stored: false, reminded: false }
    }
    const current = state.turn
    const additions: UserMessage[] = []
    const combined = AbortSignal.any([signal, lifetime.signal])
    const call = async (args: string[]) => {
      const cwd = await ctx.workingDirectory.ensure(agent, combined)
      return runRsrs(ctx.subprocess, config.rsrsPath, ['--client-only', ...args, '--json'], cwd, combined, config.timeoutMs)
    }

    const ensureStatus = async (): Promise<void> => {
      if (state.checked) return
      // A single failed status check used to stick for the whole agent lifetime, which silenced
      // every wrap-up store reminder after one transient runtime outage. Retry on the next turn.
      if (state.statusRetryRound !== undefined && state.rounds < state.statusRetryRound) return
      state.checked = true
      try {
        const status = await call(['status'])
        state.ready = status.status === 'ok'
        const summary = record(status.summary)
        if (record(summary?.session)?.has_session === false) additions.push(contextMessage('【respire · status】Not signed in. Configure the account and sync per the rsrs status output.'))
        if (typeof summary?.local_alive === 'number' && summary.local_alive < 10) additions.push(contextMessage('【respire · status】The store has few records; empty recall may be normal. Explicitly save confirmed project agreements; the semantic model is configured by rsrs as needed.'))
        if (summary?.unlocked === false) additions.push(contextMessage('【respire · status】The store is locked. Ask the user to unlock it via the rsrs interactive flow; never collect passwords.'))
      } catch (error) {
        state.checked = false
        state.statusRetryRound = state.rounds + 1
        if (combined.aborted) return
        ctx.logger.warn(`respire: status ${error instanceof RsrsError ? error.code : 'failed'}`)
        additions.push(contextMessage('【respire · status】Engine or runtime unavailable. Verify rsrs --version and rsrs --client-only status; if the engine is missing, install rsrs-cli. The current task continues.'))
      }
    }

    const recall = async (query: string): Promise<{ text: string, summary: string } | undefined> => {
      try {
        const doc = await call(['recall', query, '--limit', String(config.recallLimit), '--titles'])
        const { text, count } = recallText(doc, config.recallLimit, config.recallThreshold,
          config.budgetChars - `Memory: ${config.recallLimit} found\n`.length)
        state.ready = true
        const summary = doc.status === 'skip' && record(doc.summary)?.count !== 0
          ? 'Memory: skipped' : count ? `Memory: ${count} found` : 'Memory: no match'
        return { text, summary }
      } catch (error) {
        if (combined.aborted) return
        const code = error instanceof RsrsError ? error.code : 'invalid-output'
        ctx.logger.warn(`respire: recall ${code}`)
        return { text: `【respire · recall unavailable】${code}. No memory was obtained; continue with the current materials.`, summary: 'Memory: unavailable' }
      }
    }

    await ensureStatus()
    if (combined.aborted) return decision

    for (const message of triggers) {
      if (current.processed.has(message.id)) continue
      current.processed.add(message.id)
      const prompt = messageText(message)
      if (!prompt) continue
      const source = goalSource(message)
      if (source) {
        current.hadGoal = true
        current.goalRound = source.round
        if (!shouldRecallGoal(state, source, config.goalRecall, config.goalRecallEvery)) continue
        state.goalKey = goalKeyOf(source)
        const query = goalQuery(ctx, agent, source, prompt)
        if (!query) continue
        if (containsSecret(query)) {
          additions.push(contextMessage('【respire · skipped】The goal objective looks like it contains a credential and was not sent to the memory engine. Provide only the fact with the secret removed, or a safe location pointer.', 'Memory: skipped'))
          continue
        }
        const recalled = await recall(query)
        if (recalled) additions.push(contextMessage(recalled.text, recalled.summary))
        continue
      }
      current.hadUser = true
      if (SKIP_PREFIX.test(prompt)) {
        additions.push(contextMessage('Automatic recall was skipped for this message.', 'Memory: skipped'))
        continue
      }
      const store = STORE_PREFIX.exec(prompt)
      if (containsSecret(prompt)) {
        additions.push(contextMessage('【respire · skipped】The input looks like it contains a credential and was not sent to the memory engine. Provide only the fact with the secret removed, or a safe location pointer.', store ? 'Save: needs review' : 'Memory: skipped'))
        continue
      }
      if (store) {
        const content = prompt.slice(store[0].length).trim()
        if (!content) {
          additions.push(contextMessage('【respire · not stored】The content is empty; ask the user for the fact to save.', 'Save: needs review'))
          continue
        }
        state.ready = true
        additions.push(contextMessage('【respire · store pending】Nothing was written; the hook made no write request. You MUST resolve this storage request in this turn with the rsrs CLI, subject to engine mode and permission rules. Save ONLY the stated fact; DO NOT execute the engineering task it describes. Before any write, you MUST read prompt and agent-config, recall same-subject candidates, and show their full bodies. Prefer update, then an authorized merge, then attach, then a new record. A new important record is permitted ONLY AFTER inspecting taxonomy --list or tree and reading a suitable parent with show; pass its full ID with --parent. If no justified parent exists, you MUST remain pending; DO NOT guess a parent, force a root write, or downgrade to trivial. Preserve the user’s meaning. After every actual write, you MUST read it back with show. If an actual write outcome is unknown, DO NOT retry automatically or claim success; first verify the store read-only. Verification does not authorize an automatic retry. If already stored, you MUST show and verify the existing record instead of writing again.', 'Save: needs review'))
        continue
      }
      if (prompt.length < config.minPromptChars) {
        additions.push(contextMessage('Automatic recall was skipped for this short message.', 'Memory: skipped'))
        continue
      }
      const query = prompt.replace(SKILL_PREFIX, '').trim() || prompt
      const recalled = await recall(query)
      if (recalled) additions.push(contextMessage(recalled.text, recalled.summary))
    }

    if (combined.aborted || !additions.length) return decision
    return { ...decision, messages: [...decision.messages, ...additions] }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const state = states.get(agent)
    const current = state?.turn
    if (signal.aborted || lifetime.signal.aborted || !state?.ready || !current || current.turn !== turn) return
    if (current.hadGoal && config.goalNudgeEvery > 0
      && current.goalRound % config.goalNudgeEvery === 0 && !current.goalNudged) {
      current.goalNudged = true
      agent.steer(contextMessage('【respire · goal wrap-up check】This goal round may have produced new facts, decisions, agreements, or lessons. Check same-subject candidates, read them, then update or store with a chosen parent; use a fact-sentence title. If already stored or nothing needs storing, end directly and do not repeat the answer.'))
      return
    }
    if (!current.hadUser || current.stored || current.reminded || config.storeNudgeEvery === 0
      || state.rounds % config.storeNudgeEvery !== 0) return
    current.reminded = true
    agent.steer(contextMessage('【respire · wrap-up check, this round only】If this turn produced new facts, decisions, agreements, or lessons, check same-subject candidates, read them, then update or store with a chosen parent; use a fact-sentence title. If already stored or nothing needs storing, end directly and do not repeat the answer.'))
  })
}
