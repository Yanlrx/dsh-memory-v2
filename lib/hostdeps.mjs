// 2026-10-31：本地 defineTool 接受扁平 spec，保留 object 的 additionalProperties 检查；四组合测试随本次六项回归运行。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function candidateRoots() {
  const roots = new Set()
  const push = (root) => { if (root) roots.add(root) }
  push(process.env.DSH_HOST_MODULES)
  // 同时覆盖插件和宿主入口的上层依赖树，不依赖启动时的 cwd。
  for (const start of [dirname(fileURLToPath(import.meta.url)), process.argv[1] && dirname(process.argv[1])]) {
    if (!start) continue
    for (let dir = start; ; dir = dirname(dir)) {
      push(join(dir, 'node_modules', '@deepseek-ai'))
      if (dirname(dir) === dir) break
    }
  }
  if (process.env.APPDATA) {
    const scope = join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai')
    push(join(scope, 'dsh', 'node_modules', '@deepseek-ai'))
    push(scope)
    try {
      for (const name of readdirSync(scope)) push(join(scope, name, 'node_modules', '@deepseek-ai'))
    } catch { /* 此安装位置不存在。 */ }
  }
  for (const base of ['/usr/local/lib/node_modules', '/usr/lib/node_modules']) {
    push(join(base, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(base, '@deepseek-ai'))
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有 profile 树时继续使用本地实现。 */ }
  return [...roots]
}

function entryUrlFor(root) {
  try {
    const dir = join(root, 'dsh-tools')
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const dot = pkg.exports?.['.'] ?? pkg.exports
    const entry = typeof dot === 'string' ? dot : dot?.import || dot?.default || pkg.module || pkg.main
    if (typeof entry !== 'string') return null
    const file = join(dir, entry)
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  return /^[A-Z0-9_-]{1,64}$/.test(code) ? code : 'ERR'
}

export function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError(`defineTool(${options.name}): ${where} 必须是对象`)
    }
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new TypeError(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [key, value] of Object.entries(schema.properties || {})) check(value, `${where}.properties.${key}`)
    if (schema.items) check(schema.items, `${where}.items`)
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      check(schema.additionalProperties, `${where}.additionalProperties`)
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      for (const value of schema[key] || []) check(value, `${where}.${key}`)
    }
  }
  check(options.parameters, 'parameters')
  if (options.output?.schema) check(options.output.schema, 'output.schema')
  log?.(`工具 ${options.name}：使用本地等价 defineTool`)
  return options
}

export async function loadHostDeps() {
  const notes = []
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root)
    if (!url) continue
    try {
      const mod = await import(url)
      if (typeof mod.defineTool === 'function') {
        notes.push('dsh-tools：从宿主依赖树取到')
        return { defineTool: mod.defineTool, source: 'host', notes }
      }
      notes.push('dsh-tools：宿主入口没有 defineTool')
    } catch (error) { notes.push(`dsh-tools：宿主加载失败（${safeErrorCode(error)}）`) }
  }
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') {
      notes.push('dsh-tools：通过模块解析取到')
      return { defineTool: mod.defineTool, source: 'host', notes }
    }
  } catch (error) { notes.push(`dsh-tools：模块不可用（${safeErrorCode(error)}）`) }
  notes.push('dsh-tools：使用本地等价实现')
  return { defineTool: (options) => localDefineTool(options, (note) => notes.push(note)), source: 'local', notes }
}
