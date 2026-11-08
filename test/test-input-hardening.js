import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.input-hardening-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = root

try {
  const { apply } = await import('../lib/index.js')
  const tools = new Map()
  const dispose = apply({
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    agents: { list: () => [] },
    interval: () => () => {},
    effect: (callback) => callback(),
    on: () => () => {},
    webServer: { register: () => () => {} },
  }, { 启用全局主库工具: true })

  const write = tools.get('memory_write')
  assert.equal((await write.execute({ text: '示例状态', kinds: ['状态'], entities: ['状态'] })).ok, false)
  assert.equal((await write.execute({ text: '示例状态', kinds: ['状态'], entities: ['状态'], ttl: 'banana' })).ok, false)
  assert.equal((await write.execute({ text: '示例状态', kinds: ['状态'], entities: ['状态'], ttl: '0d' })).ok, false)
  assert.equal((await write.execute({ text: '混合类型', kinds: ['状态', '偏好'], entities: ['类型'], ttl: '1d' })).ok, false)
  assert.equal((await write.execute({ text: '未知类型', kinds: ['未知'] })).ok, false)
  assert.equal((await write.execute({ text: '标点实体', kinds: ['偏好'], entities: ['!!!'] })).ok, false)
  assert.equal((await write.execute({ text: '错误类型容器', kinds: '事件' })).ok, false)
  assert.equal((await write.execute({ text: '错误实体容器', entities: '示例' })).ok, false)
  assert.equal((await write.execute({ text: '过多实体', entities: ['一', '二', '三', '四', '五', '六'] })).ok, false)
  assert.equal((await write.execute({ text: '错误集合', collection: '不存在' })).ok, false)
  assert.equal((await write.execute({ text: '错误冲突容器', conflict: 'record-id' })).ok, false)
  assert.equal((await write.execute({ text: 123 })).ok, false)

  const created = await write.execute({ text: '当前使用浅色主题', kinds: ['状态'], entities: ['主题'], ttl: '7d' })
  assert.equal(created.ok, true)
  const replaced = await write.execute({ text: '仍使用浅色主题', kinds: ['状态'], entities: ['主题'], supersede: created.id })
  assert.equal(replaced.ok, true, '状态 supersede 应继承旧 TTL')

  const recalled = await tools.get('memory_recall').execute({ query: '主题' })
  assert.equal(recalled.semanticRequested, false)
  assert.equal(recalled.semanticUsed, false)
  assert.equal(recalled.semanticError, '')
  dispose()
  console.log('输入强化测试：TTL、类型、实体、继承与语义状态通过')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(root)
  if (safe.startsWith(resolve(parent, '.input-hardening-'))) fs.rmSync(safe, { recursive: true, force: true })
}
