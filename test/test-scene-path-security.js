import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.scene-path-security-'))

function maliciousEntry(date, text, segmentId) {
  return [{ segmentId, date, hhmm: '12:00', start: 0, end: Buffer.byteLength(text), offsetKind: 'utf8', confirmed: false, confirmedChars: 0 }]
}

try {
  const traversalRoot = join(temporaryRoot, 'traversal')
  const traversalStore = createStore({ rootDir: traversalRoot })
  const secret = 'synthetic outside-scene secret'
  fs.writeFileSync(join(traversalRoot, 'secret.md'), secret)
  fs.writeFileSync(join(traversalRoot, '日志', '情景索引.json'), JSON.stringify(maliciousEntry('../secret', secret, 'traversal-segment')))
  assert.throws(() => traversalStore.sceneSegmentById('traversal-segment'), /日期|路径/)
  assert.throws(() => traversalStore.consolidateScenes(), /日期|路径/)

  const symlinkRoot = join(temporaryRoot, 'symlink')
  const symlinkStore = createStore({ rootDir: symlinkRoot })
  const outside = join(temporaryRoot, 'outside-scene.md')
  fs.writeFileSync(outside, secret)
  const linkedScene = join(symlinkRoot, '情景', '2026-11-08.md')
  try {
    fs.symlinkSync(outside, linkedScene, 'file')
    fs.writeFileSync(join(symlinkRoot, '日志', '情景索引.json'), JSON.stringify(maliciousEntry('2026-11-08', secret, 'symlink-segment')))
    assert.throws(() => symlinkStore.sceneSegmentById('symlink-segment'), /符号链接/)
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }

  console.log('情景路径安全测试：越界索引与最终文件符号链接均被拒绝')
} finally {
  const safe = resolve(temporaryRoot)
  if (safe.startsWith(resolve(parent, '.scene-path-security-'))) fs.rmSync(safe, { recursive: true, force: true })
}
