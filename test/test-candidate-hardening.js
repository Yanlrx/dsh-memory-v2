import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.candidate-hardening-'))

try {
  const store = createStore({ rootDir: temporaryRoot })
  const invalid = [undefined, null, 'text', [], 1]
  for (const candidate of invalid) assert.throws(() => store.appendCandidate(candidate), /候选/)

  const circular = { id: 'circular' }
  circular.self = circular
  assert.throws(() => store.appendCandidate(circular), /序列化/)
  assert.deepEqual(store.readCandidates(), [], '非法候选不得污染工作集')

  const valid = { id: 'valid', 类型: '事实', text: 'synthetic candidate', 来源: 'test', 置信度: 0.5 }
  store.appendCandidate(valid)
  const candidates = store.readCandidates()
  assert.deepEqual(candidates, [valid])
  const logDir = join(temporaryRoot, '日志')
  for (const name of fs.readdirSync(logDir).filter((item) => item.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(join(logDir, name), 'utf8').split(/\r?\n/).filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line))
  }
  assert.throws(() => store.writeCandidates([valid, null]), /候选/)
  assert.deepEqual(store.readCandidates(), [valid], '批量写入含非法候选时必须保持原工作集')
  console.log('候选强化测试：非法值不落盘，JSONL 始终可解析')
} finally {
  const safe = resolve(temporaryRoot)
  if (safe.startsWith(resolve(parent, '.candidate-hardening-'))) fs.rmSync(safe, { recursive: true, force: true })
}
