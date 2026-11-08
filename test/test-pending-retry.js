import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(join(parent, '.pending-retry-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

try {
  const { apply, createStore } = await import('../lib/index.js')
  const handlers = new Map()
  const agent = {
    session: { id: 'pending-retry-session', snapshotEvents: () => [] },
    ctx: {
      tools: { register: () => () => {} },
      on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name) },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
    },
  }
  let sessionEvent
  let tick
  let agents = [agent]
  const dispose = apply({
    tools: { register: () => () => {} },
    agents: { list: () => agents },
    interval(callback) { tick = callback; return () => {} },
    effect: (callback) => callback(),
    on(name, callback) { if (name === 'session/event') sessionEvent = callback; return () => {} },
    webServer: { register: () => () => {} },
  })

  sessionEvent(agent.session, { type: 'user/message', data: { message: '必须重试保留的消息' } })
  const sceneDir = join(home, 'storages', 'dsh-memory', '情景')
  const sceneBackup = sceneDir + '-backup'
  fs.renameSync(sceneDir, sceneBackup)
  fs.writeFileSync(sceneDir, '阻断目录创建')
  handlers.get('agent/turn-stopping')()
  agents = []
  tick()
  fs.unlinkSync(sceneDir)
  fs.renameSync(sceneBackup, sceneDir)
  tick()

  const store = createStore({ rootDir: join(home, 'storages', 'dsh-memory') })
  assert.equal(store.readConsolidationState().轮数, 1, 'agent 移除后仍必须保留并定时重试 pending')
  const lease = store.consolidateScenes()
  assert.match(lease.text, /必须重试保留的消息/)
  dispose()
  console.log('pending 重试测试：写失败且 agent 移除后仍保留，恢复后定时落盘')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(home)
  if (safe.startsWith(resolve(parent, '.pending-retry-'))) fs.rmSync(safe, { recursive: true, force: true })
}
