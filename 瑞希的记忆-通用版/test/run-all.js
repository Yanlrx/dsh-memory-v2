import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const directory = new URL('./', import.meta.url)
for (const file of readdirSync(directory).filter((name) => /^test-.*\.js$/.test(name)).sort()) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, directory))], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
