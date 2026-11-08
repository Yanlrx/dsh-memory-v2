import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(join(parent, '.migration-collision-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

function makeAgent(id) {
  const handlers = new Map()
  return {
    handlers,
    agent: {
      session: { id, snapshotEvents: () => [] },
      ctx: {
        tools: { register: () => () => {} },
        on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name) },
        systemPrompt: { section: () => () => {}, context: () => () => {} },
      },
    },
  }
}

try {
  fs.writeFileSync(join(home, 'dsh-memory-v2-config.json'), JSON.stringify({
    会话归属: { second: 'a-b' },
  }))
  const legacyPath = join(home, 'storages', 'dsh-memory-a-b')
  fs.mkdirSync(legacyPath, { recursive: true })
  fs.writeFileSync(join(legacyPath, 'legacy-marker.txt'), 'synthetic legacy data')

  const { apply } = await import('../lib/index.js')
  const second = makeAgent('second')
  const dispose = apply({
    tools: { register: () => () => {} },
    agents: { list: () => [second.agent] },
    interval: () => () => {},
    effect: (callback) => callback(),
    on: () => () => {},
    webServer: { register: () => () => {} },
  })

  assert.equal(second.handlers.size, 0)
  assert.equal(fs.existsSync(legacyPath), true, '无法验证历史归属时不得把旧目录迁给当前唯一归属')
  assert.equal(fs.readFileSync(join(legacyPath, 'legacy-marker.txt'), 'utf8'), 'synthetic legacy data')
  const migrated = fs.readdirSync(join(home, 'storages')).filter((name) => name.startsWith('dsh-memory-owner-'))
  assert.deepEqual(migrated, [], '不可信旧版迁移必须失败关闭且不创建新分库')
  dispose()
  console.log('旧分库迁移测试：历史归属不可证明时失败关闭，不误领数据')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(home)
  if (safe.startsWith(resolve(parent, '.migration-collision-'))) fs.rmSync(safe, { recursive: true, force: true })
}
