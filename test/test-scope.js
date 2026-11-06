// test-scope.js —— 会话范围控制的回归。
// 验：默认关闭、白名单、显式全开、排除优先、异常时关闭。

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

const FRIEND = 'session-00000000-0000-0000-0000-000000000001'
const MINE = 'session-00000000-0000-0000-0000-000000000002'

// 造一个假 agent，记录它有没有被挂上（on 被调用 = 挂上了）
function makeAgent(sid) {
  const mounted = { hooks: 0 }
  return {
    mounted,
    agent: {
      session: { id: sid, snapshotEvents() { return [] } },
      ctx: {
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

  // ① 排除名单：朋友的会话不挂，我的照挂
  writeConfig({ 启用全部会话: true, 会话白名单: [], 排除会话: [FRIEND] })
  const friend = makeAgent(FRIEND)
  const mine = makeAgent(MINE)
  runOnce([friend, mine])
  assert.equal(friend.mounted.hooks, 0, '排除名单里的会话不该被挂')
  assert.ok(mine.mounted.hooks > 0, '我的会话应该被挂')

  // ② 白名单非空：只挂列表里的
  writeConfig({ 会话白名单: [MINE], 排除会话: [] })
  const another = makeAgent('session-other-1234')
  const mine2 = makeAgent(MINE)
  runOnce([another, mine2])
  assert.equal(another.mounted.hooks, 0, '白名单非空时，不在列表里的不该挂')
  assert.ok(mine2.mounted.hooks > 0, '白名单里的要挂')

  // ③ 两种都没配：默认关闭
  writeConfig({ 会话白名单: [], 排除会话: [] })
  const free1 = makeAgent(FRIEND)
  const free2 = makeAgent('session-x')
  runOnce([free1, free2])
  assert.equal(free1.mounted.hooks, 0, '没配名单默认不启用')
  assert.equal(free2.mounted.hooks, 0, '没配名单默认不启用')

  // ④ 排除优先于白名单
  writeConfig({ 会话白名单: [FRIEND], 排除会话: [FRIEND] })
  const conflict = makeAgent(FRIEND)
  runOnce([conflict])
  assert.equal(conflict.mounted.hooks, 0, '同时出现在两个名单里时，排除优先')

  // ⑤ 配置文件坏了不该让插件崩
  fs.writeFileSync(configPath, '{ 这不是 JSON')
  const broken = makeAgent(MINE)
  assert.doesNotThrow(() => runOnce([broken]), '配置坏了插件也不该崩')
  assert.equal(broken.mounted.hooks, 0, '配置损坏时关闭，不得扩大访问范围')

  writeConfig({ 启用全部会话: true })
  const unknown = makeAgent('')
  runOnce([unknown])
  assert.equal(unknown.mounted.hooks, 0, '拿不到 ID 时即使全开也不挂')
  fs.unlinkSync(configPath)
  const missing = makeAgent(MINE)
  runOnce([missing])
  assert.equal(missing.mounted.hooks, 0, '未配置时不挂')
  console.log('会话范围测试：通过（默认关闭、排除生效、白名单生效、显式全开、排除优先、配置异常关闭、无 ID 拒绝）')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
