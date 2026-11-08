import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.concurrency-'))

function run(prefix) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(parent, 'concurrency-worker.js'), root, prefix, '12'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let error = ''
    child.stderr.on('data', (chunk) => { error += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${prefix} exit ${code}: ${error}`)))
  })
}

try {
  await Promise.all([run('A'), run('B')])
  const store = createStore({ rootDir: root })
  const rows = store.readCollection('语义')
  assert.equal(rows.length, 24, '两进程同时各写 12 条不得丢更新')
  assert.equal(new Set(rows.map((row) => row.id)).size, 24)
  assert.equal(fs.existsSync(join(root, '.memory-v2-transaction.json')), false)
  assert.equal(fs.existsSync(join(root, '.memory-v2.lock')), false)

  const staleLock = join(root, '.memory-v2.lock')
  fs.writeFileSync(staleLock, '{}')
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(staleLock, old, old)
  store.writePolicy({ staleLockRecovered: true })
  assert.equal(store.readAll().策略.staleLockRecovered, true)
  console.log('跨进程锁、无丢写与陈旧锁恢复测试：通过')
} finally {
  const safe = resolve(root)
  if (safe.startsWith(resolve(parent, '.concurrency-'))) fs.rmSync(safe, { recursive: true, force: true })
}
