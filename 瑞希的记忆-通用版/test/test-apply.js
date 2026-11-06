// 2026-10-31：隔离存储和 diag，验证路由先注册及 tick/mount 异常；四组合测试随本次六项回归运行。
import assert from 'node:assert/strict'
// 2026-10-31：递归检查实际 schema 无 required，保留执行时必填校验；四组合测试随六项回归运行。
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mock } from 'node:test'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.apply-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = temporaryRoot
fs.writeFileSync(join(temporaryRoot, 'dsh-memory-v2-config.json'), JSON.stringify({ 会话白名单: ['apply-test'] }))
const diagnostics = []
const appendFileSync = fs.appendFileSync
mock.method(fs, 'appendFileSync', (path, data, ...args) => {
  if (String(path).endsWith('/memory-v2-diag.log')) {
    diagnostics.push(String(data))
    return
  }
  return appendFileSync(path, data, ...args)
})
syncBuiltinESMExports()

function assertNoRequired(value) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.hasOwn(value, 'required'), false, 'schema 不应包含 required')
  for (const child of Object.values(value)) assertNoRequired(child)
}

try {
  const { apply } = await import('../lib/index.js')
  for (const mode of ['normal', 'tick-error', 'mount-error']) {
    const calls = []
    const tools = []
    const routes = []
    let intervalTick
    const ctx = {
      tools: { register(tool) { tools.push(tool); return () => {} } },
      webServer: { register(value) { calls.push('route'); routes.push(value); return () => {} } },
      agents: {
        list() {
          calls.push('tick')
          if (mode === 'tick-error') throw new Error('模拟 list 失败')
          if (mode === 'mount-error') return [{ session: { id: 'apply-test' }, ctx: { on() { throw new Error('模拟 mount 失败') } } }]
          return []
        },
      },
      effect(fn) { return fn() },
      interval(fn, ms) { assert.equal(ms, 500); intervalTick = fn; return () => {} },
    }
    const diagStart = diagnostics.length
    const dispose = apply(ctx)
    assert.equal(typeof dispose, 'function', 'apply 应完整返回清理函数')
    assert.deepEqual(calls, ['route', 'route', 'tick'], '两条路由都要在 tick 之前注册')
    assert.deepEqual(routes.map((item) => item.path), ['/memory-v2/stats', '/memory-v2/candidates'])
    assert.equal(tools.length, 0, '不注册可绕过会话范围的全局工具')
    for (const tool of tools) {
      for (const key of ['type', 'properties', 'required']) assert.equal(Object.hasOwn(tool.parameters, key), false)
      for (const field of Object.values(tool.parameters)) assert.equal(typeof field.type, 'string')
      assertNoRequired(tool.parameters)
      assertNoRequired(tool.output.schema)
    }
    const statsRoute = routes.find((item) => item.path === '/memory-v2/stats')
    const candidatesRoute = routes.find((item) => item.path === '/memory-v2/candidates')
    let status
    let body
    const response = { writeHead(code) { status = code }, end(text) { body = JSON.parse(text) } }
    await statsRoute.handler({ method: 'GET' }, response)
    assert.equal(status, 200, mode + ' 时 stats 仍可用')
    assert.equal(body.条数, 0)
    await statsRoute.handler({ method: 'POST' }, response)
    assert.equal(status, 405)
    await candidatesRoute.handler({ method: 'GET' }, response)
    assert.equal(status, 403, mode + ' 时候选路由默认拒绝访问')
    await candidatesRoute.handler({ method: 'POST' }, response)
    assert.equal(status, 405)
    assert.doesNotThrow(() => intervalTick(), '后续 tick 也不应抛出')
    if (mode !== 'normal') {
      const expected = mode === 'tick-error' ? '模拟 list 失败' : '模拟 mount 失败'
      assert.equal(diagnostics.slice(diagStart).filter((line) => line.includes('tick 失败: ' + expected)).length, 2)
    }
    dispose()
    console.log('apply 回归通过：' + mode + '，路由先注册、GET 200、POST 405')
  }
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  const resolved = resolve(temporaryRoot)
  if (resolved.startsWith(resolve(parent, '.apply-'))) fs.rmSync(resolved, { recursive: true, force: true })
}
