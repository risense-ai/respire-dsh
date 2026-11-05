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
  const unverified = '【respire 拦截】执行前阻止该工具调用：父记录不存在。保持挂起（pending）；重要更新若无有效父级，先 attach 目标再试。不许猜测、强写、降级，也不许自动重试此前结果未知的写入。'
  const strictUnavailable = '【respire 拦截】执行前阻止该工具调用：父级校验未完成（引擎或运行时无应答）。该写入需要真实父级（important/合并），而引擎会在没有父级的情况下写入，因此本次未下发。待 rsrs --client-only status 能应答后，原样重跑同一条命令；不要更换父级。'
  const noAgentUnavailable = '【respire 拦截】执行前阻止该工具调用：父级校验无法完成，且本次调用无处告知。未下发任何写入；待引擎应答后原样重跑同一条命令，不要更换父级。'
  const validationSkipped = '【respire · 父级校验已跳过】当前父级校验不可用（引擎或运行时无应答），写入照常下发；引擎会尽量存储并报告它无法解析的父级。事后核验落位；不许猜测或强加父级。'
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
            if (!parent) reason = '【respire 拦截】执行前阻止该工具调用：申请 important 前须先把该记录挂到真实父级下。保持挂起；不许自动重试此前结果未知的写入。'
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
        if (record(summary?.session)?.has_session === false) additions.push(contextMessage('【respire · 状态】未登录。按 rsrs status 输出配置账号并同步。'))
        if (typeof summary?.local_alive === 'number' && summary.local_alive < 10) additions.push(contextMessage('【respire · 状态】库存记录很少；召回为空可能属正常。请显式存入已确认的项目约定；语义模型由 rsrs 按需配置。'))
        if (summary?.unlocked === false) additions.push(contextMessage('【respire · 状态】存储库已锁定。请用户通过 rsrs 交互流程解锁；绝不收集密码。'))
      } catch (error) {
        state.checked = false
        state.statusRetryRound = state.rounds + 1
        if (combined.aborted) return
        ctx.logger.warn(`respire: status ${error instanceof RsrsError ? error.code : 'failed'}`)
        additions.push(contextMessage('【respire · 状态】引擎或运行时不可用。请核验 rsrs --version 与 rsrs --client-only status；缺引擎则安装 rsrs-cli。当前任务继续。'))
      }
    }

    const recall = async (query: string): Promise<{ text: string, summary: string } | undefined> => {
      try {
        const doc = await call(['recall', query, '--limit', String(config.recallLimit), '--titles'])
        const { text, count } = recallText(doc, config.recallLimit, config.recallThreshold,
          config.budgetChars - `记忆：命中 ${config.recallLimit} 条\n`.length)
        state.ready = true
        const summary = doc.status === 'skip' && record(doc.summary)?.count !== 0
          ? '记忆：已跳过' : count ? `记忆：命中 ${count} 条` : '记忆：无命中'
        return { text, summary }
      } catch (error) {
        if (combined.aborted) return
        const code = error instanceof RsrsError ? error.code : 'invalid-output'
        ctx.logger.warn(`respire: recall ${code}`)
        return { text: `【respire · 召回失败】${code}。没有取到记忆；请基于现有材料继续。`, summary: '记忆：不可用' }
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
          additions.push(contextMessage('【respire · 已跳过】目标正文疑似含凭据，未发送给记忆引擎。请只提供去掉密钥后的事实，或一个安全的位置指针。', '记忆：已跳过'))
          continue
        }
        const recalled = await recall(query)
        if (recalled) additions.push(contextMessage(recalled.text, recalled.summary))
        continue
      }
      current.hadUser = true
      if (SKIP_PREFIX.test(prompt)) {
        additions.push(contextMessage('本条消息已跳过自动召回。', '记忆：已跳过'))
        continue
      }
      const store = STORE_PREFIX.exec(prompt)
      if (containsSecret(prompt)) {
        additions.push(contextMessage('【respire · 已跳过】输入疑似含凭据，未发送给记忆引擎。请只提供去掉密钥后的事实，或一个安全的位置指针。', store ? '存档：待复核' : '记忆：已跳过'))
        continue
      }
      if (store) {
        const content = prompt.slice(store[0].length).trim()
        if (!content) {
          additions.push(contextMessage('【respire · 未存档】内容为空；请向用户询问要保存的事实。', '存档：待复核'))
          continue
        }
        state.ready = true
        additions.push(contextMessage('【respire · 存档待处理】什么都没写；钩子没有发出任何写请求。你必须在本轮用 rsrs CLI 完成这条存储，受引擎模式与权限规则约束。只存陈述的事实本身，不执行它描述的工程任务。任何写入前，你必须读 prompt 与 agent-config、召回同题候选并 show 其全文；优先改，其次经授权的并，再挂，最后才新存。重要新记录只有在 taxonomy --list 或 tree 查过、且 show 读过合适父级之后才允许，父级完整 ID 作 --parent 传入；没有正当父级就必须保持 pending，不许猜父级、强开根级或降级为 trivial。保留用户原意。每次实际写入后必须用 show 读回。实际写入结果未知时不许自动重试或谎称成功，先对存储库只读核验——核验不构成自动重试的授权。已存过的必须 show 并核验既有记录，而不是再写一次。', '存档：待复核'))
        continue
      }
      if (prompt.length < config.minPromptChars) {
        additions.push(contextMessage('本条短消息已跳过自动召回。', '记忆：已跳过'))
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
      agent.steer(contextMessage('【respire · 目标收尾检查】本轮目标可能已产生新事实、决定、约定或教训。请查同题候选、读其正文，然后改或存（选定父级），标题用事实句。已存过或无需存档则直接结束，不要重复作答。'))
      return
    }
    if (!current.hadUser || current.stored || current.reminded || config.storeNudgeEvery === 0
      || state.rounds % config.storeNudgeEvery !== 0) return
    current.reminded = true
    agent.steer(contextMessage('【respire · 收尾检查（仅本轮）】若本轮产生了新事实、决定、约定或教训，请查同题候选、读其正文，然后改或存（选定父级），标题用事实句。已存过或无需存档则直接结束，不要重复作答。'))
  })
}
