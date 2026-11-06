// 2026-10-31：补可见文本、inbox 优先、三种快照、缺栏与限次诊断回归；四组合测试随本轮七项回归运行。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mock } from 'node:test'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.consolidate-hook-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = temporaryRoot
fs.writeFileSync(join(temporaryRoot, 'dsh-memory-v2-config.json'), JSON.stringify({ 会话白名单: ['hook-test'] }))
const diagnostics = []
const writes = []
const renames = []
let failStateRename = false
let failSceneRename = false
const realAppend = fs.appendFileSync
const realWrite = fs.writeFileSync
const realRename = fs.renameSync
mock.method(fs, 'appendFileSync', (path, data, ...args) => {
  if (String(path).endsWith('/memory-v2-diag.log')) { diagnostics.push(String(data)); return }
  assert.fail('情景、状态和业务日志不应直接 appendFileSync')
  return realAppend(path, data, ...args)
})
mock.method(fs, 'writeFileSync', (path, ...args) => { writes.push(String(path)); return realWrite(path, ...args) })
mock.method(fs, 'renameSync', (source, target) => {
  if (failStateRename && String(target).endsWith('巩固状态.json')) throw new Error('模拟状态 rename 失败')
  if (failSceneRename && String(target).endsWith('.md')) throw new Error('模拟情景 rename 失败')
  renames.push([String(source), String(target)])
  return realRename(source, target)
})
syncBuiltinESMExports()

try {
  const { apply } = await import('../lib/index.js')
  const root = join(temporaryRoot, 'storages', 'dsh-memory')
  const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const day = dayOf(new Date())
  const scenePath = join(root, '情景', `${day}.md`)
  const statePath = join(root, '日志', '巩固状态.json')
  const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const original = '  原话开头\n## 11:05\n你说：这是原话里的标题，不是新轮次\n原话结尾  '
  const reply = '😀'.repeat(205)
  let snapshotFails = false
  let events = [
    { type: 'user/message', data: { message: '旧输入' } },
    { type: 'assistant/message', data: { message: '旧回复' } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: original }] } } },
    { type: 'assistant/message', data: { message: { content: reply } } },
  ]
  function harness() {
    const handlers = new Map()
    const tools = new Map()
    let context
    const disposed = []
    const agent = {
      session: { id: 'hook-test', snapshotEvents() { if (snapshotFails) throw new Error('模拟快照失败'); return events } },
      ctx: {
        tools: { register(value) { tools.set(value.name, value); return () => disposed.push(value.name) } },
        on(name, fn) { handlers.set(name, fn); return () => { disposed.push(name); handlers.delete(name) } },
        systemPrompt: {
          section() { return () => disposed.push('section') },
          context(value) { context = value; return () => disposed.push('context') },
        },
      },
    }
    const dispose = apply({
      tools: { register(value) { tools.set(value.name, value); return () => disposed.push(value.name) } },
      agents: { list: () => [agent] }, effect: (fn) => fn(),
      webServer: { register: () => () => disposed.push('stats') },
      interval: () => () => disposed.push('interval'),
    })
    return { stop: () => handlers.get('agent/turn-stopping')(), insert: (payload) => handlers.get('agent/inbox/inserted')(payload), context: () => context.text(), tools, dispose, disposed }
  }
  let h = harness()
  h.stop()
  const first = fs.readFileSync(scenePath, 'utf8')
  assert.match(first, /^## \d{2}:\d{2}\n/)
  assert.ok(first.endsWith(`你说：${original}\n我说：${reply}\n`), '用户原样保留，助手完整存档不截断')
  assert.equal(state().轮数, 1)
  assert.equal(state().cursor, 0)
  assert.equal(state().offset, 0)
  for (let i = 1; i < 9; i++) h.stop()
  assert.equal(state().轮数, 9)
  // 2026-10-31 改：门限从 >=10 改成 >0，只要没巩固就每轮都提，第 9 轮也该看得见
  assert.match(h.context(), /\[记忆\] 9 轮还没巩固。先调 memory_consolidate。/)
  h.stop()
  assert.equal(state().轮数, 10)
  assert.match(h.context(), /\[记忆\] 10 轮还没巩固（积压了）。先调 memory_consolidate。/)
  const tool = h.tools.get('memory_consolidate')
  assert.equal((await tool.execute({ rounds: 0 })).ok, false)
  assert.equal((await tool.execute({ rounds: 1.5 })).ok, false)
  assert.equal((await tool.execute({ rounds: '1' })).ok, false)
  assert.equal(state().轮数, 10, '参数错误不清计数')
  const consolidated = await tool.execute({ rounds: 2 })
  assert.deepEqual(consolidated, { ok: true, date: day, rounds: 2, text: first + first })
  assert.equal(state().轮数, 8, '只推进实际返回的轮次')
  assert.match(state().上次巩固, new RegExp(`^${day} \\d{2}:\\d{2}$`))
  assert.match(h.context(), /8 轮还没巩固/)
  await tool.execute({})
  assert.equal(state().轮数, 0)
  const beforeRemount = fs.readFileSync(scenePath, 'utf8')
  h.dispose()
  for (const name of ['agent/inbox/inserted', 'agent/turn-stopping', 'context', 'memory_consolidate']) assert.ok(h.disposed.includes(name), name + ' 函数 disposer 应调用')
  h = harness()
  h.stop()
  assert.equal(fs.readFileSync(scenePath, 'utf8'), beforeRemount + first, '同日重挂后接着追加')
  assert.equal(state().轮数, 1)
  failStateRename = true
  assert.equal((await h.tools.get('memory_consolidate').execute({})).ok, false)
  assert.equal(state().轮数, 1, '清零写入失败不返回成功、不改现存状态')
  failStateRename = false
  const savedScene = fs.readFileSync(scenePath, 'utf8')
  fs.renameSync(scenePath, scenePath + '.held')
  assert.equal((await h.tools.get('memory_consolidate').execute({})).ok, false)
  assert.equal(state().轮数, 1, '原文读取失败不清计数')
  fs.renameSync(scenePath + '.held', scenePath)
  assert.equal((await h.tools.get('memory_consolidate').execute({})).text, first)
  assert.equal(fs.readFileSync(scenePath, 'utf8'), savedScene, '工具不得改写情景')
  events = [{ type: 'user/message', data: { message: '长'.repeat(9000) } }, { type: 'assistant/message', data: { message: '回复' } }]
  h.stop()
  assert.ok(fs.readFileSync(scenePath, 'utf8').endsWith(`你说：${'长'.repeat(9000)}\n我说：回复\n`), '存档原话超过 2000 字也不截断')
  const limited = await h.tools.get('memory_consolidate').execute({})
  assert.equal(limited.rounds, 0, '长轮未完整返回，不算完成')
  assert.equal(limited.text.length, 8000)
  assert.ok(limited.text.startsWith(`## ${savedScene.slice(3, 8)}\n你说：`))
  assert.equal(state().轮数, 1)
  const continuation = await h.tools.get('memory_consolidate').execute({})
  assert.equal(continuation.rounds, 1)
  assert.equal(state().轮数, 0)
  const beforeFailure = fs.readFileSync(scenePath, 'utf8')
  failSceneRename = true
  assert.doesNotThrow(h.stop, '情景写入失败不得传给 turn-stopping')
  assert.equal(fs.readFileSync(scenePath, 'utf8'), beforeFailure)
  assert.equal(state().轮数, 0)
  failSceneRename = false
  failStateRename = true
  assert.doesNotThrow(h.stop, '状态写入失败不得传给 turn-stopping')
  assert.equal(state().轮数, 0)
  failStateRename = false
  events = [{ type: 'user/message', data: { message: '没有助手消息' } }]
  assert.doesNotThrow(h.stop)
  assert.ok(state().轮数 >= 1)
  let recovered = ''
  while (createStore({ rootDir: root }).readConsolidationState().轮数) recovered += (await h.tools.get('memory_consolidate').execute({})).text
  assert.match(recovered, /你说：没有助手消息\n我说：（未抓到）\n$/)

  function assertArchived(user, assistant, label) {
    const beforeRounds = state().轮数
    const before = fs.readFileSync(scenePath, 'utf8')
    assert.doesNotThrow(h.stop, label)
    const appended = fs.readFileSync(scenePath, 'utf8').slice(before.length)
    assert.match(appended, /^## \d{2}:\d{2}\n/)
    assert.ok(appended.endsWith(`你说：${user}\n我说：${assistant}\n`), label)
    assert.equal(state().轮数, beforeRounds + 1, label + '：仍计入巩固轮数')
    return appended
  }

  events = [
    { type: 'user/message', data: { message: '可见文本回归' } },
    { type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '不应存入的推理' },
      { type: 'thinking', text: '不应存入的思考' },
      { type: 'reasoning-text', text: '不应存入的推理文本' },
      { type: 'vendor-thinking', text: '不应存入的扩展思考' },
      { type: 'text', text: '真正说出口的回复' },
      { text: '无类型文本兼容' },
      '字符串兼容',
      { type: 'image', text: '图片字段不是回复' },
      { type: 'text', text: { nested: '不是字符串' } },
    ] } } },
  ]
  const visible = assertArchived('可见文本回归', '真正说出口的回复\n无类型文本兼容\n字符串兼容', '排除所有 reasoning/thinking 及非文本 part')
  assert.doesNotMatch(visible, /不应存入|图片字段|不是字符串/)

  h.insert({ message: { content: [{ type: 'text', text: 'inbox 用户原话' }] } })
  events = [{ type: 'user/message', data: { message: '快照旧原话' } }, { type: 'assistant/message', data: { message: '回复' } }]
  assertArchived('inbox 用户原话', '回复', 'lastText 优先于快照用户消息')
  events = [{ type: 'assistant/message', data: { message: '快照中没有用户消息' } }]
  assertArchived('inbox 用户原话', '快照中没有用户消息', 'lastText 在无 user/message 时仍有效')
  snapshotFails = true
  assertArchived('inbox 用户原话', '（未抓到）', '快照失败时保留 lastText 并继续存档')
  snapshotFails = false

  h.dispose()
  h = harness()
  for (const [label, userEvent, assistantEvent] of [
    ['data.message', { data: { message: { content: [{ type: 'text', text: '结构1' }] } } }, { data: { message: '回复1' } }],
    ['data', { data: { message: {}, content: [{ type: 'text', text: '结构2' }] } }, { data: { text: '回复2' } }],
    ['message', { data: { message: {} }, message: { text: '结构3' } }, { message: { text: '回复3' } }],
  ]) {
    events = [{ type: 'user/message', ...userEvent }, { type: 'assistant/message', ...assistantEvent }]
    assertArchived('结构' + (label === 'data.message' ? '1' : label === 'data' ? '2' : '3'), '回复' + (label === 'data.message' ? '1' : label === 'data' ? '2' : '3'), label + ' 结构兜底')
  }
  events = [{ type: 'user/message', data: { message: '旧的可提取消息' } }, { type: 'user/message', data: { message: {} } }, { type: 'assistant/message', data: { message: '回复' } }]
  assertArchived('旧的可提取消息', '回复', '空事件继续倒序查找')

  const shapeStart = diagnostics.length
  events = [{ type: 'assistant/message', data: { message: '助手单栏', opaque: '不应打印的正文' } }]
  assertArchived('（未抓到）', '助手单栏', '缺 user 仍存档')
  assertArchived('（未抓到）', '助手单栏', '重复缺 user 仍存档')
  const shapes = diagnostics.slice(shapeStart).filter((line) => line.includes('用户结构诊断'))
  assert.equal(shapes.length, 1, '结构诊断每次挂载只记录一次')
  assert.match(shapes[0], /type=assistant\/message \| data keys=message,opaque/)
  assert.doesNotMatch(shapes[0], /助手单栏|不应打印的正文/, '结构诊断不记录正文')
  assert.ok(diagnostics.slice(shapeStart).some((line) => line.includes('缺少 user，')))
  events = [{ type: 'user/message', data: { message: '助手顶层推理' } }, { type: 'assistant/message', data: { message: { type: 'reasoning-text', text: '顶层推理也不能绕过' } } }]
  assertArchived('助手顶层推理', '（未抓到）', '顶层 reasoning text 不得绕过过滤')
  assert.ok(diagnostics.some((line) => line.includes('缺少 assistant，')))
  events = []
  assertArchived('（未抓到）', '（未抓到）', '两栏都缺仍存档')
  assert.ok(diagnostics.some((line) => line.includes('缺少 user、assistant，')))
  snapshotFails = true
  assertArchived('（未抓到）', '（未抓到）', '快照失败且无 inbox 仍存档')
  snapshotFails = false
  assert.ok(writes.every((path) => path.endsWith('.tmp')), '所有业务写入都先写临时文件')
  assert.ok(renames.some(([, path]) => path.endsWith('情景索引.json')))
  assert.ok(renames.some(([, path]) => path.endsWith('写入日志.jsonl')))
  assert.ok(diagnostics.some((line) => line.includes('模拟快照失败')))
  assert.ok(diagnostics.some((line) => line.includes('模拟情景 rename 失败')))
  assert.ok(diagnostics.some((line) => line.includes('模拟状态 rename 失败')))
  assert.ok(diagnostics.some((line) => line.includes('context 巩固提醒注入')))
  h.dispose()

  const historyRoot = join(temporaryRoot, 'history')
  const oldDay = new Date(2026, 9, 30, 12, 0)
  const nextDay = new Date(2026, 9, 31, 12, 0)
  const store = createStore({ rootDir: historyRoot, now: () => oldDay })
  store.appendTurn('昨天原话', '昨天回复', oldDay)
  assert.equal(store.readConsolidationState(nextDay).轮数, 1, '跨日保留积压')
  store.appendTurn('今天原话', '今天回复', nextDay)
  assert.equal(store.consolidateScenes(undefined, nextDay).rounds, 2)
  assert.match(fs.readFileSync(join(historyRoot, '情景', '2026-10-30.md'), 'utf8'), /昨天原话/)
  console.log('自动存档与巩固钩子测试：通过（原文、完整存档、原子追加、1/9/10轮、原文返回、清零、重挂、卸载、异常、8000字、跨日、仅可见文本、inbox优先、三种快照、缺栏存档、结构诊断限一次）')
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const path = resolve(temporaryRoot)
  if (path.startsWith(resolve(parent, '.consolidate-hook-'))) fs.rmSync(path, { recursive: true, force: true })
}
