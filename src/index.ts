import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { containsSecret, recallText, record, RULES, SKILL_PREFIX, SKIP_PREFIX, STORE_PREFIX, storeText, titleOf } from './memory.js'
import { RsrsError, runRsrs } from './rsrs.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    respire: { kind: 'respire' }
  }
}

export const name = 'respire'
export const inject = ['agents', 'systemPrompt', 'subprocess', 'workingDirectory']

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

function contextMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'respire' } })
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
      if (SKIP_PREFIX.test(prompt)) continue
      if (containsSecret(prompt)) {
        additions.push(contextMessage('【respire · skipped】The input looks like it contains a credential and was not sent to the memory engine. Provide only the fact with the secret removed, or a safe location pointer.'))
        continue
      }
      const store = STORE_PREFIX.exec(prompt)
      try {
        if (store) {
          const content = prompt.slice(store[0].length).trim()
          if (!content) {
            additions.push(contextMessage('【respire · not stored】The content is empty; ask the user for the fact to save.'))
            continue
          }
          const title = titleOf(content)
          const doc = await call(['remember', content, '--title', title, '--importance', 'important'])
          const result = storeText(doc, title)
          current.stored ||= result.stored
          state.ready = true
          let text = result.text
          if (result.stored && typeof record(doc.summary)?.id === 'string') {
            // Write read-back (R11): verify the committed entry honestly; a failed read-back
            // never blocks the receipt and never triggers a retry.
            const id = String((record(doc.summary) as Record<string, unknown>).id)
            let verdict: 'verified' | 'mismatch' | 'unavailable' = 'unavailable'
            try {
              const shown = await call(['show', id])
              const entry = record(record(shown.details)?.entry)
              if (shown.status === 'ok' && entry) {
                const titleOk = !title || entry.title === title
                const bodyOk = !content.slice(0, 40) || String(entry.content ?? '').includes(content.slice(0, 40))
                verdict = titleOk && bodyOk ? 'verified' : 'mismatch'
              }
            } catch { verdict = 'unavailable' }
            text += verdict === 'verified'
              ? ' Write verified by read-back (entry exists; title and content match).'
              : verdict === 'mismatch'
                ? ` Read-back shows a DIFFERENT title/content than sent — inspect rsrs --client-only show ${id.slice(0, 8)} before refining the title.`
                : ` Read-back unavailable — if it matters, verify with rsrs --client-only show ${id.slice(0, 8)}.`
          }
          additions.push(contextMessage(text))
        } else if (prompt.length >= config.minPromptChars) {
          const query = prompt.replace(SKILL_PREFIX, '').trim() || prompt
          const doc = await call(['recall', query, '--limit', String(config.recallLimit), '--titles'])
          const text = recallText(doc, config.recallLimit, config.recallThreshold, config.budgetChars)
          state.ready = true
          if (text) additions.push(contextMessage(text))
        }
      } catch (error) {
        if (combined.aborted) return decision
        const code = error instanceof RsrsError ? error.code : 'invalid-output'
        ctx.logger.warn(`respire: ${store ? 'store' : 'recall'} ${code}`)
        additions.push(contextMessage(store
          ? `【respire · store unconfirmed】${code}. It may have been written; verify against the store first; never retry automatically or claim success.`
          : `【respire · recall unavailable】${code}. No memory was obtained; continue with the current materials.`))
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
