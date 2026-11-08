import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.multi-apply-'))
const homeA = join(root, 'a')
const homeB = join(root, 'b')
fs.mkdirSync(homeA, { recursive: true })
fs.mkdirSync(homeB, { recursive: true })
const previousHome = process.env.DSH_HOME

function makeContext() {
  const routes = []
  const tools = []
  return {
    routes,
    tools,
    ctx: {
      tools: { register(tool) { tools.push(tool); return () => {} } },
      agents: { list: () => [] },
      interval: () => () => {},
      effect: (callback) => callback(),
      on: () => () => {},
      webServer: { register(route) { routes.push(route); return () => {} } },
    },
  }
}

try {
  const { apply } = await import('../lib/index.js')
  process.env.DSH_HOME = homeA
  const first = makeContext()
  const disposeA = apply(first.ctx, {
    诊断日志: true,
    启用敏感调试路由: true,
    启用全局主库工具: true,
  })

  process.env.DSH_HOME = homeB
  const second = makeContext()
  const disposeB = apply(second.ctx, {
    诊断日志: false,
    启用敏感调试路由: false,
    启用全局主库工具: false,
  })

  assert.deepEqual(first.routes.map((route) => route.path), ['/memory-v2/stats', '/memory-v2/candidates'])
  assert.deepEqual(first.tools.map((tool) => tool.name), ['memory_write', 'memory_trace', 'memory_recall', 'memory_consolidate'])
  assert.deepEqual(second.routes.map((route) => route.path), ['/memory-v2/stats'])
  assert.equal(second.tools.length, 0, '第二次 apply 不得继承第一次的全局工具开关')
  assert.equal(fs.existsSync(join(homeA, 'memory-v2-diag.log')), true)
  assert.equal(fs.existsSync(join(homeB, 'memory-v2-diag.log')), false, '诊断开关不得跨 apply 泄漏')

  disposeB()
  disposeA()
  console.log('多实例隔离测试：诊断、敏感路由与全局工具开关互不串扰')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const safe = resolve(root)
  if (safe.startsWith(resolve(parent, '.multi-apply-'))) fs.rmSync(safe, { recursive: true, force: true })
}
