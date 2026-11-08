import assert from 'node:assert/strict'
// 2026-10-31：补异步注册及宿主/本地两路回归；四组合由 test-three.js 独立验证。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadHostDeps, localDefineTool } from '../lib/hostdeps.mjs'

// Optional installed-host validator, used when verifying against a packaged DSH.
const host = process.env.DSH_TOOLS_MODULE
  ? await import(pathToFileURL(process.env.DSH_TOOLS_MODULE).href)
  : null
const pluginUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(pluginUrl)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-memory-v2-tools-'))
const previousHome = process.env.DSH_HOME
const previousModules = process.env.DSH_HOST_MODULES
const tools = new Map()
const routes = new Map()
const ctx = {
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  agents: { list: () => [] },
  interval: () => () => {},
  effect: (callback) => callback(),
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
}
let dispose
// 在切换到隔离存储前检测当前安装环境，仅读取宿主依赖。
const detectedDeps = await loadHostDeps()
process.env.DSH_HOME = temporaryRoot
try {
  dispose = await apply(ctx, { 启用全局主库工具: true })
  assert.equal(tools.size, 4)
  for (const tool of tools.values()) {
    const isJsonSchema = tool.parameters.type === 'object' && tool.parameters.properties
    const fields = isJsonSchema ? tool.parameters.properties : tool.parameters
    assert.ok(fields && typeof fields === 'object')
    for (const field of Object.values(fields)) assert.equal(typeof field.type, 'string')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, false)
    const required = tool.name === 'memory_write' ? 'text' : (tool.name === 'memory_recall' || tool.name === 'memory_trace' ? 'query' : null)
    if (isJsonSchema) assert.deepEqual(tool.parameters.required, required ? [required] : undefined)
    if (required) assert.equal(fields[required].required, undefined)
    if (host && isJsonSchema) {
      host.assertObjectJsonSchema(tool.parameters)
      host.assertSupportedJsonSchema(tool.output.schema)
      if (required) {
        assert.ok(host.validateJsonSchemaValue(tool.parameters, {}, '').length)
        assert.ok(host.validateJsonSchemaValue(tool.parameters, { [required]: 5 }, '').length)
        assert.deepEqual(host.validateJsonSchemaValue(tool.parameters, { [required]: 'schema regression test' }, ''), [])
      }
    }
  }
  const write = tools.get('memory_write')
  const recall = tools.get('memory_recall')
  assert.equal((await write.execute({})).ok, false)
  assert.equal((await recall.execute({})).ok, false)
  const written = await write.execute({ text: 'schema regression test', source: 'isolated regression test' })
  assert.equal(written.ok, true)
  const recalled = await recall.execute({ query: 'schema regression test' })
  assert.equal(recalled.ok, true)
  assert.ok(recalled.records.some((record) => record.id === written.id))
  const content = recall.output.render({ query: 'schema regression test' }, recalled)
  assert.equal(JSON.parse(content[0].text).ok, true)
  if (host) assert.deepEqual(host.validateJsonSchemaValue(recall.output.schema, recalled, ''), [])
  let status
  let body
  const route = routes.get('/memory-v2/stats')
  await route.handler({ method: 'GET' }, { writeHead(code) { status = code }, end(value) { body = value } })
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).条数, 1)
  await route.handler({ method: 'POST' }, { writeHead(code) { status = code }, end() {} })
  assert.equal(status, 405)
  dispose()
  dispose = null
  assert.equal(tools.size, 0)
  assert.equal(routes.size, 0)

  const options = { name: '回归测试', parameters: { type: 'object', additionalProperties: false } }
  assert.equal(localDefineTool(options), options)
  assert.doesNotThrow(() => localDefineTool({ ...options, parameters: { query: { type: 'string' } } }))
  assert.throws(() => localDefineTool({ ...options, parameters: { type: 'object' } }), /additionalProperties/)
  assert.throws(() => localDefineTool({ ...options, output: { schema: { type: 'object' } } }), /output.schema/)
  assert.throws(() => localDefineTool({ ...options, parameters: {
    type: 'object', additionalProperties: false,
    properties: { records: { type: 'array', items: { type: 'object' } } },
  } }), /items.*additionalProperties/)

  console.log(`工具 Schema、写入/召回、渲染、统计与释放：通过${host ? '（含已安装 DSH 校验器）' : ''}`)
  console.log(`当前环境 defineTool 路径：${detectedDeps.source === 'host' ? '宿主' : '本地'}；${detectedDeps.notes.join('；')}`)
} finally {
  dispose?.()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousModules === undefined) delete process.env.DSH_HOST_MODULES
  else process.env.DSH_HOST_MODULES = previousModules
  const resolved = resolve(temporaryRoot)
  if (resolved.startsWith(resolve(tmpdir(), 'dsh-memory-v2-tools-'))) rmSync(resolved, { recursive: true, force: true })
}
