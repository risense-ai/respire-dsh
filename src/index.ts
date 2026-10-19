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
          if (record(summary?.session)?.has_session === false) additions.push(contextMessage('【respire·状态】尚未登录。账户和同步请按 rsrs status 的结果配置。'))
          if (typeof summary?.local_alive === 'number' && summary.local_alive < 10) additions.push(contextMessage('【respire·状态】记忆库内容较少，召回为空可能正常。可显式保存已确认的项目约定；语义模型由 rsrs 按需配置。'))
          if (summary?.unlocked === false) additions.push(contextMessage('【respire·状态】记忆库尚未解锁，请用户按 rsrs 的交互流程解锁，不收集密码。'))
        } catch (error) {
          if (combined.aborted) return decision
          ctx.logger.warn(`respire: status ${error instanceof RsrsError ? error.code : 'failed'}`)
          additions.push(contextMessage('【respire·状态】引擎或 runtime 不可用。请核实 rsrs --version 和 rsrs --client-only status；缺引擎时可安装 @rsrsai/cli。当前任务继续。'))
        }
      }
      if (SKIP_PREFIX.test(prompt)) continue
      if (containsSecret(prompt)) {
        additions.push(contextMessage('【respire·已跳过】输入含疑似凭据，不发送给记忆引擎。请只提供去除秘密的事实或安全的位置指针。'))
        continue
      }
      const store = STORE_PREFIX.exec(prompt)
      try {
        if (store) {
          const content = prompt.slice(store[0].length).trim()
          if (!content) {
            additions.push(contextMessage('【respire·未存】存储内容为空，请用户提供要保存的事实。'))
            continue
          }
          const title = titleOf(content)
          const result = storeText(await call(['remember', content, '--title', title, '--importance', 'important']), title)
          current.stored ||= result.stored
          state.ready = true
          additions.push(contextMessage(result.text))
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
          ? `【respire·落库未确认】${code}。可能已写入，请先查库核实；勿自动重试或声称成功。`
          : `【respire·召回不可用】${code}。未获得记忆，请依据当前材料继续。`))
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
    agent.steer(contextMessage('【respire·收尾检查，仅本轮一次】若本轮产生新的事实、决定、约定或教训，请先查同题、读候选，再更新或选定 parent 落库；标题用事实句。若已存储或无需存储，直接结束，不重复回答。'))
  })
}
