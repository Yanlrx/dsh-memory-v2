// 2026-10-31：验证扁平字段 spec 和必填标记，保留 object 校验回归；四组合测试随本次六项回归运行。
import assert from 'node:assert/strict'
// 2026-10-31：改为断言每字段有 type 且无 required；四组合测试随六项回归运行。
import { loadHostDeps, localDefineTool } from '../lib/hostdeps.mjs'

const { defineTool, source, notes } = await loadHostDeps()
console.log('defineTool 来源：' + source)
for (const note of notes) console.log('  note: ' + note)

const definitions = [
  {
    name: 'memory_write',
    description: '写入一条记忆',
    parameters: {
      text: { type: 'string', description: '正文' },
      collection: { type: 'string', description: '类别' },
      kinds: { type: 'array', items: { type: 'string' }, description: '类型' },
      entities: { type: 'array', items: { type: 'string' }, description: '实体' },
      source: { type: 'string', description: '来源' },
      doorplate: { type: 'string', description: '门牌' },
      ttl: { type: 'string', description: '有效期' },
      conflict: { type: 'array', items: { type: 'string' }, description: '冲突' },
    },
  },
  {
    name: 'memory_recall',
    description: '查记忆',
    parameters: {
      query: { type: 'string', description: '问题' },
      complex: { type: 'boolean', description: '复杂问题' },
    },
  },
]

for (const definition of definitions) {
  const options = {
    ...definition,
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() { return { ok: true } },
  }
  // 即使宿主可用，也单独验证本地兜底接受同一份扁平 spec。
  for (const factory of [defineTool, localDefineTool]) {
    const tool = factory(options)
    assert.ok(tool?.parameters, definition.name + ' 没有 parameters')
    for (const key of ['type', 'properties', 'required']) {
      assert.equal(Object.hasOwn(tool.parameters, key), false, '参数根级不应包含 ' + key)
    }
    for (const [key, field] of Object.entries(tool.parameters)) {
      assert.equal(typeof field?.type, 'string', tool.name + '.' + key + ' 没有 type')
      assert.equal(Object.hasOwn(field, 'required'), false, tool.name + '.' + key + ' 不应包含 required')
    }
  }
  console.log('OK ' + definition.name + ' 扁平参数数=' + Object.keys(definition.parameters).length)
}

assert.throws(() => localDefineTool({ name: 'bad', parameters: null }), /必须是对象/)
assert.throws(() => localDefineTool({ name: 'bad', parameters: { type: 'object' } }), /additionalProperties/)
assert.doesNotThrow(() => localDefineTool({ name: 'legacy', parameters: { type: 'object', additionalProperties: false } }))
assert.throws(() => localDefineTool({ name: 'bad-output', parameters: {}, output: { schema: { type: 'object' } } }), /additionalProperties/)
console.log('工具 spec 模拟测试：通过')
