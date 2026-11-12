import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { containsSecret, currentParent, MCP_WRITE_DENIAL, memoryToolWrite, memoryWrite, parentExists, recallText, record, RULES, RULES_ZH, SKILL_PREFIX, SKIP_PREFIX, STORE_PREFIX } from './memory.js'
import { RsrsError, runRsrs } from './rsrs.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    respire: { kind: 'respire' } & ContextFormed
  }
}

export const name = 'respire'
export const inject = ['agents', 'systemPrompt', 'subprocess', 'workingDirectory', 'tools']

export type GoalRecall = 'off' | 'first' | 'every'

export type RulesLocale = 'en' | 'zh' | 'bilingual'

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
  rulesLocale?: RulesLocale
  timeoutMs?: number
  obstacleRecall?: boolean
  obstacleWindowSec?: number
  obstacleRepeat?: number
  obstacleHoldWrites?: boolean
  obstacleHoldAfter?: number
  obstacleHoldTtlSec?: number
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
  rulesLocale: z.union([z.const('en'), z.const('zh'), z.const('bilingual')]).default('en'),
  timeoutMs: z.number().default(20000),
  obstacleRecall: z.boolean().default(true),
  obstacleWindowSec: z.number().default(300),
  obstacleRepeat: z.number().default(2),
  obstacleHoldWrites: z.boolean().default(false),
  obstacleHoldAfter: z.number().default(3),
  obstacleHoldTtlSec: z.number().default(1800),
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

interface ObstacleState {
  recent: { sig: string, at: number }[]
  pending?: { level: 1 | 2, text: string }
  consecutive: number
  holdSince?: number
}

interface AgentState {
  checked: boolean
  ready: boolean
  rounds: number
  goalKey?: string
  turn?: TurnState
  obstacle?: ObstacleState
}

function contextMessage(text: string, summary?: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: summary ? `${summary}\n${text}` : text }],
    source: summary ? { kind: 'respire', form: 'notice', summary } : { kind: 'respire' } })
}

function messageText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

// Obstacle-recall hard mechanism: classify one completed tool outcome as a failure.
// Denied calls reach tools/post-execute too (the harness routes a pre-execute deny
// through the same pipeline), throwing tools set isError, and bash reports a non-zero
// exit only as an `[exit code: N]` marker in its content — never as isError.
function obstacleFailure(result: unknown, downstream: unknown): { text: string, deny: boolean } | undefined {
  const textOf = (shape: Record<string, unknown>): string => {
    const reason = [shape.reason, shape.feedback, shape.message]
      .find(value => typeof value === 'string' && value) as string | undefined
    if (reason) return reason
    if (!Array.isArray(shape.content)) return ''
    return shape.content.flatMap(block => {
      const entry = record(block)
      return entry && entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
    }).join('\n')
  }
  for (const candidate of [result, downstream]) {
    const shape = record(candidate)
    if (!shape) continue
    const kind = typeof shape.kind === 'string' ? shape.kind : ''
    const deny = kind === 'deny' || kind === 'block'
    const failed = deny || kind === 'error' || kind === 'aborted' || shape.isError === true
    const text = textOf(shape)
    if (failed && text) return { text, deny }
    if (/\[exit code: [1-9]\d*\]/.test(text)) return { text, deny: false }
  }
  return undefined
}

// Deny signatures key on the rsrs operation (the write body differs per call but the
// root cause does not); bash failures key on the command hint plus the exit marker.
function obstacleSignature(exec: MemoryExecution, failure: { text: string, deny: boolean }, command: unknown): string {
  const first = obstacleFirstLine(failure.text)
  if (failure.deny) {
    const operation = typeof command === 'string'
      ? command.match(/\b(remember|update|recall|show|tree|taxonomy)\b/)?.[0] : undefined
    return `${exec.name}|rsrs ${operation ?? 'write'}|${first.slice(0, 160)}`
  }
  const hint = (typeof command === 'string' ? command : '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return `${exec.name}|${hint}|${first.match(/\[exit code: [1-9]\d*\]/)?.[0] ?? first.slice(0, 120)}`
}

function obstacleFirstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line) ?? ''
}

function obstacleNotice(name: string, failure: string): string {
  return `【respire · 遇障先翻忆】上一轮工具调用失败（${name}：${obstacleFirstLine(failure).slice(0, 160)}）。在改代码、改配置或重试之前，你必须先 recall（2–3 组词，三组皆空方算无记忆）：
  1) rsrs recall "<组件+症状>" --titles --json
  2) rsrs recall "<报错原文片段>" --titles --json
  3) rsrs recall "<环境名>" --titles --json
命中则循既证之法，弃法须陈三；未命中先读现场、立假设、最小步验证，禁无假设连试，两试无进展即停手，三试受阻须三件齐备（卡点＋已试诸法＋当前假设）。`
}

function obstacleRepeatNotice(count: number, windowSec: number, failure: string): string {
  return `【respire · 遇障先翻忆 · 重复失败 ×${count}】同一错误签名在 ${windowSec} 秒内出现第 ${count} 次：
"${failure.slice(0, 300)}"
这极可能是已有记忆覆盖的坑：禁止同法继续重试。先执行
  rsrs recall "<报错原文片段>" --titles --json
再按命中记录行动；三组关键词皆空则按受阻三件（卡点＋已试诸法＋当前假设）回报，不得空手抛问。`
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
  on(event: 'tools/post-execute', listener: (exec: MemoryExecution, result: unknown, next: () => Promise<ToolDecision>) => Promise<ToolDecision>): unknown
}

export function apply(ctx: Context, options: Config = {}): void {
  const config = { enabled: true, rsrsPath: 'rsrs', recallLimit: 5, recallThreshold: 0,
    budgetChars: 1500, minPromptChars: 2, storeNudgeEvery: 1, goalRecall: 'first' as GoalRecall,
    goalRecallEvery: 1, goalNudgeEvery: 0, rulesLocale: 'en' as RulesLocale, timeoutMs: 20000,
    obstacleRecall: true, obstacleWindowSec: 300, obstacleRepeat: 2,
    obstacleHoldWrites: false, obstacleHoldAfter: 3, obstacleHoldTtlSec: 1800, ...options }
  for (const [key, minimum, maximum] of [
    ['recallLimit', 1, 20], ['budgetChars', 200, 20000], ['minPromptChars', 1, 1000],
    ['storeNudgeEvery', 0, 1000], ['goalRecallEvery', 1, 1000], ['goalNudgeEvery', 0, 1000],
    ['timeoutMs', 1, 120000],
    ['obstacleWindowSec', 10, 3600], ['obstacleRepeat', 2, 10],
    ['obstacleHoldAfter', 2, 20], ['obstacleHoldTtlSec', 60, 86400],
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < minimum || config[key] > maximum) {
      throw new TypeError(`respire: invalid ${key}`)
    }
  }
  if (!['off', 'first', 'every'].includes(config.goalRecall)) throw new TypeError('respire: invalid goalRecall')
  if (!['en', 'zh', 'bilingual'].includes(config.rulesLocale)) throw new TypeError('respire: invalid rulesLocale')
  if (!Number.isFinite(config.recallThreshold) || config.recallThreshold < 0 || config.recallThreshold > 1) {
    throw new TypeError('respire: invalid recallThreshold')
  }
  if (!config.rsrsPath.trim()) throw new TypeError('respire: rsrsPath must not be empty')
  if (typeof config.obstacleRecall !== 'boolean' || typeof config.obstacleHoldWrites !== 'boolean') {
    throw new TypeError('respire: invalid obstacleRecall/obstacleHoldWrites')
  }
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
    // A recall observation clears the L3 hold (read/show deliberately does not:
    // the whole point is forcing an actual recall before the next write).
    if (typeof command === 'string' && /\brecall\b/.test(command)
      && /(?:^|[\s/\\'"=])(?:rsrs|respire)(?:\.exe|\.cmd)?(?:\s|$)/i.test(command)) {
      const obstacle = exec.agent ? stateOf(exec.agent).obstacle : undefined
      if (obstacle) { obstacle.consecutive = 0; obstacle.holdSince = undefined }
    }
    const write = memoryWrite(command, config.rsrsPath, shellOf(exec))
    if (!write) return decision
    let reason = write.reason
    // L3 (obstacleHoldWrites, default off): after consecutive failures reach the
    // threshold, hold rsrs writes until one recall; TTL expiry releases lazily here.
    if (!reason && config.obstacleHoldWrites && exec.agent) {
      const obstacle = stateOf(exec.agent).obstacle
      if (obstacle?.holdSince !== undefined) {
        if (Date.now() - obstacle.holdSince >= config.obstacleHoldTtlSec * 1000) {
          obstacle.holdSince = undefined
          obstacle.consecutive = 0
        } else {
          reason = '【respire 拦截】连续失败已达阈值，写操作暂缓：先执行 rsrs recall "<组件+症状>" --titles --json（2–3 组词）确认无既有记忆，再重试写入。read/show 不算解除；obstacleHoldWrites 关闭或 TTL 到期后自动放行。'
        }
      }
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

  // Obstacle-recall hard mechanism (L1/L2): observe final outcomes here. Denied
  // calls reach this waterfall as well, so the plugin's own guard denials count —
  // exactly the loop this mechanism exists to break. Classification is shape-tolerant
  // (result param OR downstream decision); `tools/result` (observe-only) stays the
  // documented fallback if a future Harness stops routing denials through here.
  toolHost.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!exec.agent || (!config.obstacleRecall && !config.obstacleHoldWrites)) return downstream
    const state = stateOf(exec.agent)
    const obstacle = state.obstacle ?? (state.obstacle = { recent: [], consecutive: 0 })
    const now = Date.now()
    obstacle.recent = obstacle.recent.filter(entry => now - entry.at <= config.obstacleWindowSec * 1000)
    const failure = obstacleFailure(result, downstream)
    if (!failure) {
      obstacle.consecutive = 0
      return downstream
    }
    const sig = obstacleSignature(exec, failure, commandOf(exec))
    obstacle.consecutive++
    const hits = obstacle.recent.filter(entry => entry.sig === sig).length + 1
    obstacle.recent.push({ sig, at: now })
    if (config.obstacleHoldWrites && obstacle.holdSince === undefined
      && obstacle.consecutive >= config.obstacleHoldAfter) obstacle.holdSince = now
    if (config.obstacleRecall) {
      const level = hits >= config.obstacleRepeat ? 2 : 1
      if (!obstacle.pending || level > obstacle.pending.level) {
        obstacle.pending = { level, text: level === 2
          ? obstacleRepeatNotice(hits, config.obstacleWindowSec, failure.text)
          : obstacleNotice(exec.name, failure.text) }
      }
    }
    return downstream
  })

  ctx.systemPrompt.section({ name: 'respire:rules', order: 850, text: config.rulesLocale === 'zh' ? RULES_ZH : config.rulesLocale === 'bilingual' ? RULES + '\n\n' + RULES_ZH : RULES, interpolate: false })

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
    // L1/L2 injection: deliver any pending obstacle reminder on the next step.
    if (state.obstacle?.pending) {
      additions.push(contextMessage(state.obstacle.pending.text))
      state.obstacle.pending = undefined
    }
    const combined = AbortSignal.any([signal, lifetime.signal])
    const call = async (args: string[]) => {
      const cwd = await ctx.workingDirectory.ensure(agent, combined)
      return runRsrs(ctx.subprocess, config.rsrsPath, ['--client-only', ...args, '--json'], cwd, combined, config.timeoutMs)
    }

    const ensureStatus = async (): Promise<void> => {
      if (state.checked) return
      state.checked = true
      try {
        const status = await call(['status'])
        state.ready = status.status === 'ok'
        const summary = record(status.summary)
        if (record(summary?.session)?.has_session === false) additions.push(contextMessage('【respire · status】Not signed in. Configure the account and sync per the rsrs status output.'))
        if (typeof summary?.local_alive === 'number' && summary.local_alive < 10) additions.push(contextMessage('【respire · status】The store has few records; empty recall may be normal. Explicitly save confirmed project agreements; the semantic model is configured by rsrs as needed.'))
        if (summary?.unlocked === false) additions.push(contextMessage('【respire · status】The store is locked. Ask the user to unlock it via the rsrs interactive flow; never collect passwords.'))
      } catch (error) {
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
        if (state.obstacle) { state.obstacle.consecutive = 0; state.obstacle.holdSince = undefined }
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
