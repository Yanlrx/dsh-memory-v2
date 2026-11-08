import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, createStore } from '../lib/index.js'

const parent = dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(join(parent, '.owner-routing-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

function record(id, text) {
  return {
    id, text, kind: ['偏好'], 主体: '本人', 说话人: '本人', 原话: text, 我的推断: '',
    来源: 'test', 门牌: 'test', event_time: null, last_confirmed: '2026-11-07', ttl: null,
    置信度: 1, 证据: [], 出现次数: 1, 被召回次数: 0, 实体: ['饮品'], 冲突: null, 版本: 1, 状态: '生效',
  }
}

function makeAgent(id, user, assistant) {
  const handlers = new Map()
  const tools = new Map()
  let context
  return {
    handlers, tools,
    agent: {
      session: { id, snapshotEvents: () => [{ type: 'user/message', data: { message: user } }, { type: 'assistant/message', data: { message: assistant } }] },
      ctx: {
        tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
        on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name) },
        systemPrompt: { section: () => () => {}, context(value) { context = value; return () => {} } },
      },
    },
    context: () => context.text(),
  }
}

try {
  fs.writeFileSync(join(home, 'dsh-memory-v2-config.json'), JSON.stringify({ 会话归属: { 'other-session': 'alice' }, 未映射会话写入待认领: true }))
  const main = createStore({ rootDir: join(home, 'storages', 'dsh-memory') })
  const ownerHash = createHash('sha256').update('alice', 'utf8').digest('hex').slice(0, 16)
  const newOwnerPath = join(home, 'storages', `dsh-memory-owner-alice-${ownerHash}`)
  const owner = createStore({ rootDir: newOwnerPath })
  main.appendRecord('画像', record('main-pref', '主库喜欢咖啡'))
  owner.appendRecord('画像', record('other-pref', 'Alice 喜欢绿茶'))

  const bound = makeAgent('other-session', '喜欢什么饮品？', '绿茶')
  const stranger = makeAgent('unknown-session', '陌生会话', '回复')
  const prototypeSid = makeAgent('toString', '原型名称会话', '回复')
  const agents = [bound.agent, stranger.agent, prototypeSid.agent]
  const dispose = apply({
    tools: { register: () => () => {} }, agents: { list: () => agents }, interval: () => () => {}, effect: (callback) => callback(),
    on: () => () => {}, webServer: { register: () => () => {} },
  })

  bound.handlers.get('agent/turn-stopping')()
  stranger.handlers.get('agent/turn-stopping')()
  prototypeSid.handlers.get('agent/turn-stopping')()
  assert.equal(fs.existsSync(newOwnerPath), true, '已绑定归属应使用带摘要的目录')
  const other = createStore({ rootDir: newOwnerPath })
  assert.equal(other.readConsolidationState().轮数, 1, '已绑定非主用户必须写自己库')
  assert.equal(main.readConsolidationState().轮数, 0, '非主用户和陌生会话不得污染主库')
  const pending = createStore({ rootDir: join(home, 'storages', 'dsh-memory-pending') })
  assert.equal(pending.readConsolidationState().轮数, 2, '陌生会话与原型属性名 SID 必须写待认领库')

  bound.handlers.get('agent/inbox/inserted')({ message: { text: '喜欢什么饮品？', source: { kind: 'user' } } })
  const injected = bound.context()
  assert.match(injected, /Alice 喜欢绿茶/)
  assert.doesNotMatch(injected, /主库喜欢咖啡/)
  const lease = await bound.tools.get('memory_consolidate').execute({})
  assert.match(lease.text, /喜欢什么饮品/)

  dispose()
  console.log('主库、已绑定分库与陌生待认领路由测试：通过')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(home)
  if (safe.startsWith(resolve(parent, '.owner-routing-'))) fs.rmSync(safe, { recursive: true, force: true })
}
