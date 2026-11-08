import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(join(parent, '.tool-fail-closed-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

function baseContext(agents, tools, hooks = {}) {
  return {
    tools,
    agents: { list: () => agents },
    interval: hooks.interval ?? (() => () => {}),
    effect: (callback) => callback(),
    on(name, callback) { if (name === 'session/event') hooks.event = callback; return () => {} },
    webServer: { register: () => () => {} },
  }
}

try {
  const { apply, createStore } = await import('../lib/index.js')

  let sessionRegisterCount = 0
  let sessionRollbackCount = 0
  let hookCount = 0
  const agent = {
    session: { id: 'session-tool-failure', snapshotEvents: () => [] },
    ctx: {
      tools: {
        register() {
          sessionRegisterCount += 1
          if (sessionRegisterCount === 3) throw new Error('模拟第三个工具注册失败')
          return () => { sessionRollbackCount += 1 }
        },
      },
      on() { hookCount += 1; return () => {} },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
    },
  }
  const firstHooks = {}
  const disposeSession = apply(baseContext([agent], { register: () => () => {} }, firstHooks))
  assert.equal(sessionRegisterCount, 3)
  assert.equal(sessionRollbackCount, 2, '会话工具部分注册后必须逆序回滚')
  assert.equal(hookCount, 0, '工具注册不完整时不得继续挂会话 hooks')
  firstHooks.event(agent.session, { type: 'user/message', data: { message: '失败挂载不得捕获' } })
  disposeSession()
  const failedStore = createStore({ rootDir: join(home, 'storages', 'dsh-memory') })
  assert.equal(failedStore.readConsolidationState().轮数, 0, '工具挂载失败的会话不得通过全局事件写盘')

  let fullRegisterCount = 0
  let fullRollbackCount = 0
  let fullHookCalls = 0
  let tick
  const partialAgent = {
    session: { id: 'session-hook-failure', snapshotEvents: () => [] },
    ctx: {
      tools: { register() { fullRegisterCount += 1; return () => { fullRollbackCount += 1 } } },
      on() {
        fullHookCalls += 1
        if (fullHookCalls === 2) throw new Error('模拟第二个 hook 注册失败')
        return () => { fullRollbackCount += 1 }
      },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
    },
  }
  const fullHooks = { interval(callback) { tick = callback; return () => {} } }
  const disposePartial = apply(baseContext([partialAgent], { register: () => () => {} }, fullHooks))
  assert.equal(fullRegisterCount, 4)
  assert.equal(fullRollbackCount, 5, '后续 hook 失败必须回滚四个工具和已挂 hook')
  tick()
  assert.equal(fullRegisterCount, 4, '失败挂载应保持关闭，后续 tick 不得重复注册')
  disposePartial()

  let globalRegisterCount = 0
  let globalRollbackCount = 0
  const disposeGlobal = apply(baseContext([], {
    register() {
      globalRegisterCount += 1
      if (globalRegisterCount === 3) throw new Error('模拟全局第三个工具注册失败')
      return () => { globalRollbackCount += 1 }
    },
  }), { 启用全局主库工具: true })
  assert.equal(globalRegisterCount, 3)
  assert.equal(globalRollbackCount, 2, '全局工具部分注册后必须全部回滚')
  disposeGlobal()

  console.log('工具注册失败关闭测试：事件门禁、完整挂载与全局工具均原子回滚')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(home)
  if (safe.startsWith(resolve(parent, '.tool-fail-closed-'))) fs.rmSync(safe, { recursive: true, force: true })
}
