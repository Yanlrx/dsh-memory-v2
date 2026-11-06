import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStore } from '../lib/store.js'
import { recall } from '../lib/recall.js'

const root = mkdtempSync(join(tmpdir(), 'memory-review-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = root
const configPath = join(root, 'dsh-memory-v2-config.json')
const token = 'test-only-abcdefghijklmnopqrstuvwxyz-0123456789'
const config = (value) => writeFileSync(configPath, JSON.stringify(value))
let dispose
try {
  const now = new Date(2026, 10, 6, 23, 59)
  const tomorrow = new Date(2026, 10, 7, 0, 1)
  const store = createStore({ rootDir: join(root, 'unit'), now: () => now })
  store.appendTurn('第一轮', '答一', now)
  store.appendTurn('第二轮', '答二', now)
  store.appendTurn('第三轮', '答三', now)
  assert.equal(store.sceneSegment('2026-11-06', '23:59'), null, '同分钟歧义不取第一段冒充')
  assert.equal(store.consolidateScenes(1, now).rounds, 1)
  assert.equal(store.readConsolidationState(tomorrow).轮数, 2)
  assert.match(store.consolidateScenes(1, tomorrow).text, /第二轮/)
  assert.match(store.consolidateScenes(1, tomorrow).text, /第三轮/)
  const longText = '😀'.repeat(9000) + '\n## 01:23\n用户正文标题'
  store.appendTurn(longText, '尾部证据', tomorrow)
  const scene = store.sceneSegment('2026-11-07', '00:01')
  const first = store.consolidateScenes(undefined, tomorrow)
  assert.equal(Array.from(first.text).length, 8000)
  assert.equal(first.rounds, 0)
  const reopened = createStore({ rootDir: join(root, 'unit'), now: () => tomorrow })
  assert.equal(reopened.readConsolidationState(tomorrow).轮数, 1)
  const second = reopened.consolidateScenes(undefined, tomorrow)
  assert.equal(second.rounds, 1)
  assert.equal((first.text + second.text).trimEnd(), scene)
  assert.equal(reopened.readConsolidationState(tomorrow).轮数, 0)
  const raw = readFileSync(join(root, 'unit', '情景', '2026-11-07.md'), 'utf8')
  assert.ok(raw.includes(longText), '原话完整保留')
  assert.equal(reopened.traceScene('尾部证据').length, 1, '索引分段不受用户 Markdown 标题干扰')
  const record = { id: 'cat', text: '用户养了一只猫', kind: ['事件'], event_time: now.toISOString(), 状态: '生效', 实体: ['猫'] }
  assert.deepEqual(recall('量子火箭发动机故障码', { records: [record], now }), [])
  assert.equal(recall('养了一只猫', { records: [record], now }).length, 1)

  const { apply } = await import('../lib/index.js')
  const globalListeners = new Map()
  const localListeners = new Map()
  const tools = new Map()
  const routes = new Map()
  let tick
  let context
  const agent = { session: { id: 'approved', snapshotEvents: () => [] }, ctx: {
    tools: { register(t) { tools.set(t.name, t); return () => tools.delete(t.name) } },
    on(name, fn) { localListeners.set(name, fn); return () => localListeners.delete(name) },
    systemPrompt: { section: () => () => {}, context(value) { context = value; return () => {} } },
  } }
  config({ 会话白名单: ['approved'], 候选接口令牌: token })
  dispose = apply({
    on(name, fn) { globalListeners.set(name, fn); return () => globalListeners.delete(name) },
    tools: { register() { assert.fail('不得注册全局工具') } },
    agents: { list: () => [agent] }, interval(fn) { tick = fn; return () => {} }, effect: (fn) => fn(),
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
  })
  const capture = globalListeners.get('session/event')
  capture({ id: 'denied' }, { type: 'user/message', data: { text: '不能存的秘密' } })
  capture(agent.session, { type: 'user/message', data: { text: '允许的原话' } })
  capture(agent.session, { type: 'assistant/message', data: { text: '允许的回答' } })
  localListeners.get('agent/turn-stopping')()
  const archive = createStore().consolidateScenes().text
  assert.match(archive, /允许的原话/)
  assert.doesNotMatch(archive, /不能存的秘密/)
  const tool = tools.get('memory_write')
  const entry = await tool.execute({ text: '初始结论', collection: '结论' })
  const runtimeStore = createStore()
  runtimeStore.replaceRecord('结论', { ...runtimeStore.readCollection('结论')[0], 倾向: '负面' })
  await tool.execute({ text: '不足门槛的反证', supersede: entry.id, opposite: true })
  assert.equal(runtimeStore.readCollection('结论')[0].text, '初始结论', '弱反证不应提前改写正文')
  const route = routes.get('/memory-v2/candidates')
  async function request(headers = {}, method = 'GET') {
    let code, body
    await route.handler({ method, headers }, { writeHead(value) { code = value }, end(value) { body = JSON.parse(value) } })
    return { code, body }
  }
  assert.equal((await request()).code, 403)
  assert.equal((await request({ authorization: 'Bearer wrong' })).code, 403)
  assert.equal((await request({ authorization: `Bearer ${token}` })).code, 200)
  assert.equal((await request({}, 'POST')).code, 405)
  config({ 会话白名单: ['approved'], 排除会话: ['approved'] })
  assert.equal((await tool.execute({ text: '已撤销' })).ok, false)
  assert.equal(context.text(), '')
  tick()
  assert.equal(tools.size, 0)
  assert.equal(localListeners.size, 0)
  dispose(); dispose = null
  assert.equal(globalListeners.size, 0, '卸载释放全局 session/event')
  console.log('审查回归：部分/跨日/长轮续读、同分钟歧义、无关召回、事件范围、弱反证、鉴权、撤销与卸载通过')
} finally {
  dispose?.()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (resolve(root).startsWith(resolve(tmpdir(), 'memory-review-'))) rmSync(root, { recursive: true, force: true })
}
