import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.config-type-hardening-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = temporaryRoot
const configPath = join(temporaryRoot, 'dsh-memory-v2-config.json')
const { apply } = await import('../lib/index.js')

function mountedHooksFor(config) {
  fs.writeFileSync(configPath, JSON.stringify(config))
  let hooks = 0
  const agent = {
    session: { id: 'session-type-test', snapshotEvents() { return [] } },
    ctx: {
      tools: { register() { return () => {} } },
      on() { hooks += 1; return () => {} },
      systemPrompt: { section() { return () => {} }, context() { return () => {} } },
    },
  }
  const ctx = {
    tools: { register() { return () => {} } },
    webServer: { register() { return () => {} } },
    agents: { list: () => [agent] },
    effect(callback) { return callback() },
    interval() { return () => {} },
  }
  const dispose = apply(ctx)
  dispose?.()
  return hooks
}

try {
  const invalidConfigs = [
    { 会话白名单: [123] },
    { 排除会话: [null] },
    { 排除归属: [{}] },
    { 会话白名单: ['   '] },
    { 会话归属: { 'session-type-test': 123 } },
    { 会话归属: { 'session-type-test': { name: 'owner' } } },
  ]
  for (const config of invalidConfigs) assert.equal(mountedHooksFor(config), 0, `错误类型配置必须失败关闭：${JSON.stringify(config)}`)
  const storages = join(temporaryRoot, 'storages')
  const unsafeStores = fs.existsSync(storages) ? fs.readdirSync(storages).filter((name) => name === 'dsh-memory-pending' || name.startsWith('dsh-memory-owner-')) : []
  assert.deepEqual(unsafeStores, [], '错误类型配置不得创建 owner 或 pending 分库')
  assert.equal(mountedHooksFor({ 会话白名单: ['session-type-test'], 会话归属: { 'session-type-test': 'example-owner' } }) > 0, true)
  console.log('配置类型强化测试：非字符串列表项与归属值均失败关闭')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(temporaryRoot)
  if (safe.startsWith(resolve(parent, '.config-type-hardening-'))) fs.rmSync(safe, { recursive: true, force: true })
}
