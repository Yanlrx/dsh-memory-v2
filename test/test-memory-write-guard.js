import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, createStore } from '../lib/index.js'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.write-guard-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = root

try {
  const tools = new Map()
  const dispose = apply({
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    agents: { list: () => [] }, interval: () => () => {}, effect: (callback) => callback(),
    webServer: { register: () => () => {} },
  }, { 启用全局主库工具: true })
  const write = tools.get('memory_write')
  const first = await write.execute({ text: '用户喜欢咖啡', collection: '画像', kinds: ['偏好'], entities: ['咖啡'], source: 'scene:first' })
  assert.equal(first.ok, true)

  const duplicate = await write.execute({ text: '用户喜欢咖啡', collection: '画像', kinds: ['偏好'], entities: ['咖啡'] })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.duplicateOf, first.id)

  const overlap = await write.execute({ text: '用户喜欢拿铁', collection: '画像', kinds: ['偏好'], entities: ['咖啡'] })
  assert.equal(overlap.ok, false)
  assert.deepEqual(overlap.needsSupersede, [first.id])

  const replaced = await write.execute({ text: '用户现在更喜欢拿铁', collection: '画像', kinds: ['偏好'], entities: ['咖啡'], supersede: first.id, source: 'scene:replace' })
  assert.equal(replaced.ok, true)
  const store = createStore({ rootDir: join(root, 'storages', 'dsh-memory') })
  const current = store.readCollection('画像').find((record) => record.id === first.id)
  assert.equal(current.text, '用户现在更喜欢拿铁')
  assert.equal(current.版本, 2)
  assert.equal(current.来源, 'scene:replace')

  const stateA = await write.execute({ text: '目前在家办公', kinds: ['状态'], entities: ['工作地点'], ttl: '1d' })
  assert.equal(stateA.ok, true)
  const stateB = await write.execute({ text: '目前在公司办公', kinds: ['状态'], entities: ['工作地点'], ttl: '1d', conflict: [stateA.id] })
  assert.equal(stateB.ok, true)
  const rows = store.readCollection('语义')
  assert.ok(rows.find((record) => record.id === stateA.id).冲突.includes(stateB.id))
  assert.ok(rows.find((record) => record.id === stateB.id).冲突.includes(stateA.id))

  dispose()
  console.log('写入去重、显式替代与双向冲突测试：通过')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(root)
  if (safe.startsWith(resolve(parent, '.write-guard-'))) fs.rmSync(safe, { recursive: true, force: true })
}
