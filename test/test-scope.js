// test-scope.js —— 会话范围控制的回归。
// 验：排除名单里的会话不挂、白名单非空时只挂列表里的、两种名单都没配时全挂。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.scope-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = temporaryRoot

const configPath = join(temporaryRoot, 'dsh-memory-v2-config.json')

function writeConfig(value) {
  fs.writeFileSync(configPath, JSON.stringify(value, null, 2))
}

const EXCLUDED_SESSION = 'session-example-excluded'
const ALLOWED_SESSION = 'session-example-allowed'

// 造一个假 agent，记录它有没有被挂上（on 被调用 = 挂上了）
function makeAgent(sid) {
  const mounted = { hooks: 0 }
  return {
    mounted,
    agent: {
      session: { id: sid, snapshotEvents() { return [] } },
      ctx: {
        tools: { register() { return () => {} } },
        on() { mounted.hooks += 1; return () => {} },
        systemPrompt: {
          section() { return () => {} },
          context() { return () => {} },
        },
      },
    },
  }
}

try {
  const { apply } = await import('../lib/index.js')

  function runOnce(agents) {
    const list = agents.map((item) => item.agent)
    const ctx = {
      tools: { register() { return () => {} } },
      webServer: { register() { return () => {} } },
      agents: { list: () => list },
      effect(fn) { return fn() },
      interval() { return () => {} },
    }
    apply(ctx)
  }

  // ① 排除名单：被排除的会话不挂，其他会话照常挂载
  writeConfig({ 会话白名单: [], 排除会话: [EXCLUDED_SESSION] })
  const excluded = makeAgent(EXCLUDED_SESSION)
  const allowed = makeAgent(ALLOWED_SESSION)
  runOnce([excluded, allowed])
  assert.equal(excluded.mounted.hooks, 0, '排除名单里的会话不该被挂')
  assert.ok(allowed.mounted.hooks > 0, '未排除的会话应该被挂')

  // ② 白名单非空：只挂列表里的
  writeConfig({ 会话白名单: [ALLOWED_SESSION], 排除会话: [] })
  const another = makeAgent('session-other-1234')
  const allowed2 = makeAgent(ALLOWED_SESSION)
  runOnce([another, allowed2])
  assert.equal(another.mounted.hooks, 0, '白名单非空时，不在列表里的不该挂')
  assert.ok(allowed2.mounted.hooks > 0, '白名单里的要挂')

  // ③ 两种都没配：全挂
  writeConfig({ 会话白名单: [], 排除会话: [] })
  const free1 = makeAgent(EXCLUDED_SESSION)
  const free2 = makeAgent('session-x')
  runOnce([free1, free2])
  assert.ok(free1.mounted.hooks > 0, '没配名单时谁都该挂')
  assert.ok(free2.mounted.hooks > 0, '没配名单时谁都该挂')

  // ④ 排除优先于白名单
  writeConfig({ 会话白名单: [EXCLUDED_SESSION], 排除会话: [EXCLUDED_SESSION] })
  const conflict = makeAgent(EXCLUDED_SESSION)
  runOnce([conflict])
  assert.equal(conflict.mounted.hooks, 0, '同时出现在两个名单里时，排除优先')

  // ⑤ 配置文件坏了不该让插件崩
  fs.writeFileSync(configPath, '{ 这不是 JSON')
  const broken = makeAgent(ALLOWED_SESSION)
  assert.doesNotThrow(() => runOnce([broken]), '配置坏了插件也不该崩')
  assert.equal(broken.mounted.hooks, 0, '首次读取损坏配置必须失败关闭，不能退回主库')

  console.log('会话范围测试：通过（排除、白名单、默认挂载、排除优先、坏配置失败关闭）')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
