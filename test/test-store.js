import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createStore } from '../lib/store.js'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-memory-v2-test-'))
const now = new Date('2026-10-31T12:00:00+08:00')

try {
  const store = createStore({ rootDir: temporaryRoot, now: () => now })
  const record = {
    id: 'memory-v2-smoke-001',
    text: '示例用户要求三类记录分别保存',
    kind: ['事件'],
    主体: '本人',
    说话人: '本人',
    原话: '「三类记录请分别保存」',
    我的推断: '',
    来源: '2026-10-31 12:00:00',
    门牌: 'test-session + 12:00',
    event_time: '2026-10-31T12:00:00+08:00',
    last_confirmed: null,
    ttl: null,
    置信度: 1,
    证据: [],
    出现次数: 1,
    被召回次数: 0,
    冲突: null,
    版本: 1,
    状态: '生效',
  }

  store.appendRecord('语义', record)

  const currentPath = join(temporaryRoot, '当前', '语义.json')
  assert.equal(existsSync(currentPath), true, '当前 JSON 应已存盘')
  assert.deepEqual(store.readCollection('语义'), [record], '读回内容应与写入一致')

  const legacyFiles = readdirSync(join(temporaryRoot, '旧版')).filter((name) => name.endsWith('.json.gz'))
  assert.equal(legacyFiles.length, 1, '旧版应有一份当日压缩副本')
  const legacy = JSON.parse(gunzipSync(readFileSync(join(temporaryRoot, '旧版', legacyFiles[0])), 'utf8'))
  assert.deepEqual(legacy.语义, [], '旧版应保存写入前的完整状态')

  const mirrorPath = join(temporaryRoot, '镜像', '2026-10-31.md')
  assert.equal(existsSync(mirrorPath), true, '镜像应已生成')
  assert.match(readFileSync(mirrorPath, 'utf8'), /示例用户要求三类记录分别保存/, '镜像应包含记录文字')

  const logPath = join(temporaryRoot, '日志', '写入日志.jsonl')
  assert.equal(existsSync(logPath), true, '追加式写入日志应存在')

  console.log('存储冒烟测试：通过')
} finally {
  const resolved = resolve(temporaryRoot)
  const allowedPrefix = resolve(tmpdir(), 'dsh-memory-v2-test-')
  if (resolved.startsWith(allowedPrefix)) rmSync(resolved, { recursive: true, force: true })
}
