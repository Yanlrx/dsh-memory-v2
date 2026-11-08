import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(join(parent, '.routing-hardening-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const configPath = join(home, 'dsh-memory-v2-config.json')

const storageKey = (owner) => {
  const normalized = owner.normalize('NFKC').trim()
  const slug = normalized.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'owner'
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
  return `owner-${slug}-${hash}`
}

function makeAgent(id) {
  const handlers = new Map()
  const tools = new Map()
  return {
    handlers,
    tools,
    agent: {
      session: { ...(id ? { id } : {}), snapshotEvents: () => [] },
      ctx: {
        tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
        on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name) },
        systemPrompt: { section: () => () => {}, context: () => () => {} },
      },
    },
  }
}

function release(store) {
  const lease = store.consolidateScenes()
  if (lease.ackToken) store.consolidateScenes(undefined, new Date(), () => {}, { abandonToken: lease.ackToken })
  return lease.text
}

try {
  fs.writeFileSync(configPath, JSON.stringify({
    会话归属: { s1: 'alice', s2: 'a/b', s3: 'a?b' },
    未映射会话写入待认领: true,
  }))
  const { apply, createStore } = await import('../lib/index.js')
  const first = makeAgent('s1')
  const slash = makeAgent('s2')
  const question = makeAgent('s3')
  const missing = makeAgent('')
  const agents = [first.agent, slash.agent, question.agent, missing.agent]
  let globalEvent
  let globalDisposed = 0
  let tick
  const dispose = apply({
    tools: { register: () => () => {} },
    agents: { list: () => agents },
    interval(callback) { tick = callback; return () => {} },
    effect: (callback) => callback(),
    on(name, callback) {
      assert.equal(name, 'session/event')
      globalEvent = callback
      return () => { globalDisposed += 1 }
    },
    webServer: { register: () => () => {} },
  })

  assert.equal(missing.handlers.size, 0, '无 SID 会话必须失败关闭')
  const slashPath = join(home, 'storages', 'dsh-memory-' + storageKey('a/b'))
  const questionPath = join(home, 'storages', 'dsh-memory-' + storageKey('a?b'))
  assert.notEqual(slashPath.toLowerCase(), questionPath.toLowerCase(), '清洗后相同的 owner 也必须映射到不同目录')
  assert.equal(fs.existsSync(slashPath), true)
  assert.equal(fs.existsSync(questionPath), true)

  globalEvent(first.agent.session, { type: 'user/message', data: { message: '旧库消息' } })
  fs.writeFileSync(configPath, JSON.stringify({
    会话归属: { s1: 'bob', s2: 'a/b', s3: 'a?b' },
    未映射会话写入待认领: true,
  }))
  tick()
  globalEvent(first.agent.session, { type: 'assistant/message', data: { message: '新库回复' } })
  first.handlers.get('agent/turn-stopping')()

  const alice = createStore({ rootDir: join(home, 'storages', 'dsh-memory-' + storageKey('alice')) })
  const bob = createStore({ rootDir: join(home, 'storages', 'dsh-memory-' + storageKey('bob')) })
  assert.match(release(alice), /旧库消息/)
  assert.doesNotMatch(release(alice), /新库回复/)
  assert.match(release(bob), /新库回复/)

  fs.writeFileSync(configPath, '{ broken json')
  tick()
  globalEvent(first.agent.session, { type: 'user/message', data: { message: '损坏配置后的消息' } })
  first.handlers.get('agent/turn-stopping')()
  assert.match(release(bob), /损坏配置后的消息/, '损坏配置后应继续使用 last-known-good')
  const main = createStore({ rootDir: join(home, 'storages', 'dsh-memory') })
  assert.equal(main.readConsolidationState().轮数, 0, '损坏配置不得退回主库')

  fs.writeFileSync(configPath, JSON.stringify({
    会话归属: { s1: 'bob', s2: 'a/b', s3: 'a?b' },
    排除会话: ['s1'],
  }))
  tick()
  assert.equal(first.handlers.size, 0, '动态加入排除名单必须卸载会话 hooks')

  dispose()
  assert.equal(globalDisposed, 1, '全局 session/event 监听器必须被卸载')
  console.log('路由强化测试：坏配置、无 SID、改绑批次、目录碰撞、动态 scope 与 disposer 通过')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(home)
  if (safe.startsWith(resolve(parent, '.routing-hardening-'))) fs.rmSync(safe, { recursive: true, force: true })
}
