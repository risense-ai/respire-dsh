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
  const guards = [], dispatched = []
  const agent = { steer: message => notices.push(message), session: {} }
  ctx.provide('tools', { guard: check => { guards.push(check); return () => guards.splice(guards.indexOf(check), 1) } })
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
    ctx, calls, notices, agent, dispatched,
    tool: async (name, command, override = false) => {
      const exec = { name, arguments: { [name === 'terminal_send' ? 'text' : 'command']: command }, agent, signal }
      let decision = await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
      if (override) decision = { kind: 'allow' }
      const denial = decision.kind === 'allow' ? guards.map(check => check(exec)).find(reason => reason !== undefined) : decision.reason
      if (denial !== undefined) return { kind: 'deny', reason: denial }
      dispatched.push(exec)
      return decision
    },
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
  const parent = hit.id
  const gate = harness({}, args => {
    assert.deepEqual(args, ['--client-only', 'show', parent, '--json'])
    return { status: 'ok', summary: { id: parent }, details: { entry: { id: parent, content: 'Existing parent' } } }
  })
  const unsafe = [
    'rsrs remember fact --importance important',
    `rsrs >out remember fact --importance important --force`,
    `rsrs --json 2>out remember fact --importance important --force`,
    `2>/dev/null rsrs remember fact --importance important --force`,
    `2>&1 rsrs remember fact --importance important --force`,
    `rsrs 2>&1 remember fact --importance important --force`,
    `rsrs remember fact --merge-ids ${parent} --importance trivial`,
    `rsrs remember 'fact --parent ${parent}' --importance important`,
    'rsrs remember fact --importance important --parent ""',
    `rsrs remember fact --importance important --force --parent ${parent}`,
    `rsrs update ${parent} --parent ""`,
    `rsrs update ${parent} --clear-parent`,
    `rsrs update ${parent} --parent none`,
    `rsrs remember fact --importance important --parent $PARENT`,
    `rsrs remember fact --importance important # --parent ${parent}`,
    `rsrs remember fact --importance important --parent ${parent}; echo done`,
    `rsrs --config missing remember fact --importance important --parent ${parent}`,
    `>out rsrs remember fact --importance important --parent ${parent}`,
    `2>out rsrs remember fact --importance important --parent ${parent}`,
    `echo $(rsrs remember fact --importance important --parent ${parent})`,
    `npx rsrs remember fact --importance important --parent ${parent}`,
    `rsrs remember @'\nfact\n'@ --importance important --parent ${parent}`,
  ]
  for (const name of ['bash', 'pwsh', 'terminal_send']) {
    for (const command of unsafe) assert.equal((await gate.tool(name, command, true)).kind, 'deny', command)
  }
  assert.equal(gate.calls.length, 0)
  assert.equal(gate.dispatched.length, 0, 'monotonic guard must survive a later allow decision')
  for (const name of ['bash', 'pwsh', 'terminal_send']) {
    assert.equal((await gate.tool(name, `rsrs --client-only remember 'fact' --importance=important --parent='${parent}' --project project --tags tags --type context --summary summary --clear-review-at`)).kind, 'allow')
  }
  for (const prefix of ['C:\\tools\\rsrs.exe', '& "C:\\Program Files\\rsrs.cmd"']) {
    assert.equal((await gate.tool('pwsh', `${prefix} remember fact --importance important --parent ${parent}`)).kind, 'allow')
  }
  assert.equal(gate.calls.length, 5)
  for (const command of ['rsrs show abcdef01 --json', 'rsrs recall remember --titles --json', 'rsrs >out recall remember --titles', '2>/dev/null rsrs recall remember --titles', 'rsrs recall rsrs --project remember', 'echo rsrs remember --importance important', 'rsrs --json --client-only recall remember --titles', 'rsrs --model-task-id remember --json --client-only recall remember', 'echo \'rsrs remember fact --importance important\'', 'echo ordinary', `rsrs update ${parent} --content 'fact'`, 'rsrs remember diary --importance trivial']) {
    assert.equal((await gate.tool('bash', command)).kind, 'allow', command)
  }
  assert.equal(gate.calls.length, 5, 'reads and updates without a parent change need no parent query')
  assert.equal((await gate.tool('bash', `rsrs remember 'fact >out --parent fake' --importance trivial --merge-ids abcdef0100004000 --parent ${parent}`)).kind, 'allow')
  const target = 'bcdef012-0000-4000-8000-000000000000'
  let attached = parent, live = true, targetStatus = 'ok'
  const promotion = harness({}, args => {
    const id = args[2]
    if (id === target && targetStatus !== 'ok') return { status: targetStatus }
    if (id === parent && !live) return { status: 'fail' }
    return { status: 'ok', summary: { id }, details: { entry: { id, content: 'Existing record', parent_id: id === target ? attached : '' } } }
  })
  assert.equal((await promotion.tool('pwsh', `rsrs update ${target} --importance important`)).kind, 'allow')
  assert.deepEqual(promotion.calls.map(args => args[2]), [target, parent])
  for (const invalid of ['', 'none', target, target.toUpperCase(), target.slice(0, 8), null, 42]) {
    attached = invalid
    const before = promotion.calls.length, bodies = promotion.dispatched.length
    const denied = await promotion.tool('bash', `rsrs update ${target} --importance important`)
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /attach this record/)
    assert.deepEqual(promotion.calls.slice(before).map(args => args[2]), [target])
    assert.equal(promotion.dispatched.length, bodies)
  }
  attached = parent; live = false
  const before = promotion.calls.length, bodies = promotion.dispatched.length
  assert.equal((await promotion.tool('terminal_send', `rsrs update ${target} --importance important`)).kind, 'deny')
  assert.deepEqual(promotion.calls.slice(before).map(args => args[2]), [target, parent])
  assert.equal(promotion.dispatched.length, bodies)
  for (const status of ['fail', 'skip']) {
    targetStatus = status
    const before = promotion.calls.length, bodies = promotion.dispatched.length
    assert.equal((await promotion.tool('bash', `rsrs update ${target} --importance important`)).kind, 'deny')
    assert.deepEqual(promotion.calls.slice(before).map(args => args[2]), [target])
    assert.equal(promotion.dispatched.length, bodies)
  }
  const absent = harness({}, () => ({ status: 'ok', summary: {}, details: {} }))
  assert.equal((await absent.tool('bash', `rsrs update ${parent} --parent ${parent}`)).kind, 'deny')
  assert.equal(absent.dispatched.length, 0)
  const failed = harness({}, () => new Error('private engine diagnostics'))
  assert.equal((await failed.tool('pwsh', `& 'C:\\tools\\rsrs.exe' remember fact --importance important --parent ${parent}`)).kind, 'deny')
  assert.equal(failed.dispatched.length, 0)
  const off = harness({ enabled: false }, () => assert.fail('disabled plugin must not query the engine'))
  assert.equal((await off.tool('bash', unsafe[0])).kind, 'allow')
  for (const fixture of [gate, promotion, absent, failed, off]) await fixture.ctx.fiber.dispose()
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

test('explicit prefix delegates curation without writing and leaves the reminder available', async () => {
  const h = harness({}, () => assert.fail('prefix must not call remember or recall'))
  const result = await h.step([human('记：项目采用 TypeScript')])
  const text = textOf(result)
  for (const phrase of ['Nothing was written', 'hook made no write request', 'you MUST read prompt and agent-config', 'show their full bodies', 'Prefer update, then an authorized merge, then attach, then a new record', 'taxonomy --list or tree', 'permitted ONLY AFTER', 'DO NOT retry automatically or claim success', 'Verification does not authorize an automatic retry', 'After every actual write, you MUST read it back with show', 'no justified parent exists, you MUST remain pending', 'DO NOT execute the engineering task']) assert.ok(text.includes(phrase), phrase)
  assert.doesNotMatch(text, /Saved:|may have been written/)
  assert.deepEqual(h.calls.map(args => args[1]), ['status'])
  await h.stop()
  assert.equal(h.notices.length, 1)
})

test('all prefixes stay pending without writes and duplicate accepted inputs are not repeated', async () => {
  const h = harness({}, () => assert.fail('prefix must not call remember or recall'))
  for (const [index, prefix] of ['记：', '存：', '记录：', '记住：', 'remember:'].entries()) {
    const user = human(`${prefix}项目采用 TypeScript`)
    assert.match(textOf(await h.step([user], index + 1)), /MUST resolve this storage request in this turn/)
    await h.step([user], index + 1)
  }
  assert.deepEqual(h.calls.map(args => args[1]), ['status'])
  assert.match((await h.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'respire:rules').text, /Hook pending does not prohibit the first policy-compliant write/)
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

test('prefix handoff does not misreport an unissued write as unknown when the engine would fail', async () => {
  const h = harness({}, () => new Error('password=synthetic-example'))
  const result = await h.step([human('记：项目采用 TypeScript')])
  assert.match(textOf(result), /store pending/)
  assert.doesNotMatch(textOf(result), /store unconfirmed|synthetic-example/)
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

test('record ids outside the engine whitelist (UUID or long hex) are unknown, never a write credential', () => {
  // dashes-only, wrong grouping/length, plain short hex, path fragments — the old loose
  // [a-f\d-]{8,} class accepted all of these as "written"
  for (const id of ['--------', 'abcd----', 'abcdef01-0000-4', 'abcdef01', '../../etc/passwd', 'abcdefgh']) {
    for (const status of ['ok', 'warn']) {
      const receipt = storeText({ status, summary: { id } }, 'title')
      assert.equal(receipt.stored, false, `${status} receipt with id ${id} must not confirm a write`)
      assert.match(receipt.text, /store unconfirmed/)
      assert.match(receipt.text, /unknown/)
      assert.doesNotMatch(receipt.text, /Saved/)
    }
    // recall hits carrying such ids are dropped instead of advertised
    assert.equal(recallText({ status: 'ok', details: [{ ...hit, id }] }, 5, 0, 1500), '')
  }
  // non-string ids stay unknown
  for (const id of [12345678, ['abcdef01-0000-4000-8000-000000000000'], { v: 1 }, null, true]) {
    const receipt = storeText({ status: 'ok', summary: { id } }, 'title')
    assert.equal(receipt.stored, false)
    assert.match(receipt.text, /store unconfirmed/)
  }
  // engine-shaped ids still pass: UUID, 16-hex, 32-hex
  assert.equal(storeText({ status: 'ok', summary: { id: 'abcdef01-0000-4000-8000-000000000000' } }, 'title').stored, true)
  assert.equal(storeText({ status: 'ok', summary: { id: 'abcdef0100004000' } }, 'title').stored, true)
  assert.equal(storeText({ status: 'warn', summary: { id: '0123456789abcdef0123456789abcdef' } }, 'title').stored, true)
})



test('credential filter handles private keys and leaves ordinary facts intact', () => {
  assert.equal(containsSecret('-----BEGIN RSA PRIVATE KEY-----'), true)
  assert.equal(containsSecret('项目使用 TypeScript，凭据保存在系统密钥环'), false)
})
