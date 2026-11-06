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
writeFileSync(join(temporaryRoot, 'dsh-memory-v2-config.json'), JSON.stringify({ 会话白名单: ['test-tools'] }))
ctx.agents.list = () => [{ session: { id: 'test-tools' }, ctx: {
  tools: ctx.tools, on: () => () => {},
  systemPrompt: { section: () => () => {}, context: () => () => {} },
} }]
try {
  dispose = await apply(ctx)
  assert.equal(tools.size, 4)
  const hostStyle = detectedDeps.source === 'host'
  for (const tool of tools.values()) {
    // This is the exact pre-request contract rejected in the reported incident.
    if (hostStyle) {
      assert.equal(tool.parameters.type, 'object', `${tool.name}: model input must have object root`)
      assert.ok(tool.parameters.properties)
      assert.equal(tool.parameters.additionalProperties, false)
      assert.equal(tool.output.schema.type, 'object')
      assert.equal(tool.output.schema.additionalProperties, false)
      if (tool.name !== 'memory_consolidate') {
        const required = tool.name === 'memory_write' ? 'text' : 'query'
        assert.deepEqual(tool.parameters.required, [required])
        assert.equal(tool.parameters.properties[required].required, undefined)
      }
    } else {
      for (const key of ['type', 'properties', 'required']) {
        assert.equal(Object.hasOwn(tool.parameters, key), false, `${tool.name}: 本地扁平 spec 根级不应有 ${key}`)
      }
    }
    if (host && (tool.name === 'memory_write' || tool.name === 'memory_recall')) {
      host.assertObjectJsonSchema(tool.parameters)
      host.assertSupportedJsonSchema(tool.output.schema)
      const required = tool.name === 'memory_write' ? 'text' : 'query'
      assert.ok(host.validateJsonSchemaValue(tool.parameters, {}, '').length)
      assert.ok(host.validateJsonSchemaValue(tool.parameters, { [required]: 5 }, '').length)
      assert.deepEqual(host.validateJsonSchemaValue(tool.parameters, { [required]: 'schema regression test' }, ''), [])
    }
  }
  const write = tools.get('memory_write')
  const recall = tools.get('memory_recall')
  assert.equal((await write.execute({})).ok, false)
  assert.equal((await recall.execute({})).ok, false)
  const written = await write.execute({ text: 'schema regression test', source: 'isolated regression test' })
  assert.equal(written.ok, true)
  for (const collection of ['画像', '结论', '临时']) {
    const entry = await write.execute({ text: '跨集合回归', collection })
    const updated = await write.execute({ text: '同向证据', supersede: entry.id })
    assert.equal(updated.ok, true)
    assert.equal(updated.collection, collection)
    assert.equal((await write.execute({ text: '错误集合', collection: '语义', supersede: entry.id })).ok, false)
  }
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
  assert.equal(JSON.parse(body).条数, 4)
  await route.handler({ method: 'POST' }, { writeHead(code) { status = code }, end() {} })
  assert.equal(status, 405)
  dispose()
  dispose = null
  assert.equal(tools.size, 0)
  assert.equal(routes.size, 0)

  const options = { name: '回归测试', parameters: { type: 'object', additionalProperties: false } }
  assert.equal(localDefineTool(options), options)
  assert.doesNotThrow(() => localDefineTool({ ...options, parameters: { query: { type: 'string' } } }), '扁平 spec 应被接受')
  assert.throws(() => localDefineTool({ ...options, parameters: { type: 'object' } }), /additionalProperties/)
  assert.throws(() => localDefineTool({ ...options, output: { schema: { type: 'object' } } }), /output.schema/)
  assert.throws(() => localDefineTool({ ...options, parameters: {
    type: 'object', additionalProperties: false,
    properties: { records: { type: 'array', items: { type: 'object' } } },
  } }), /items.*additionalProperties/)

  // 用隔离宿主验证加载路径，以及 apply 确实把四个工具交给宿主 defineTool。
  const scope = join(temporaryRoot, 'host', '@deepseek-ai')
  const packageDir = join(scope, 'dsh-tools')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './index.mjs' } }))
  writeFileSync(join(packageDir, 'index.mjs'), 'export let calls = 0; export function defineTool(options) { calls++; return options }')
  process.env.DSH_HOST_MODULES = scope
  const fixtureDeps = await loadHostDeps()
  assert.equal(fixtureDeps.source, 'host')
  const fixture = await import(pathToFileURL(join(packageDir, 'index.mjs')).href)
  assert.equal(fixtureDeps.defineTool, fixture.defineTool)
  const { apply: fixtureApply } = await import(pluginUrl + '?fixture=' + Date.now())
  dispose = await fixtureApply(ctx)
  assert.equal(fixture.calls, 4)
  assert.equal(tools.size, 4)
  dispose()
  dispose = null
  assert.equal(tools.size, 0)
  assert.equal(routes.size, 0)
  console.log(`工具 Schema、写入/召回、渲染、统计、释放及宿主/本地两路：通过${host ? '（含已安装 DSH 校验器）' : ''}`)
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
