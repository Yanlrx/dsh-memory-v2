import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.consolidate-hook-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = temporaryRoot

try {
  const tools = new Map()
  const handlers = new Map()
  const contexts = []
  const disposed = []
  let events = [
    { type: 'user/message', data: { message: '原话\n## 用户自己的标题\n标题后的证据' } },
    { type: 'assistant/message', data: { message: '第一条回复' } },
  ]
  const agent = {
    session: { id: 'session-example-consolidate', snapshotEvents: () => events },
    ctx: {
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      on(name, callback) { handlers.set(name, callback); return () => { handlers.delete(name); disposed.push(name) } },
      systemPrompt: {
        section() { return () => disposed.push('section') },
        context(value) { contexts.push(value); return () => disposed.push('context') },
      },
    },
  }
  const dispose = apply({
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    agents: { list: () => [agent] },
    interval: () => () => disposed.push('interval'),
    effect: (callback) => callback(),
    webServer: { register: () => () => disposed.push('route') },
  })

  const root = join(temporaryRoot, 'storages', 'dsh-memory')
  const store = createStore({ rootDir: root })
  const stop = () => handlers.get('agent/turn-stopping')()
  const contextText = () => contexts.at(-1).text()
  const consolidate = tools.get('memory_consolidate')

  stop()
  let state = store.readConsolidationState()
  assert.equal(state.轮数, 1)
  const day = state.date
  const scenePath = join(root, '情景', `${day}.md`)
  const firstScene = fs.readFileSync(scenePath, 'utf8')
  assert.match(firstScene, /^## \[scene:[0-9a-f-]+\] \d{2}:\d{2}\n/)
  assert.match(firstScene, /## 用户自己的标题\n标题后的证据/)
  assert.equal(store.traceScene('标题后的证据').length, 1, 'trace 必须能搜到 Markdown 标题后的文本')

  for (let index = 1; index < 5; index++) stop()
  assert.equal(store.readConsolidationState().轮数, 5)
  assert.match(contextText(), /5 轮还没巩固/)

  const lease = await consolidate.execute({ rounds: 2 })
  assert.equal(lease.ok, true)
  assert.equal(lease.rounds, 2)
  assert.ok(lease.ackToken)
  assert.equal(store.readConsolidationState().轮数, 5, '只读未确认时不得清计数')

  events = [
    { type: 'user/message', data: { message: '租约之后的新轮次' } },
    { type: 'assistant/message', data: { message: '新回复' } },
  ]
  stop()
  assert.equal(store.readConsolidationState().轮数, 6)
  const ack = await consolidate.execute({ ackToken: lease.ackToken })
  assert.equal(ack.acknowledged, true)
  assert.equal(ack.remaining, 4, '只确认租约精确覆盖的两轮')
  const repeated = await consolidate.execute({ ackToken: lease.ackToken })
  assert.equal(repeated.idempotent, true, '重复 ack 必须幂等')

  while (store.readConsolidationState().轮数 > 0) {
    const next = await consolidate.execute({})
    assert.ok(next.ackToken)
    await consolidate.execute({ ackToken: next.ackToken })
  }

  const longStore = createStore({ rootDir: join(temporaryRoot, 'long') })
  longStore.appendTurn('长'.repeat(9000), '回复')
  const part1 = longStore.consolidateScenes()
  assert.equal(Array.from(part1.text).length, 8000)
  assert.equal(part1.truncated, true)
  longStore.consolidateScenes(undefined, new Date(), () => {}, { ackToken: part1.ackToken })
  assert.equal(longStore.readConsolidationState().轮数, 1, '长情景第一块 ack 后仍待处理')
  const part2 = longStore.consolidateScenes()
  assert.ok(part2.text.length > 0 && part2.text.length < 2000)
  longStore.consolidateScenes(undefined, new Date(), () => {}, { ackToken: part2.ackToken })
  assert.equal(longStore.readConsolidationState().轮数, 0, '长情景分块全部 ack 后才完成')

  const sameMinuteRoot = join(temporaryRoot, 'same-minute')
  const fixed = new Date('2026-11-07T12:34:10+08:00')
  const sameMinuteStore = createStore({ rootDir: sameMinuteRoot, now: () => fixed })
  const a = sameMinuteStore.appendTurn('第一段', '回复A', fixed)
  const b = sameMinuteStore.appendTurn('第二段', '回复B', new Date(fixed.getTime() + 20000))
  assert.notEqual(a.segmentId, b.segmentId)
  assert.equal(sameMinuteStore.sceneSegment('2026-11-07', '12:34'), null, '同分钟多段时不许猜第一段')
  assert.match(sameMinuteStore.sceneSegmentById(b.segmentId), /第二段/)

  const crossDayStore = createStore({ rootDir: join(temporaryRoot, 'cross-day') })
  crossDayStore.appendTurn('昨天', '昨天回复', new Date('2026-11-06T23:59:00+08:00'))
  crossDayStore.appendTurn('今天', '今天回复', new Date('2026-11-07T00:01:00+08:00'))
  assert.equal(crossDayStore.readConsolidationState(new Date('2026-11-07T00:02:00+08:00')).轮数, 2, '跨日未巩固不得丢失')

  dispose()
  assert.ok(disposed.length > 0)
  console.log('自动存档与两阶段巩固测试：通过')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const path = resolve(temporaryRoot)
  if (path.startsWith(resolve(parent, '.consolidate-hook-'))) fs.rmSync(path, { recursive: true, force: true })
}
