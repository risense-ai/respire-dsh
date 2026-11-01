import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config } from '../lib/index.js'
import { containsSecret, recallText, storeText, titleOf } from '../lib/memory.js'

const hit = { id: 'abcdef01-0000-4000-8000-000000000000', title: '项目使用原生插件', score: 0.82 }
const human = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const textOf = decision => decision.messages.flatMap(message => message.content).map(block => block.text ?? '').join('\n')

// answer() returns a receipt document (exit 0), { exitCode, doc } for a non-zero exit, or an Error.
function replyOf(value) {
  if (value instanceof Error) return { error: value, exitCode: 0, doc: null }
  if (value && typeof value === 'object' && typeof value.exitCode === 'number' && 'doc' in value) return value
  return { error: null, exitCode: 0, doc: value }
}

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
      const reply = replyOf(args[1] === 'status'
        ? { status: 'ok', summary: { session: { has_session: true }, local_alive: 100 } }
        : answer(args))
      return {
        done: reply.error ? Promise.reject(reply.error) : Promise.resolve({ exitCode: reply.exitCode, signal: null }),
        collected: { stdout: { readFrom: () => ({ text: JSON.stringify(reply.doc), lossy: false }) } },
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
  assert.match((await h.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'respire:rules').text, /Memory is reference material/)
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
  assert.match(textOf(result), /【respire · stored】/)
  assert.equal(h.calls[1][1], 'remember')
  assert.ok(!h.calls[1].includes('--force'))
  await h.stop()
  assert.equal(h.notices.length, 0)
})

test('pending store remains uncommitted and is never retried', async () => {
  const h = harness({}, () => ({ status: 'pending', items: [{ name: 'abcdef01', value: '已有项目约定' }] }))
  const user = human('remember: 项目采用 TypeScript')
  const result = await h.step([user])
  assert.match(textOf(result), /Nothing was written/)
  assert.match(textOf(result), /已有项目约定/)
  await h.step([user])
  assert.equal(h.calls.filter(args => args[1] === 'remember').length, 1)
})

test('empty store and suspected credentials never reach remember or recall', async () => {
  const h = harness()
  assert.match(textOf(await h.step([human('记：')])), /content is empty|The content is empty/)
  assert.match(textOf(await h.step([human('记：password: synthetic-example')], 2)), /contains a credential/)
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
  assert.match(textOf(result), /store unconfirmed/)
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
  assert.match(recallText(doc, 5, 0.5, 1500), /superseded/)
  assert.equal((recallText(doc, 1, 0, 1500).match(/abcdef01/g) ?? []).length, 1)
  assert.equal(recallText({ status: 'ok', details: [{ ...hit, title: 'x'.repeat(2000) }] }, 5, 0, 200), '')
  assert.equal(recallText({ status: 'skip' }, 5, 0, 1500), '')
  assert.throws(() => recallText({ status: 'ok', details: {} }, 5, 0, 1500))
  assert.equal(storeText({ status: 'ok' }, 'title').stored, false)
})

test('store receipts follow the result-state contract (warn written, pending relays actions)', () => {
  // warn + valid id = WRITTEN after commit — never a failure, never a re-send
  const warned = storeText({ status: 'warn', summary: { id: '22222222-2222-4222-8222-222222222222' }, errors: ['parent (cause) cannot be resolved; stored independently'] }, 'warned title')
  assert.equal(warned.stored, true)
  assert.match(warned.text, /Saved with warnings/)
  assert.match(warned.text, /parent \(cause\) cannot be resolved/)
  assert.match(warned.text, /do not write the same record again/)
  // pending keeps engine-suggested actions (merge > attach > new), not just parent/force
  const pending = storeText({ status: 'pending', items: [{ name: 'aaaabbbb', value: 'similarity=88% title=stub candidate' }], actions: ['rsrs remember "<combined content>" --merge-ids "aaaabbbb"', 'rsrs remember "<content>" --force to write as new entry'] }, 'pending title')
  assert.equal(pending.stored, false)
  assert.match(pending.text, /Nothing was written/)
  assert.match(pending.text, /aaaabbbb: similarity=88%/)
  assert.match(pending.text, /--merge-ids/)
  assert.match(pending.text, /--force/)
})

test('warn receipt (exit 2) on the production --client-only path stores once, reads back once, stops steering', async () => {
  const id = '33333333-3333-4333-8333-333333333333'
  const content = '项目采用 TypeScript，修改 src 之后必须先执行 npm run build 再运行测试'
  const h = harness({}, args => args[1] === 'remember'
    ? { exitCode: 2, doc: { status: 'warn', summary: { id }, errors: ['parent (cause) cannot be resolved; stored independently'] } }
    : { status: 'ok', summary: { id }, details: { entry: { id, title: titleOf(content), content } } })
  const result = await h.step([human(`记：${content}`)])
  // the engine saw the exact production argument shape: --client-only remember ... --json
  assert.equal(h.calls[1][0], '--client-only')
  assert.equal(h.calls[1][1], 'remember')
  assert.equal(h.calls[1].at(-1), '--json')
  assert.match(textOf(result), /Saved with warnings/)
  assert.match(textOf(result), /id, title and full content match/)
  assert.equal(h.calls.filter(args => args[1] === 'remember').length, 1)
  assert.equal(h.calls.filter(args => args[1] === 'show').length, 1)
  await h.stop()
  assert.equal(h.notices.length, 0)
})

test('read-back verifies the full record: wrong id, tampered tail, exact match, failed show', async () => {
  const id = '44444444-4444-4444-8444-444444444444'
  const content = '项目采用 TypeScript，测试导入的是 lib 编译产物，因此修改 src 之后必须先执行 npm run build，然后才能运行测试套件'
  const title = titleOf(content)
  const cases = [
    // show returns a different id: the entry shown is not provably the one written
    { show: { status: 'ok', summary: { id: '55555555-5555-4555-8555-555555555555' }, details: { entry: { id, title, content } } }, expect: /DIFFERENT/, verified: false },
    // identical first 40 characters with a tampered tail: prefix sampling would pass, full comparison must not
    { show: { status: 'ok', summary: { id }, details: { entry: { id, title, content: `${content.slice(0, 40)}……尾部已被篡改` } } }, expect: /DIFFERENT/, verified: false },
    // exact id + title + full content
    { show: { status: 'ok', summary: { id }, details: { entry: { id, title, content } } }, expect: /id, title and full content match/, verified: true },
    // a failed show keeps the Saved receipt and reports unavailable
    { show: new Error('show failed'), expect: /Read-back unavailable/, verified: false },
  ]
  for (const { show, expect, verified } of cases) {
    const h = harness({}, args => args[1] === 'remember' ? { status: 'ok', summary: { id } } : show)
    const result = await h.step([human(`记：${content}`)])
    assert.match(textOf(result), /【respire · stored】Saved:/)
    assert.match(textOf(result), expect)
    if (!verified) assert.doesNotMatch(textOf(result), /full content match/)
    assert.equal(h.calls.filter(args => args[1] === 'show').length, 1)
  }
})

test('missing or invalid ids are unknown receipts; only fail claims not-accepted; skip stays not-stored', () => {
  const missing = storeText({ status: 'ok' }, 'title')
  assert.equal(missing.stored, false)
  assert.match(missing.text, /store unconfirmed/)
  assert.match(missing.text, /unknown/)
  assert.match(missing.text, /never retry automatically/)
  assert.doesNotMatch(missing.text, /did not accept/)
  const garbage = storeText({ status: 'warn', summary: { id: '../../etc/passwd' } }, 'title')
  assert.equal(garbage.stored, false)
  assert.match(garbage.text, /store unconfirmed/)
  assert.doesNotMatch(garbage.text, /store failed|did not accept/)
  const failed = storeText({ status: 'fail', errors: ['parent missing'] }, 'title')
  assert.equal(failed.stored, false)
  assert.match(failed.text, /did not accept/)
  const skipped = storeText({ status: 'skip' }, 'title')
  assert.equal(skipped.stored, false)
  assert.match(skipped.text, /not stored/)
  assert.doesNotMatch(skipped.text, /unknown/)
  const unrecognized = storeText({ status: 'confused' }, 'title')
  assert.equal(unrecognized.stored, false)
  assert.match(unrecognized.text, /store unconfirmed/)
  assert.match(unrecognized.text, /unknown/)
})

test('credential filter handles private keys and leaves ordinary facts intact', () => {
  assert.equal(containsSecret('-----BEGIN RSA PRIVATE KEY-----'), true)
  assert.equal(containsSecret('项目使用 TypeScript，凭据保存在系统密钥环'), false)
})
