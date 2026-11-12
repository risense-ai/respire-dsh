import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config } from '../lib/index.js'
import { containsSecret, recallText, storeText } from '../lib/memory.js'

const hit = { id: 'abcdef01-0000-4000-8000-000000000000', title: '项目使用原生插件', score: 0.82 }
const human = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const goal = (text, round = 1, revision = 1, goalId = 'goal-1') => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'goal', goalId, revision, round },
})
const goalRound = (objective, round = 1, max = 10) => `<goal_round>\nObjective: ${JSON.stringify(objective)}\nRound: ${round}/${max}\n\nContinue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative.\n</goal_round>`
const textOf = decision => decision.messages.flatMap(message => message.content).map(block => block.text ?? '').join('\n')

// answer() returns a receipt document (exit 0), { exitCode, doc } for a non-zero exit, or an Error.
function replyOf(value) {
  if (value instanceof Error) return { error: value, exitCode: 0, doc: null }
  if (value && typeof value === 'object' && typeof value.exitCode === 'number' && 'doc' in value) return value
  return { error: null, exitCode: 0, doc: value }
}

function harness(options = {}, answer = () => ({ status: 'ok', details: [hit] }), goals?: () => { id: string, revision: number, objective: string } | undefined) {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const calls = []
  const notices = []
  const guards = [], dispatched = []
  const agent = { steer: message => notices.push(message), session: {} }
  ctx.provide('tools', { guard: check => { guards.push(check); return () => guards.splice(guards.indexOf(check), 1) } })
  ctx.provide('agents', { list: () => [agent] })
  if (goals) ctx.provide('goals', { get: goals })
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
      const exec = { name, arguments: command && typeof command === 'object' ? command : { [name === 'terminal_send' ? 'text' : 'command']: command }, agent, signal }
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
  assert.equal(result.messages[1].source.form, 'notice')
  assert.equal(result.messages[1].source.summary, 'Memory: 1 found')
  assert.match(result.messages[1].content[0].text, /^Memory: 1 found\n/)
  const rules = (await h.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'respire:rules').text
  for (const phrase of ['strict JSON', 'omit every status label from the response body', 'independent native notice', 'Only AFTER successfully reading a record body and actually using it', '[basis]', '[ref]', '[history]', 'Default to [ref]', 'not its execution', 'cannot alone upgrade it to [basis]', 'most conservative role', 'DO NOT invent IDs', 'extend an ambiguous prefix', '24 Unicode characters', '(untitled)', '(title hidden)', 'DO NOT show bodies, full IDs', 'Memory: unused', 'not independent plugin measurement', 'DO NOT invent Last save']) assert.ok(rules.includes(phrase), phrase)
  assert.deepEqual(h.calls[1], ['--client-only', 'recall', 'Respire 原生插件', '--limit', '5', '--titles', '--json'])
  assert.match((await h.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'respire:rules').text, /Memory is reference material/)
  const parent = hit.id
  const gate = harness({}, args => {
    assert.deepEqual(args, ['--client-only', 'show', parent, '--json'])
    return { status: 'ok', summary: { id: parent }, details: { entry: { id: parent, content: 'Existing parent' } } }
  })
  const unsafe = [
    'rsrs remember fact --importance important',
    "bash -c 'rsrs remember fact --importance important --force'",
    "bash -lic 'rsrs remember fact --importance important --force'",
    "pwsh -NoProfile -ExecutionPolicy Bypass -Command 'rsrs remember fact --importance important --force'",
    'pwsh -Command rsrs remember fact --importance important --force',
    `bash -c 'rsrs remember fact --importance important --parent ${parent}'`,
    `rsrs recall "$(rsrs remember fact --importance important --parent ${parent})"`,

    "pwsh -Command 'rsrs remember fact --importance important --force'",
    "powershell.exe -Command 'rsrs remember fact --importance important --force'",
    'RSRS_CLIENT_ONLY=1 rsrs remember fact --importance important --force',
    'echo "$(rsrs remember fact --importance important --force)"',
    'rsrs recall "$(rsrs remember fact --importance important --force)"',
    'echo "$(echo "$(rsrs remember fact --importance important --force)")"',
    "echo ok\nrsrs remember fact --importance important --force",

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
  assert.equal((await gate.tool('bash', 'echo `rsrs remember fact --importance important --force`')).kind, 'deny')
  assert.equal((await gate.tool('pwsh', String.raw`echo "\$(rsrs remember fact --importance important --force)"`)).kind, 'deny')
  for (const name of ['memory_remember', 'memory_update', 'mcp__renamed__memory_remember', 'mcp__other__memory_update']) {
    const denied = await gate.tool(name, { content: 'fact', importance: 'trivial', parent }, true)
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /target library cannot be verified/)
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
  for (const command of ['rsrs show abcdef01 --json', 'rsrs recall remember --titles --json', 'rsrs >out recall remember --titles', '2>/dev/null rsrs recall remember --titles', 'rsrs recall rsrs --project remember', 'echo rsrs remember --importance important', 'rsrs --json --client-only recall remember --titles', 'rsrs --model-task-id remember --json --client-only recall remember', 'echo \'rsrs remember fact --importance important\'', 'echo ordinary', "bash -c 'rsrs recall remember --titles'", "pwsh -NoProfile -Command 'rsrs recall remember --titles'", 'echo "rsrs remember fact --importance important --force"', "echo '$(rsrs remember fact --importance important --force)'", "rsrs recall 'rsrs remember fact --importance important --force'", "rsrs recall 'bash -c rsrs remember fact'", "bash -c 'echo rsrs remember fact'", 'RSRS_CLIENT_ONLY=1 rsrs recall remember --titles',  `rsrs update ${parent} --content 'fact'`, 'rsrs remember diary --importance trivial']) {
    assert.equal((await gate.tool('bash', command)).kind, 'allow', command)
  }
  assert.equal((await gate.tool('pwsh', 'echo `rsrs remember fact --importance important --force`')).kind, 'allow')
  assert.equal((await gate.tool('bash', String.raw`echo "\$(rsrs remember fact --importance important --force)"`)).kind, 'allow')
  for (const name of ['memory_recall', 'mcp__other__memory_show', 'mcp__other__unrelated', 'memory_remember_extra']) {
    assert.equal((await gate.tool(name, { query: 'remember' })).kind, 'allow')
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
  for (const command of [`rsrs update ${target} --importance important`, `rsrs update --importance important ${target}`, `rsrs update --importance=important ${target}`]) {
    const before = promotion.calls.length
    assert.equal((await promotion.tool('pwsh', command)).kind, 'allow')
    assert.deepEqual(promotion.calls.slice(before).map(args => args[2]), [target, parent])
  }
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
  const skipped = await h.step([human('/nomem 项目约定')])
  assert.equal(skipped.messages.at(-1).source.summary, 'Memory: skipped')
  assert.equal(skipped.messages.at(-1).source.form, 'notice')
  assert.equal(h.calls.length, 1)
  await h.step([human('$skill: respire 项目约定')], 2)
  assert.equal(h.calls[1][2], '项目约定')
})

test('explicit prefix delegates curation without writing and leaves the reminder available', async () => {
  const h = harness({}, () => assert.fail('prefix must not call remember or recall'))
  const result = await h.step([human('记：项目采用 TypeScript')])
  const text = textOf(result)
  assert.equal(result.messages.at(-1).source.summary, 'Save: needs review')
  assert.equal(result.messages.at(-1).source.form, 'notice')
  assert.match(text, /Save: needs review/)
  assert.doesNotMatch(text, /Last save:|Earlier save:|Save: verified|Used:/)
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
  const empty = await h.step([human('记：')])
  assert.match(textOf(empty), /content is empty|The content is empty/)
  assert.equal(empty.messages.at(-1).source.summary, 'Save: needs review')
  const secret = await h.step([human('记：password: synthetic-example')], 2)
  assert.match(textOf(secret), /contains a credential/)
  assert.equal(secret.messages.at(-1).source.summary, 'Save: needs review')
  const skipped = await h.step([human('api_key=synthetic-example')], 3)
  assert.equal(skipped.messages.at(-1).source.summary, 'Memory: skipped')
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
  assert.equal(h.notices[0].source.form, undefined, 'status must not create another visible stop notice')
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

test('title results respect limits, threshold, budget, and superseded markers', async () => {
  const doc = { status: 'ok', details: [hit, { ...hit, score: 0.1 }, { ...hit, superseded_by: 'new-id' }] }
  const sensitive = { ...hit, id: '12345678-0000-4000-8000-000000000000', title: 'api_key=' + 'PRIVATE_TITLE_CANARY'.repeat(150) }
  assert.equal(containsSecret(sensitive.title), true)
  const safe = recallText({ status: 'ok', details: [sensitive, hit] }, 1, 0, 500)
  assert.equal(safe.count, 1, 'sensitive titles consume neither result limit nor budget')
  assert.ok(safe.text.includes(hit.title) && safe.text.includes(hit.id.slice(0, 8)))
  assert.doesNotMatch(safe.text, /PRIVATE_TITLE_CANARY|12345678/)
  assert.match(recallText(doc, 5, 0.5, 1500).text, /superseded/)
  assert.equal(recallText(doc, 5, 0.5, 1500).count, 2)
  assert.equal((recallText(doc, 1, 0, 1500).text.match(/abcdef01/g) ?? []).length, 1)
  assert.equal(recallText(doc, 1, 0, 1500).count, 1)
  assert.deepEqual(recallText({ status: 'ok', details: [{ ...hit, title: 'x'.repeat(2000) }] }, 5, 0, 200), { text: '', count: 0 })
  assert.deepEqual(recallText({ status: 'skip' }, 5, 0, 1500), { text: '', count: 0 })
  assert.throws(() => recallText({ status: 'ok', details: {} }, 5, 0, 1500))
  assert.equal(storeText({ status: 'ok' }, 'title').stored, false)
  for (const [response, options, summary] of [
    [doc, { recallLimit: 1 }, 'Memory: 1 found'],
    [{ status: 'ok', details: [sensitive, hit] }, { recallLimit: 1, budgetChars: 500 }, 'Memory: 1 found'],
    [{ status: 'ok', details: [sensitive] }, {}, 'Memory: no match'],
    [doc, { recallThreshold: 0.5 }, 'Memory: 2 found'],
    [doc, { recallThreshold: 0.9 }, 'Memory: no match'],
    [{ status: 'ok', summary: { count: 999 }, details: [] }, {}, 'Memory: no match'],
    [{ status: 'ok', details: [{ ...hit, id: 'invalid' }] }, {}, 'Memory: no match'],
    [{ status: 'ok', details: [{ ...hit, title: 'x'.repeat(2000) }] }, { budgetChars: 200 }, 'Memory: no match'],
    [{ status: 'skip', summary: { count: 0 } }, {}, 'Memory: no match'],
    [{ status: 'skip' }, {}, 'Memory: skipped'],
    [{ status: 'skip', summary: { count: 999 } }, {}, 'Memory: skipped'],
    [doc, { minPromptChars: 100 }, 'Memory: skipped'],
    [{ status: 'ok', details: {} }, {}, 'Memory: unavailable'],
    [new Error('private diagnostics'), {}, 'Memory: unavailable'],
  ]) {
    const fixture = harness(options, () => response)
    const result = await fixture.step([human('recall project agreement')])
    const notices = result.messages.filter(message => message.source.kind === 'respire' && message.source.form === 'notice')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].source.summary, summary)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TITLE_CANARY|12345678/, 'sensitive candidates must not reach injected messages or notice metadata')
    assert.ok(notices[0].content[0].text.startsWith(summary + '\n'))
    assert.doesNotMatch(notices[0].content[0].text, /private diagnostics|Used:|Last save:|Save: verified/)
    assert.ok(fixture.calls.every(args => ['status', 'recall'].includes(args[1])))
    if (summary.includes('found')) assert.ok(notices[0].content[0].text.length <= (options.budgetChars ?? 1500))
    await fixture.ctx.fiber.dispose()
  }
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
    assert.deepEqual(recallText({ status: 'ok', details: [{ ...hit, id }] }, 5, 0, 1500), { text: '', count: 0 })
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

test('goal rounds recall through the goal service and dedupe by goal revision', async () => {
  let view = { id: 'goal-1', revision: 1, objective: '修复文档门禁' }
  const h = harness({ goalRecall: 'first' }, () => ({ status: 'ok', details: [hit] }), () => view)
  const first = await h.step([goal(goalRound('修复文档门禁', 1), 1)])
  assert.equal(first.startsRequestSeries, true)
  assert.match(textOf(first), /项目使用原生插件/)
  assert.equal(first.messages.at(-1).source.summary, 'Memory: 1 found')
  const recalls = () => h.calls.filter(args => args[1] === 'recall')
  assert.equal(recalls().length, 1)
  assert.equal(recalls()[0][2], '修复文档门禁')
  await h.step([goal(goalRound('修复文档门禁', 2), 2)], 2)
  assert.equal(recalls().length, 1, 'the same goal revision must not recall twice')
  view = { id: 'goal-1', revision: 2, objective: '修复文档门禁' }
  await h.step([goal(goalRound('修复文档门禁', 1), 1, 2)], 3)
  assert.equal(recalls().length, 2, 'a new revision must recall again')
  assert.equal(recalls()[1][2], '修复文档门禁')
  await h.ctx.fiber.dispose()
})

test('goalRecall off keeps goal rounds out of the engine', async () => {
  const h = harness({ goalRecall: 'off' }, () => assert.fail('goal rounds must not query the engine'),
    () => ({ id: 'goal-1', revision: 1, objective: 'x' }))
  const result = await h.step([goal(goalRound('x', 1), 1)])
  assert.equal(result.messages.length, 1)
  assert.equal(h.calls.length, 0)
  await h.ctx.fiber.dispose()
})

test('goalRecall every recalls round 1 and every N rounds', async () => {
  const h = harness({ goalRecall: 'every', goalRecallEvery: 2 }, () => ({ status: 'ok', details: [hit] }),
    () => ({ id: 'goal-1', revision: 1, objective: '持续目标' }))
  for (const round of [1, 2, 3, 4]) await h.step([goal(goalRound('持续目标', round), round)], round)
  const queries = h.calls.filter(args => args[1] === 'recall').map(args => args[2])
  assert.deepEqual(queries, ['持续目标', '持续目标', '持续目标'])
  await h.ctx.fiber.dispose()
})

test('goal rounds parse the retained objective when no goal service is mounted', async () => {
  const h = harness({ goalRecall: 'first' }, () => ({ status: 'ok', details: [hit] }))
  const result = await h.step([goal(goalRound('回退目标', 1), 1)])
  assert.match(textOf(result), /项目使用原生插件/)
  const recalls = h.calls.filter(args => args[1] === 'recall')
  assert.equal(recalls.length, 1)
  assert.equal(recalls[0][2], '回退目标')
  await h.ctx.fiber.dispose()
})

test('credential-like goal objectives are skipped without an engine call', async () => {
  const h = harness({ goalRecall: 'first' }, () => assert.fail('secret objective must not recall'),
    () => ({ id: 'goal-1', revision: 1, objective: 'api_key=sk-abcdefghijklmnop' }))
  const result = await h.step([goal(goalRound('api_key=sk-abcdefghijklmnop', 1), 1)])
  assert.equal(result.messages.at(-1).source.summary, 'Memory: skipped')
  assert.deepEqual(h.calls.map(args => args[1]), ['status'])
  await h.ctx.fiber.dispose()
})

test('goal nudge is opt-in and throttled', async () => {
  const view = () => ({ id: 'goal-1', revision: 1, objective: '目标' })
  const off = harness({ goalRecall: 'first', goalNudgeEvery: 0 }, () => ({ status: 'ok', details: [hit] }), view)
  await off.step([goal(goalRound('目标', 1), 1)])
  await off.stop(1)
  assert.equal(off.notices.length, 0)
  await off.ctx.fiber.dispose()

  const on = harness({ goalRecall: 'first', goalNudgeEvery: 1 }, () => ({ status: 'ok', details: [hit] }), view)
  await on.step([goal(goalRound('目标', 1), 1)])
  await on.stop(1)
  assert.equal(on.notices.length, 1)
  assert.match(on.notices[0].content[0].text, /goal wrap-up check/)
  await on.ctx.fiber.dispose()

  const every2 = harness({ goalRecall: 'first', goalNudgeEvery: 2 }, () => ({ status: 'ok', details: [hit] }), view)
  await every2.step([goal(goalRound('目标', 1), 1)], 1)
  await every2.stop(1)
  assert.equal(every2.notices.length, 0)
  await every2.step([goal(goalRound('目标', 2), 2)], 2)
  await every2.stop(2)
  assert.equal(every2.notices.length, 1)
  await every2.ctx.fiber.dispose()
})

test('rejected goal steps do not recall', async () => {
  const h = harness({ goalRecall: 'first' }, () => assert.fail('rejected step must not query the engine'),
    () => ({ id: 'goal-1', revision: 1, objective: 'x' }))
  assert.deepEqual(await h.step([goal(goalRound('x', 1), 1)], 1, { kind: 'reject' }), { kind: 'reject' })
  assert.equal(h.calls.length, 0)
  await h.ctx.fiber.dispose()
})

// --- Obstacle-recall hooks (T15: L1/L2 detection + L3 hold) ---------------

const obstacleExec = (h, command = 'grep pattern missing-file') => ({
  name: 'bash', arguments: { command }, agent: h.agent, signal: new AbortController().signal,
})
const failOnce = (h, text = 'grep: missing-file: No such file or directory\n[exit code: 2]') =>
  h.ctx.waterfall('tools/post-execute', obstacleExec(h),
    { kind: 'allow', isError: false, content: [{ type: 'text', text }] },
    async () => ({ kind: 'allow' }))

test('obstacle recall: a failed tool call injects the next-step reminder', async () => {
  const h = harness({})
  await failOnce(h)
  const text = textOf(await h.step([human('继续排查这个报错')]))
  assert.match(text, /遇障先翻忆/)
  assert.doesNotMatch(text, /重复失败/)
  await h.ctx.fiber.dispose()
})

test('obstacle recall: repeat warning fires only inside the configured window', async () => {
  const h = harness({})
  await failOnce(h)
  const first = textOf(await h.step([human('第一次失败后')]))
  assert.match(first, /遇障先翻忆/)
  assert.doesNotMatch(first, /重复失败/)

  const realNow = Date.now
  try {
    let offset = 0
    Date.now = () => realNow.call(Date) + offset
    offset = 400_000 // beyond obstacleWindowSec=300 → the earlier signature is pruned
    await failOnce(h)
    const expired = textOf(await h.step([human('窗口外第二次')]))
    assert.match(expired, /遇障先翻忆/)
    assert.doesNotMatch(expired, /重复失败/)
    offset += 1_000 // same signature again, now inside the window → L2
    await failOnce(h)
    const repeated = textOf(await h.step([human('窗口内第三次')]))
    assert.match(repeated, /重复失败 ×2/)
  } finally {
    Date.now = realNow
  }
  await h.ctx.fiber.dispose()
})

test('obstacle recall: L3 hold blocks writes until an actual recall', async () => {
  const h = harness({ obstacleHoldWrites: true, obstacleHoldAfter: 2, obstacleRecall: false })
  await failOnce(h, 'boom\n[exit code: 1]')
  await failOnce(h, 'boom\n[exit code: 1]')
  const held = await h.tool('bash', 'rsrs remember diary --importance trivial')
  assert.equal(held.kind, 'deny')
  assert.match(held.reason, /暂缓/)
  // L3 alone (obstacleRecall off) must not inject L1/L2 reminders
  assert.doesNotMatch(textOf(await h.step([human('尝试继续')])), /遇障先翻忆/)
  // an actual recall releases the hold; read/show would not
  assert.equal((await h.tool('bash', 'rsrs recall remember --titles --json')).kind, 'allow')
  assert.equal((await h.tool('bash', 'rsrs remember diary --importance trivial')).kind, 'allow')
  await h.ctx.fiber.dispose()
})

test('obstacle recall: L3 hold expires after its TTL without a recall', async () => {
  const h = harness({ obstacleHoldWrites: true, obstacleHoldAfter: 2, obstacleHoldTtlSec: 1800, obstacleRecall: false })
  await failOnce(h, 'boom\n[exit code: 1]')
  await failOnce(h, 'boom\n[exit code: 1]')
  assert.equal((await h.tool('bash', 'rsrs remember diary --importance trivial')).kind, 'deny')
  const realNow = Date.now
  try {
    Date.now = () => realNow.call(Date) + 1_801_000
    assert.equal((await h.tool('bash', 'rsrs remember diary --importance trivial')).kind, 'allow')
  } finally {
    Date.now = realNow
  }
  await h.ctx.fiber.dispose()
})
