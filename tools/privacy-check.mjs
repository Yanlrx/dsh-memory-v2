import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = resolve(process.env.DSH_MEMORY_PRIVACY_ROOT || defaultRoot)
const modeArgument = process.argv.find((value) => value.startsWith('--mode='))?.slice('--mode='.length)
const mode = modeArgument || process.env.DSH_MEMORY_PRIVACY_MODE || 'repository'
if (!['repository', 'artifact', 'installed'].includes(mode)) throw new TypeError(`Unsupported privacy scan mode: ${mode}`)
const ignoredDirectories = new Set(mode === 'installed' ? ['.git', 'node_modules'] : (mode === 'repository' ? ['.git'] : []))
const forbiddenDirectories = new Set(['models', 'coverage', 'dist', 'storages', 'backups', 'staging', ...(mode === 'artifact' ? ['.git', 'node_modules'] : []), ...(mode === 'repository' ? ['node_modules'] : [])])
const ignoredFiles = new Set(root === defaultRoot ? ['tools/privacy-check.mjs'] : [])
const textExtensions = new Set(['', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.gitignore', '.npmignore'])

const checks = [
  ['Windows absolute path', /(^|[^A-Za-z])[A-Za-z]:[\\/]/m],
  ['user-profile path', /Users[\\/][^\\/\s]+/i],
  ['Linux home path', /(^|[^A-Za-z0-9_])\/home\/[^/\s]+\//m],
  ['long numeric identifier', /(^|\D)\d{9,}(\D|$)/m],
  ['UUID-like identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ['runtime RPC identifier', new RegExp(['rpc', 'Id'].join(''), 'i')],
  ['raw identifier passed to diagnostics', /diag\s*\([^\n]*(?:\bsid\b|sessionId|rpcId)/i],
  ['private migration coupling', new RegExp([['fish', 'memory'].join('-'), ['dsh', 'fish'].join('-'), ['\u4e3b', '\u5e93-'].join('')].join('|'), 'i')],
  ['internal backup artifact', /codex-backup|\.original\b/i],
  ['common local administrator name', new RegExp(['Admin', 'istrator'].join(''), 'i')],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential token', /\b(?:ghp|github_pat|sk-proj|AKIA)[A-Za-z0-9_-]{12,}\b/],
  ['secret assignment', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|authorization)\s*[:=]\s*["'][^"']{6,}["']/i],
]

const pathChecks = [
  /(^|\/)backups?(\/|$)/i,
  /(^|\/)staging(\/|$)/i,
  /(^|\/)storages?(\/|$)/i,
  /\.bak(?:-|$)/i,
  /\.tmp$/i,
  /\.log$/i,
  /(^|\/)\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|zip|7z|rar)$/i,
  /(^|\/)(?:\.DS_Store|Thumbs\.db)$/i,
]

const failures = []

function filesUnder(directory) {
  const result = []
  let names
  try { names = readdirSync(directory) } catch (error) {
    failures.push(`${relative(root, directory).split(sep).join('/') || '.'}: unreadable directory (${error?.code || 'ERR'})`)
    return result
  }
  for (const name of names) {
    const path = join(directory, name)
    const stats = lstatSync(path)
    if (ignoredDirectories.has(name)) continue
    if (stats.isSymbolicLink()) {
      failures.push(`${relative(root, path).split(sep).join('/')}: symbolic links are not allowed in a release`)
      continue
    }
    if (stats.isDirectory() && forbiddenDirectories.has(name)) {
      failures.push(`${relative(root, path).split(sep).join('/')}: forbidden release directory`)
      continue
    }
    if (stats.isDirectory()) result.push(...filesUnder(path))
    else result.push(path)
  }
  return result
}

for (const path of filesUnder(root)) {
  const rel = relative(root, path).split(sep).join('/')
  if (ignoredFiles.has(rel)) continue
  for (const pattern of pathChecks) {
    if (pattern.test(rel)) failures.push(`${rel}: forbidden release artifact path`)
  }
  const extension = extname(path).toLowerCase()
  if (!textExtensions.has(extension) && !['.gitignore', '.npmignore'].includes(rel)) {
    failures.push(`${rel}: unsupported or binary file type`)
    continue
  }
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    failures.push(`${rel}: unreadable text file (${error?.code || 'ERR'})`)
    continue
  }
  if (text.includes('\0') || text.includes('\uFFFD')) failures.push(`${rel}: invalid or binary text content`)
  const authorAllowed = new Set(['package.json', 'README.md', 'LICENSE', 'RELEASE-CHECKLIST.md'])
  if ((text.includes('伊万莉瑞希') || text.includes('瑞希')) && !authorAllowed.has(rel)) failures.push(`${rel}: public author name outside allowlist`)
  for (const [label, pattern] of checks) {
    if ((rel === '.gitignore' || rel === '.npmignore') && label === 'internal backup artifact') continue
    if (pattern.test(text)) failures.push(`${rel}: ${label}`)
  }
}

const extraDenylist = String(process.env.DSH_MEMORY_PRIVACY_DENYLIST ?? '')
  .split(',').map((item) => item.trim()).filter(Boolean)
if (extraDenylist.length > 0) {
  for (const path of filesUnder(root)) {
    const rel = relative(root, path).split(sep).join('/')
    if (ignoredFiles.has(rel)) continue
    let text
    try { text = readFileSync(path, 'utf8') } catch (error) {
      failures.push(`${rel}: unreadable text file (${error?.code || 'ERR'})`)
      continue
    }
    for (const token of extraDenylist) {
      if (text.includes(token)) failures.push(`${rel}: custom denylist token`)
    }
  }
}

if (failures.length > 0) {
  console.error(`Privacy check failed (${failures.length}):`)
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Privacy check passed (${mode} mode): no machine-specific paths, runtime identifiers, backups or private migration artifacts found.`)
