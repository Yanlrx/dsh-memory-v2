import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.store-hardening-'))
const hash = (data) => createHash('sha256').update(data).digest('hex')
const record = (id, text, conflicts = null) => ({
  id, text, kind: ['事件'], 主体: '本人', 说话人: '本人', 原话: text, 我的推断: '',
  来源: 'synthetic', 门牌: 'synthetic', event_time: new Date().toISOString(), last_confirmed: null, ttl: null,
  置信度: 1, 证据: [], 出现次数: 1, 被召回次数: 0, 实体: [], 冲突: conflicts, 版本: 1, 状态: '生效',
})

function writeManifest(storeRoot, operation, stageData) {
  const stageDir = join(storeRoot, '.memory-v2-tx', 'tx-test')
  fs.mkdirSync(stageDir, { recursive: true })
  const staged = join(stageDir, '0.stage')
  fs.writeFileSync(staged, stageData)
  fs.writeFileSync(join(storeRoot, '.memory-v2-transaction.json'), JSON.stringify({
    version: 2,
    txid: 'tx-test',
    createdAt: new Date().toISOString(),
    stageDir: '.memory-v2-tx/tx-test',
    operations: [{ ...operation, staged: '.memory-v2-tx/tx-test/0.stage', sha256: hash(stageData), size: stageData.length }],
  }))
}

try {
  const replaceRoot = join(root, 'replace')
  fs.mkdirSync(replaceRoot, { recursive: true })
  const replacement = Buffer.from('{"ok":true}\n')
  writeManifest(replaceRoot, { kind: 'replace', target: '当前/语义.json' }, replacement)
  createStore({ rootDir: replaceRoot })
  assert.equal(fs.readFileSync(join(replaceRoot, '当前', '语义.json'), 'utf8'), replacement.toString())
  assert.equal(fs.existsSync(join(replaceRoot, '.memory-v2-transaction.json')), false)

  const appendRoot = join(root, 'append')
  fs.mkdirSync(join(appendRoot, '日志'), { recursive: true })
  fs.writeFileSync(join(appendRoot, '日志', 'append.txt'), 'abc')
  const appended = Buffer.from('abcdef')
  writeManifest(appendRoot, { kind: 'append', target: '日志/append.txt', offset: 0 }, appended)
  createStore({ rootDir: appendRoot })
  assert.equal(fs.readFileSync(join(appendRoot, '日志', 'append.txt'), 'utf8'), 'abcdef')

  const maliciousRoot = join(root, 'malicious')
  fs.mkdirSync(maliciousRoot, { recursive: true })
  writeManifest(maliciousRoot, { kind: 'replace', target: '../outside.txt' }, Buffer.from('blocked'))
  assert.throws(() => createStore({ rootDir: maliciousRoot }), /事务路径/)
  assert.equal(fs.existsSync(join(root, 'outside.txt')), false)

  const symlinkRoot = join(root, 'symlink')
  const symlinkOutside = join(root, 'symlink-outside')
  fs.mkdirSync(symlinkRoot, { recursive: true })
  fs.mkdirSync(symlinkOutside, { recursive: true })
  try {
    fs.symlinkSync(symlinkOutside, join(symlinkRoot, '当前'), 'junction')
    assert.throws(() => createStore({ rootDir: symlinkRoot }), /符号链接/)
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }

  const rootTarget = join(root, 'root-junction-target')
  const rootJunction = join(root, 'root-junction')
  fs.mkdirSync(rootTarget, { recursive: true })
  try {
    fs.symlinkSync(rootTarget, rootJunction, 'junction')
    assert.throws(() => createStore({ rootDir: rootJunction }), /符号链接/)
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }

  const parentTarget = join(root, 'parent-junction-target')
  const parentJunction = join(root, 'parent-junction')
  fs.mkdirSync(parentTarget, { recursive: true })
  try {
    fs.symlinkSync(parentTarget, parentJunction, 'junction')
    assert.throws(() => createStore({ rootDir: join(parentJunction, 'child-store') }), /符号链接/)
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }

  const lockRoot = join(root, 'lock')
  fs.mkdirSync(lockRoot, { recursive: true })
  const lockPath = join(lockRoot, '.memory-v2.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ version: 2, ownerId: 'live', pid: process.pid }))
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lockPath, old, old)
  assert.throws(() => createStore({ rootDir: lockRoot, lockTimeoutMs: 100, lockStaleMs: 50 }), /锁超时/)
  assert.equal(fs.existsSync(lockPath), true, '活进程的旧锁不得被抢走')
  fs.writeFileSync(lockPath, JSON.stringify({ version: 2, ownerId: 'dead', pid: 99999999 }))
  fs.utimesSync(lockPath, old, old)
  createStore({ rootDir: lockRoot, lockTimeoutMs: 500, lockStaleMs: 50 })
  assert.equal(fs.existsSync(lockPath), false, '死进程的陈旧锁应可恢复')

  const sceneRoot = join(root, 'scene')
  const store = createStore({ rootDir: sceneRoot })
  store.appendTurn('示例问题🙂', '示例回答', new Date('2026-11-07T12:00:00+08:00'))
  assert.match(store.traceScene('示例问题')[0].text, /示例问题🙂/)
  const statePath = join(sceneRoot, '日志', '巩固状态.json')
  const before = fs.statSync(statePath).mtimeMs
  store.readConsolidationState()
  store.readConsolidationState()
  assert.equal(fs.statSync(statePath).mtimeMs, before, '读取巩固状态不应重写文件')
  const lease = store.consolidateScenes(undefined, new Date('2026-11-07T12:01:00+08:00'))
  const abandoned = store.consolidateScenes(undefined, new Date('2026-11-07T12:02:00+08:00'), () => {}, { abandonToken: lease.ackToken })
  assert.equal(abandoned.abandoned, true)
  assert.equal(store.consolidateScenes(undefined, new Date(), () => {}, { abandonToken: lease.ackToken }).idempotent, true)
  assert.throws(() => store.consolidateScenes(undefined, new Date(), () => {}, { ackToken: lease.ackToken }), /已经放弃/)

  store.appendTurn('第二个问题', '第二个回答', new Date('2026-11-07T12:03:00+08:00'))
  const secondLease = store.consolidateScenes(undefined, new Date('2026-11-07T12:04:00+08:00'))
  assert.equal(store.consolidateScenes(undefined, new Date(), () => {}, { abandonToken: lease.ackToken }).idempotent, true, '存在新租约时旧 abandon 仍须幂等')
  store.consolidateScenes(undefined, new Date('2026-11-07T12:05:00+08:00'), () => {}, { ackToken: secondLease.ackToken })
  store.appendTurn('第三个问题', '第三个回答', new Date('2026-11-07T12:06:00+08:00'))
  const thirdLease = store.consolidateScenes(undefined, new Date('2026-11-07T12:07:00+08:00'))
  assert.equal(store.consolidateScenes(undefined, new Date(), () => {}, { ackToken: secondLease.ackToken }).idempotent, true, '存在新租约时旧 ACK 仍须幂等')
  store.consolidateScenes(undefined, new Date(), () => {}, { abandonToken: thirdLease.ackToken })

  const invariantRoot = join(root, 'invariants')
  const invariantStore = createStore({ rootDir: invariantRoot })
  invariantStore.appendRecord('语义', record('left', '左侧记录'))
  invariantStore.appendRecord('结论', record('right', '右侧记录'))
  invariantStore.replaceRecord('语义', record('left', '左侧记录更新', ['right']))
  assert.throws(() => invariantStore.replaceRecord('语义', record('left', '悬空冲突', ['missing'])), /找不到冲突记忆/)
  const invariantSnapshot = invariantStore.readAll()
  assert.deepEqual(invariantSnapshot.结论[0].冲突, ['left'], '低层 replaceRecord 也必须维护双向冲突')
  assert.equal(invariantStore.readCandidates().length, 3, '低层 append/replace 必须自动留下候选审计')
  assert.equal(Object.hasOwn(invariantStore, 'writeCollection'), false, '不安全的批量 writeCollection 不得公开')

  const resultsPath = join(sceneRoot, '日志', '巩固结果.jsonl')
  fs.writeFileSync(resultsPath, Array.from({ length: 1002 }, (_, index) => JSON.stringify({ token: `old-${index}`, status: 'abandoned', remaining: 0 })).join('\n') + '\n')
  store.appendTurn('轮转问题', '轮转回答', new Date('2026-11-07T12:08:00+08:00'))
  const rotationLease = store.consolidateScenes(undefined, new Date('2026-11-07T12:09:00+08:00'))
  store.consolidateScenes(undefined, new Date(), () => {}, { abandonToken: rotationLease.ackToken })
  const resultLines = fs.readFileSync(resultsPath, 'utf8').split(/\r?\n/).filter(Boolean)
  assert.equal(resultLines.length, 1000, '巩固终态日志必须保持有界')

  console.log('存储强化测试：事务、路径、根链接、活锁、幂等、低层不变量与日志轮转通过')
} finally {
  const safe = resolve(root)
  if (safe.startsWith(resolve(parent, '.store-hardening-'))) fs.rmSync(safe, { recursive: true, force: true })
}
