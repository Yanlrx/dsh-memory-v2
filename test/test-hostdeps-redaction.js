import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from '../lib/hostdeps.mjs'

const parent = dirname(fileURLToPath(import.meta.url))
const temporaryRoot = fs.mkdtempSync(join(parent, '.hostdeps-redaction-'))
const previousModules = process.env.DSH_HOST_MODULES

function makeHost(name, source) {
  const scope = join(temporaryRoot, name)
  const moduleRoot = join(scope, 'dsh-tools')
  fs.mkdirSync(moduleRoot, { recursive: true })
  fs.writeFileSync(join(moduleRoot, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
  fs.writeFileSync(join(moduleRoot, 'index.js'), source)
  return scope
}

function assertRedacted(result) {
  const notes = result.notes.join('\n')
  assert.equal(notes.includes(temporaryRoot), false)
  assert.doesNotMatch(notes, /file:/i)
  assert.doesNotMatch(notes, /[A-Za-z]:[\\/]/)
  assert.doesNotMatch(notes, /\/home\//)
}

try {
  process.env.DSH_HOST_MODULES = makeHost('success', 'export const defineTool = (value) => value\n')
  const success = await loadHostDeps()
  assert.equal(success.source, 'host')
  assertRedacted(success)

  process.env.DSH_HOST_MODULES = makeHost('failure', "const error = new Error('synthetic'); error.code = 'BAD/PATH'; throw error\n")
  const failure = await loadHostDeps()
  assertRedacted(failure)
  assert.equal(failure.notes.some((note) => note.includes('BAD/PATH')), false)
  console.log('宿主依赖日志测试：绝对路径与未净化错误码均不外泄')
} finally {
  if (previousModules === undefined) delete process.env.DSH_HOST_MODULES
  else process.env.DSH_HOST_MODULES = previousModules
  const safe = resolve(temporaryRoot)
  if (safe.startsWith(resolve(parent, '.hostdeps-redaction-'))) fs.rmSync(safe, { recursive: true, force: true })
}
