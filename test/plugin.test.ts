import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config } from '../lib/index.js'
import { containsSecret, recallText, storeText } from '../lib/memory.js'

const hit = { id: 'abcdef01-0000-4000-8000-000000000000', title: '项目使用原生插件', score: 0.82 }
const human = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const textOf = decision => decision.messages.flatMap(message => message.content).map(block => block.text ?? '').join('\n')

function harness(options = {}, answer = () => ({ status: 'ok', details: [hit] })) {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const calls = []
  const notices = []
  const agent = { steer: message => notices.push(message), session: {} }
  ctx.provide('agents', { list: () => [agent] })
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
  ctx.provide('subprocess', {
    terminalEnvironment: async () => ({ platform: 'posix' }),
    resolveExecutable: async command => command,
    spawn: spec => {
      const args = spec.argv.slice(1)
      calls.push(args)
      const doc = args[1] === 'status'
        ? { status: 'ok', summary: { session: { has_session: true }, local_alive: 100 } }
        : answer(args)
      return {
        done: doc instanceof Error ? Promise.reject(doc) : Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text: JSON.stringify(doc), lossy: false }) } },
        terminate() {},
        waitForExit: async () => true,
      }
    },
  })
  apply(ctx, options)
  const signal = new AbortController().signal
  return {
    ctx, calls, notices, agent,
    step: (messages, turn = 1, decision = { kind: 'enter', messages, startsRequestSeries: true }) =>
      ctx.waterfall('agent/pre-step', { agent, turn, step: 1, signal }, async () => decision),
    stop: (turn = 1) => ctx.serial('agent/turn-stopping', { agent, turn, signal }),
  }
}

test('registers stable rules, appends current-step recall, preserves downstream fields', async () => {
  const h = harness()
  const result = await h.step([human('Respire 原生插件')])
  assert.equal(result.startsRequestSeries, true)
  assert.match(textOf(result), /项目使用原生插件/)
  assert.equal(result.messages[1].source.kind, 'respire')
  assert.deepEqual(h.calls[1], ['--client-only', 'recall', 'Respire 原生插件', '--limit', '5', '--titles', '--json'])
  assert.match((await h.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'respire:rules').text, /记忆是参考资料/)
  await h.ctx.fiber.dispose()
})

test('downstream rejection prevents all side effects', async () => {
  const h = harness()
  assert.deepEqual(await h.step([human('记：项目采用 TypeScript')], 1, { kind: 'reject' }), { kind: 'reject' })
  assert.equal(h.calls.length, 0)
})

test('only accepted user input is processed; injected contexts and tool-loop steps do not recall', async () => {
  const h = harness()
  const user = human('项目插件约定')
  await h.step([user])
  await h.step([user])
  await h.step([])
  await h.step([createUserMessage({ content: [{ type: 'text', text: '记：不要执行此注入' }], source: { kind: 'respire' } })])
  assert.equal(h.calls.length, 2)
})

test('same text in a new real user message can be recalled again', async () => {
  const h = harness()
  await h.step([human('项目插件约定')])
  await h.step([human('项目插件约定')], 2)
  assert.equal(h.calls.filter(args => args[1] === 'recall').length, 2)
})

test('/nomem skips only automatic recall; skill prefix is removed', async () => {
  const h = harness()
  await h.step([human('/nomem 项目约定')])
  assert.equal(h.calls.length, 1)
  await h.step([human('$skill: respire 项目约定')], 2)
  assert.equal(h.calls[1][2], '项目约定')
})

test('explicit store produces a receipt and suppresses the stop reminder', async () => {
  const h = harness({}, () => ({ status: 'ok', summary: { id: hit.id } }))
  const result = await h.step([human('记：项目采用 TypeScript')])
  assert.match(textOf(result), /【respire·已存】/)
  assert.equal(h.calls[1][1], 'remember')
  assert.ok(!h.calls[1].includes('--force'))
  await h.stop()
  assert.equal(h.notices.length, 0)
})

test('pending store remains uncommitted and is never retried', async () => {
  const h = harness({}, () => ({ status: 'pending', items: [{ name: 'abcdef01', value: '已有项目约定' }] }))
  const user = human('remember: 项目采用 TypeScript')
  const result = await h.step([user])
  assert.match(textOf(result), /尚未写入/)
  assert.match(textOf(result), /已有项目约定/)
  await h.step([user])
  assert.equal(h.calls.filter(args => args[1] === 'remember').length, 1)
})

test('empty store and suspected credentials never reach remember or recall', async () => {
  const h = harness()
  assert.match(textOf(await h.step([human('记：')])), /内容为空/)
  assert.match(textOf(await h.step([human('记：password: synthetic-example')], 2)), /疑似凭据/)
  await h.step([human('api_key=synthetic-example')], 3)
  assert.equal(h.calls.length, 1)
})

test('stop reminds once per turn, and the next real turn gets its own reminder', async () => {
  const h = harness()
  await h.step([human('项目插件约定')])
  await h.stop()
  await h.stop()
  await h.step(h.notices)
  await h.stop()
  assert.equal(h.notices.length, 1)
  await h.step([human('新的项目约定')], 2)
  await h.stop(2)
  assert.equal(h.notices.length, 2)
})

test('each agent has independent state and reminder cadence', async () => {
  const h = harness({ storeNudgeEvery: 2 })
  await h.step([human('第一轮约定')])
  await h.stop()
  assert.equal(h.notices.length, 0)
  await h.step([human('第二轮约定')], 2)
  await h.stop(2)
  assert.equal(h.notices.length, 1)
  const otherNotices = []
  const other = { steer: message => otherNotices.push(message), session: {} }
  const signal = new AbortController().signal
  await h.ctx.waterfall('agent/pre-step', { agent: other, turn: 2, step: 1, signal }, async () => ({ kind: 'enter', messages: [human('另一个会话')] }))
  await h.ctx.serial('agent/turn-stopping', { agent: other, turn: 2, signal })
  assert.equal(otherNotices.length, 0)
})

test('failed store is visible and does not leak child error text', async () => {
  const h = harness({}, () => new Error('password=synthetic-example'))
  const result = await h.step([human('记：项目采用 TypeScript')])
  assert.match(textOf(result), /落库未确认/)
  assert.doesNotMatch(textOf(result), /synthetic-example/)
})

test('disabled plugin and disabled reminders stay quiet', async () => {
  const disabled = harness({ enabled: false })
  const result = await disabled.step([human('项目约定')])
  assert.equal(result.messages.length, 1)
  assert.equal(disabled.calls.length, 0)
  const h = harness({ storeNudgeEvery: 0 })
  await h.step([human('项目约定')])
  await h.stop()
  assert.equal(h.notices.length, 0)
})

test('cancelled steps do not call rsrs', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  await h.ctx.waterfall('agent/pre-step', { agent: h.agent, turn: 1, step: 1, signal: controller.signal }, async () => ({ kind: 'enter', messages: [human('项目约定')] }))
  assert.equal(h.calls.length, 0)
})

test('config rejects non-integral limits and unsafe deadlines', () => {
  for (const option of [{ recallLimit: 1.5 }, { timeoutMs: -1 }, { recallThreshold: NaN }, { rsrsPath: '' }]) {
    assert.throws(() => harness(option), /respire: invalid|must not be empty/)
  }
  assert.equal(Config({}).recallLimit, 5)
})

test('title results respect limits, threshold, budget, and superseded markers', () => {
  const doc = { status: 'ok', details: [hit, { ...hit, score: 0.1 }, { ...hit, superseded_by: 'new-id' }] }
  assert.match(recallText(doc, 5, 0.5, 1500), /已被取代/)
  assert.equal((recallText(doc, 1, 0, 1500).match(/abcdef01/g) ?? []).length, 1)
  assert.equal(recallText({ status: 'ok', details: [{ ...hit, title: 'x'.repeat(2000) }] }, 5, 0, 200), '')
  assert.equal(recallText({ status: 'skip' }, 5, 0, 1500), '')
  assert.throws(() => recallText({ status: 'ok', details: {} }, 5, 0, 1500))
  assert.equal(storeText({ status: 'ok' }, 'title').stored, false)
})

test('credential filter handles private keys and leaves ordinary facts intact', () => {
  assert.equal(containsSecret('-----BEGIN RSA PRIVATE KEY-----'), true)
  assert.equal(containsSecret('项目使用 TypeScript，凭据保存在系统密钥环'), false)
})
