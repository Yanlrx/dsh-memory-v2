import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tests = readdirSync(join(root, 'test'))
  .filter((name) => /^test-.*\.js$/.test(name))
  .sort()

for (const name of tests) {
  const result = spawnSync(process.execPath, [join(root, 'test', name)], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(`All ${tests.length} test files passed.`)
