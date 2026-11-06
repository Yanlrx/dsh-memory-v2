import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStore } from '../lib/store.js'
import { heavy, light } from '../lib/consolidate.js'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-memory-v2-consolidate-'))
const now = new Date('2026-10-31T12:00:00+08:00')

try {
  const store = createStore({ rootDir: temporaryRoot, now: () => now })
  const before = store.readAll()
  const first = light('用户明确要求以后不要提扎托', { store, now, 来源: 'round-1' })
  assert.ok(first, '轻量巩固应能产生候选')
  assert.equal(first.类型, '事实', '轻量候选应为事实')
  assert.deepEqual(store.readAll(), before, '候选不得写入记忆库')

  for (let index = 1; index < 50; index++) {
    store.appendCandidate({ id: `seed-${index}`, 类型: '事实', text: `候选${index}`, 来源: 'seed', 置信度: 0.5 })
  }
  assert.equal(store.readCandidates().length, 50, '裁剪前应有 50 条')
  const newest = light('用户决定以后固定用新配置', { store, now, 来源: 'round-51' })
  const kept = store.readCandidates()
  assert.equal(kept.length, 50, '候选不得超过 50 条')
  assert.equal(kept.some((item) => item.id === first.id), false, '应丢掉最旧候选')
  assert.equal(kept.some((item) => item.id === newest.id), true, '应保留最新候选')

  const logPath = join(temporaryRoot, '日志', '写入日志.jsonl')
  assert.equal(existsSync(logPath), true, '丢弃候选时应有日志')
  assert.match(readFileSync(logPath, 'utf8'), /drop-oldest-candidate/, '日志应记录丢弃最旧候选')

  const consolidated = heavy([
    { text: '用户喜欢扎托', 来源: 'r1' },
    { text: '用户喜欢扎托', 来源: 'r2' },
    { text: '用户不喜欢扎托', 来源: 'r3' },
  ], { now })
  assert.equal(consolidated.some((item) => item.类型 === '结论'), true, '重活应去重并产生结论')
  assert.equal(consolidated.some((item) => item.类型 === '冲突'), true, '重活应查出冲突')
  assert.deepEqual(store.readAll(), before, '重活也不得写入记忆库')

  console.log('巩固测试：通过（轻量候选、不写库、超 50 裁最旧并记日志）')
} finally {
  const resolved = resolve(temporaryRoot)
  const allowedPrefix = resolve(tmpdir(), 'dsh-memory-v2-consolidate-')
  if (resolved.startsWith(allowedPrefix)) rmSync(resolved, { recursive: true, force: true })
}

