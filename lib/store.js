import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'

const RECORD_COLLECTIONS = Object.freeze({
  语义: '语义.json',
  结论: '结论.json',
  画像: '画像.json',
  临时: '临时.json',
})

const POLICY_COLLECTION = '策略.json'
const CANDIDATE_FILE = '候选.jsonl'
const CANDIDATE_LIMIT = 50
const CONSOLIDATION_RESULT_LIMIT = 1000
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30000
const TTL_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|mo|y)$/
const ALLOWED_KINDS = new Set(['事件', '状态', '偏好', '策略'])

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function stableSceneId(entry) {
  if (entry?.segmentId) return String(entry.segmentId)
  return `legacy-${createHash('sha256').update(`${entry?.date ?? ''}:${entry?.start ?? ''}:${entry?.end ?? ''}`).digest('hex').slice(0, 20)}`
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, data, { flag: 'wx' })
  const handle = openSync(temporaryPath, 'r+')
  try { fsyncSync(handle) } finally { closeSync(handle) }
  renameSync(temporaryPath, path)
}

function localDay(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('日期无效')
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('记录必须是对象')
  }

  const required = ['id', 'text', 'kind', '主体', '说话人', '来源', '门牌', '置信度', '证据', '出现次数', '被召回次数', '版本', '状态']
  for (const field of required) {
    if (!(field in record)) throw new TypeError(`记录缺少字段：${field}`)
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') throw new TypeError('id 不许为空')
  if (typeof record.text !== 'string' || record.text.length === 0 || record.text.length > 100) throw new TypeError('text 必须为 1~100 字')
  if (!Array.isArray(record.kind) || record.kind.length === 0) throw new TypeError('kind 必须是非空数组')
  if (record.kind.some((kind) => typeof kind !== 'string' || !ALLOWED_KINDS.has(kind))) throw new TypeError('kind 包含未知类型')
  if (typeof record.门牌 !== 'string' || record.门牌.trim() === '' || record.门牌 === '位置未知') throw new TypeError('门牌不许为空或写位置未知')
  if (!Array.isArray(record.证据)) throw new TypeError('证据必须是数组')
  if (record.实体 !== undefined && (!Array.isArray(record.实体) || record.实体.length > 5 || record.实体.some((item) => typeof item !== 'string' || !item.trim()))) throw new TypeError('实体必须是最多 5 个非空字符串')
  if (record.冲突 !== null && record.冲突 !== undefined && (!Array.isArray(record.冲突) || record.冲突.some((item) => typeof item !== 'string' || !item.trim()))) throw new TypeError('冲突必须是非空字符串数组或 null')

  const kinds = record.kind
  if (kinds.includes('状态') && (kinds.includes('偏好') || kinds.includes('策略'))) throw new TypeError('状态不能和偏好或策略同时写入')
  if (kinds.includes('事件') && !record.event_time) throw new TypeError('事件必须有 event_time')
  if (kinds.includes('状态')) {
    if (!record.last_confirmed || !record.ttl) throw new TypeError('状态必须有 last_confirmed 和 ttl')
    const match = String(record.ttl).trim().match(TTL_PATTERN)
    if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) throw new TypeError('状态 ttl 格式无效')
  }
  if (kinds.includes('偏好') && (!record.last_confirmed || record.ttl !== null)) throw new TypeError('偏好必须有 last_confirmed，且 ttl 为 null')
  // 2026-10-31：策略 = 「我该怎么应对他」，不是「他是什么样的人」。
  // 跟偏好一样是持续有效的，所以要求 last_confirmed、不许有 ttl。
  if (kinds.includes('策略') && (!record.last_confirmed || record.ttl !== null)) throw new TypeError('策略必须有 last_confirmed，且 ttl 为 null')
}

function renderMirror(snapshot, writtenAt) {
  const lines = [`# 记忆镜像 ${localDay(writtenAt)}`, '']
  for (const collection of Object.keys(RECORD_COLLECTIONS)) {
    lines.push(`## ${collection}`, '')
    const records = snapshot[collection]
    if (records.length === 0) {
      lines.push('（空）', '')
      continue
    }
    for (const record of records) {
      lines.push(`- ${record.text}`)
      lines.push(`  - ID：${record.id}`)
      lines.push(`  - 类型：${record.kind.join('、')}`)
      lines.push(`  - 来源：${record.来源}`)
      lines.push(`  - 门牌：${record.门牌}`)
      if (record.原话) lines.push(`  - 原话：${record.原话}`)
      if (record.我的推断) lines.push(`  - 我的推断：${record.我的推断}`)
    }
    lines.push('')
  }
  lines.push('## 策略', '', '```json', JSON.stringify(snapshot.策略, null, 2), '```', '')
  return `${lines.join('\n')}\n`
}

  // 镜像 md 是便于人工查看的摘要（字段不全），
// 这份 txt 把每条记录的所有字段都列全，方便「未来的我」照着复刻还原记忆。
function renderFullText(snapshot, writtenAt) {
  const lines = [`# 记忆完整备份 ${localDay(writtenAt)}`, '']
  for (const collection of Object.keys(RECORD_COLLECTIONS)) {
    lines.push(`## ${collection}`, '')
    const records = snapshot[collection]
    if (records.length === 0) {
      lines.push('（空）', '')
      continue
    }
    records.forEach((record, index) => {
      lines.push(`- [${index + 1}] ${record.text}`)
      for (const [key, value] of Object.entries(record)) {
        if (key === 'text') continue
        let shown
        if (value === undefined || value === null) shown = '（无）'
        else if (typeof value === 'object') shown = JSON.stringify(value)
        else shown = String(value)
        lines.push(`  - ${key}：${shown}`)
      }
    })
    lines.push('')
  }
  lines.push('## 策略', '', '```json', JSON.stringify(snapshot.策略, null, 2), '```', '')
  return `${lines.join('\n')}\n`
}

export function createStore(options = {}) {
  const rootDir = options.rootDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-memory')
  const clock = typeof options.now === 'function' ? options.now : () => new Date()
  const currentDir = join(rootDir, '当前')
  const sceneDir = join(rootDir, '情景')
  const legacyDir = join(rootDir, '旧版')
  const mirrorDir = join(rootDir, '镜像')
  const logDir = join(rootDir, '日志')
  const lockPath = join(rootDir, '.memory-v2.lock')
  const transactionPath = join(rootDir, '.memory-v2-transaction.json')
  const transactionStageRoot = join(rootDir, '.memory-v2-tx')
  const lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? Math.max(1, Number(options.lockTimeoutMs)) : LOCK_TIMEOUT_MS
  const lockStaleMs = Number.isFinite(options.lockStaleMs) ? Math.max(100, Number(options.lockStaleMs)) : LOCK_STALE_MS
  let lockDepth = 0
  let lockHandle = null
  let lockOwnerId = null

  function assertNoSymlinkComponents(path) {
    const absolute = resolve(path)
    const root = parse(absolute).root
    let cursor = root
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
      cursor = join(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('记忆库路径不能穿过符号链接')
    }
  }

  function ensureDirectories() {
    assertNoSymlinkComponents(rootDir)
    if (existsSync(rootDir) && lstatSync(rootDir).isSymbolicLink()) throw new Error('记忆库根目录不能是符号链接')
    mkdirSync(rootDir, { recursive: true })
    assertNoSymlinkComponents(rootDir)
    if (lstatSync(rootDir).isSymbolicLink()) throw new Error('记忆库根目录不能是符号链接')
    for (const path of [currentDir, sceneDir, legacyDir, mirrorDir, logDir, transactionStageRoot]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('记忆库目录不能是符号链接')
      mkdirSync(path, { recursive: true })
      if (lstatSync(path).isSymbolicLink()) throw new Error('记忆库目录不能是符号链接')
    }
  }

  function acquireLock() {
    if (lockDepth > 0) { lockDepth += 1; return }
    ensureDirectories()
    const started = Date.now()
    while (true) {
      try {
        lockHandle = openSync(lockPath, 'wx')
        lockOwnerId = randomUUID()
        writeFileSync(lockHandle, JSON.stringify({ version: 2, ownerId: lockOwnerId, pid: process.pid, at: new Date().toISOString() }))
        fsyncSync(lockHandle)
        lockDepth = 1
        return
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const stale = Date.now() - statSync(lockPath).mtimeMs > lockStaleMs
          let ownerAlive = true
          try {
            const metadata = JSON.parse(readFileSync(lockPath, 'utf8'))
            const pid = Number(metadata?.pid)
            if (!Number.isSafeInteger(pid) || pid <= 0) ownerAlive = false
            else {
              try { process.kill(pid, 0) } catch (probeError) { ownerAlive = probeError?.code === 'EPERM' }
            }
          } catch { ownerAlive = false }
          if (stale && !ownerAlive) {
            unlinkSync(lockPath)
            continue
          }
        } catch { /* 锁文件短暂变化或不可读时，仍须遵守超时与退避 */ }
        if (Date.now() - started >= lockTimeoutMs) throw new Error('记忆库正在被其他会话写入，等待锁超时')
        sleepSync(25)
      }
    }
  }

  function refreshLock() {
    if (lockHandle === null) return
    try { futimesSync(lockHandle, new Date(), new Date()) } catch {}
  }

  function releaseLock() {
    if (lockDepth <= 0) return
    lockDepth -= 1
    if (lockDepth > 0) return
    try { if (lockHandle !== null) closeSync(lockHandle) } finally {
      lockHandle = null
      try {
        const metadata = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (metadata?.ownerId === lockOwnerId) unlinkSync(lockPath)
      } catch {}
      lockOwnerId = null
    }
  }

  function withLock(callback) {
    acquireLock()
    try { return callback() } finally { releaseLock() }
  }

  function sha256(data) {
    return createHash('sha256').update(data).digest('hex')
  }

  function relativeWithinRoot(path) {
    const absolute = resolve(path)
    const base = resolve(rootDir)
    if (absolute === base || !absolute.startsWith(base + sep)) throw new Error('事务路径越界')
    return relative(base, absolute).split(sep).join('/')
  }

  function resolveWithinRoot(path) {
    if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('事务路径必须是相对路径')
    const absolute = resolve(rootDir, path.split('/').join(sep))
    const base = resolve(rootDir)
    if (absolute === base || !absolute.startsWith(base + sep)) throw new Error('事务路径越界')
    let cursor = base
    for (const part of relative(base, absolute).split(sep)) {
      cursor = join(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('事务路径不能穿过符号链接')
    }
    return absolute
  }

  function sceneFilePath(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('情景索引日期无效')
    return resolveWithinRoot(`情景/${day}.md`)
  }

  function fileHash(path) {
    return existsSync(path) ? sha256(readFileSync(path)) : null
  }

  function rangeHash(path, offset, size) {
    if (!existsSync(path)) return null
    const handle = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(size)
      const read = readSync(handle, buffer, 0, size, offset)
      return read === size ? sha256(buffer) : null
    } finally { closeSync(handle) }
  }

  function applyTransactionOperation(operation) {
    const target = resolveWithinRoot(operation.target)
    if (operation.kind === 'replace') {
      if (fileHash(target) === operation.sha256) return
      const staged = resolveWithinRoot(operation.staged)
      if (!existsSync(staged) || fileHash(staged) !== operation.sha256) throw new Error('事务暂存文件缺失或哈希不匹配')
      mkdirSync(dirname(target), { recursive: true })
      renameSync(staged, target)
      if (fileHash(target) !== operation.sha256) throw new Error('事务替换后校验失败')
      return
    }
    if (operation.kind === 'append') {
      const staged = resolveWithinRoot(operation.staged)
      if (rangeHash(target, operation.offset, operation.size) === operation.sha256) {
        try { if (existsSync(staged)) unlinkSync(staged) } catch {}
        return
      }
      if (!existsSync(staged) || fileHash(staged) !== operation.sha256) throw new Error('事务追加暂存文件缺失或哈希不匹配')
      const data = readFileSync(staged)
      mkdirSync(dirname(target), { recursive: true })
      const size = existsSync(target) ? statSync(target).size : 0
      if (size === operation.offset) appendFileSync(target, data)
      else if (size > operation.offset && size < operation.offset + operation.size) {
        const partialSize = size - operation.offset
        if (rangeHash(target, operation.offset, partialSize) !== sha256(data.subarray(0, partialSize))) throw new Error('事务追加部分内容不匹配')
        truncateSync(target, operation.offset)
        appendFileSync(target, data)
      } else if (size < operation.offset) throw new Error('事务追加目标比预期更短')
      if (rangeHash(target, operation.offset, operation.size) !== operation.sha256) throw new Error('事务追加后校验失败')
      try { unlinkSync(staged) } catch {}
      return
    }
    if (operation.kind === 'delete') {
      if (!existsSync(target)) return
      if (operation.expectedSha256 && fileHash(target) !== operation.expectedSha256) throw new Error('事务删除目标已变化')
      unlinkSync(target)
      return
    }
    throw new Error('未知事务操作')
  }

  function recoverTransactionUnlocked(path = transactionPath) {
    if (!existsSync(path)) return false
    const transaction = readJson(path, null)
    if (!transaction || typeof transaction !== 'object') throw new Error('记忆事务日志已损坏')
    if (transaction.version !== 2) {
      if (!Array.isArray(transaction.files)) throw new Error('旧事务日志已损坏')
      for (const item of transaction.files) {
        const temporaryPath = resolveWithinRoot(relativeWithinRoot(resolve(String(item?.temporaryPath ?? ''))))
        const targetPath = resolveWithinRoot(relativeWithinRoot(resolve(String(item?.path ?? ''))))
        if (existsSync(temporaryPath)) renameSync(temporaryPath, targetPath)
        else if (!existsSync(targetPath)) throw new Error('旧事务缺少暂存文件和目标文件')
      }
      unlinkSync(path)
      return true
    }
    if (!Array.isArray(transaction.operations)) throw new Error('事务操作列表无效')
    for (const operation of transaction.operations) {
      refreshLock()
      applyTransactionOperation(operation)
    }
    for (const operation of transaction.operations) {
      const target = resolveWithinRoot(operation.target)
      if (operation.kind === 'replace' && fileHash(target) !== operation.sha256) throw new Error('事务最终替换校验失败')
      if (operation.kind === 'append' && rangeHash(target, operation.offset, operation.size) !== operation.sha256) throw new Error('事务最终追加校验失败')
      if (operation.kind === 'delete' && existsSync(target)) throw new Error('事务最终删除校验失败')
    }
    unlinkSync(path)
    if (transaction.stageDir) {
      const stageDir = resolveWithinRoot(transaction.stageDir)
      try { rmSync(stageDir, { recursive: true, force: true }) } catch {}
    }
    return true
  }

  function runTransactionUnlocked(operations, path = transactionPath) {
    if (!Array.isArray(operations) || operations.length === 0) return
    if (existsSync(path)) recoverTransactionUnlocked(path)
    const txid = randomUUID()
    const stageDir = join(transactionStageRoot, txid)
    mkdirSync(stageDir, { recursive: true })
    const virtualSizes = new Map()
    const manifestOperations = operations.map((operation, index) => {
      const target = resolve(operation.target)
      const targetRelative = relativeWithinRoot(target)
      if (operation.kind === 'delete') {
        virtualSizes.set(targetRelative, 0)
        return { kind: 'delete', target: targetRelative, expectedSha256: operation.expectedSha256 ?? fileHash(target) }
      }
      const data = Buffer.isBuffer(operation.data) ? operation.data : Buffer.from(String(operation.data), 'utf8')
      const staged = join(stageDir, `${index}.stage`)
      writeFileSync(staged, data, { flag: 'wx' })
      const handle = openSync(staged, 'r+')
      try { fsyncSync(handle) } finally { closeSync(handle) }
      const common = { kind: operation.kind, target: targetRelative, staged: relativeWithinRoot(staged), sha256: sha256(data), size: data.length }
      if (operation.kind === 'append') {
        common.offset = virtualSizes.has(targetRelative) ? virtualSizes.get(targetRelative) : (existsSync(target) ? statSync(target).size : 0)
        virtualSizes.set(targetRelative, common.offset + data.length)
      } else if (operation.kind === 'replace') virtualSizes.set(targetRelative, data.length)
      return common
    })
    const manifest = { version: 2, txid, createdAt: new Date(clock()).toISOString(), stageDir: relativeWithinRoot(stageDir), operations: manifestOperations }
    atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`)
    recoverTransactionUnlocked(path)
  }

  function readAllUnlocked() {
    const snapshot = {}
    for (const [collection, file] of Object.entries(RECORD_COLLECTIONS)) {
      const value = readJson(join(currentDir, file), [])
      if (!Array.isArray(value)) throw new TypeError(`${file} 必须是数组`)
      snapshot[collection] = value
    }
    const policy = readJson(join(currentDir, POLICY_COLLECTION), {})
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError(`${POLICY_COLLECTION} 必须是对象`)
    snapshot.策略 = policy
    return snapshot
  }

  function readAll() {
    return withLock(() => {
      recoverTransactionUnlocked()
      return readAllUnlocked()
    })
  }

  function readCollection(collection) {
    if (!(collection in RECORD_COLLECTIONS)) throw new TypeError(`未知记忆类别：${collection}`)
    return readAll()[collection]
  }

  function ensureLegacy(snapshot, writtenAt) {
    const legacyPath = join(legacyDir, `${localDay(writtenAt)}.json.gz`)
    if (!existsSync(legacyPath)) {
      atomicWrite(legacyPath, gzipSync(`${JSON.stringify(snapshot, null, 2)}\n`))
    }
    return legacyPath
  }

  function appendLogUnlocked(entry) {
    ensureDirectories()
    const path = join(logDir, '写入日志.jsonl')
    runTransactionUnlocked([{ kind: 'append', target: path, data: `${JSON.stringify(entry)}\n` }])
  }

  function appendLog(entry) {
    return withLock(() => appendLogUnlocked(entry))
  }

  function validateSnapshotInvariants(snapshot) {
    const byId = new Map()
    for (const collection of Object.keys(RECORD_COLLECTIONS)) {
      if (!Array.isArray(snapshot[collection])) throw new TypeError(`${collection} 必须是数组`)
      for (const record of snapshot[collection]) {
        validateRecord(record)
        if (byId.has(record.id)) throw new TypeError(`id 跨集合重复：${record.id}`)
        byId.set(record.id, record)
      }
    }
    for (const record of byId.values()) {
      for (const conflictId of record.冲突 ?? []) {
        if (conflictId === record.id) throw new TypeError(`记忆不能与自身冲突：${record.id}`)
        const target = byId.get(conflictId)
        if (!target) throw new TypeError(`找不到冲突记忆：${conflictId}`)
        if (!(target.冲突 ?? []).includes(record.id)) throw new TypeError(`冲突关系必须双向：${record.id} ↔ ${conflictId}`)
      }
    }
  }

  function automaticCandidate(record, collection, type) {
    return {
      id: randomUUID(), 类型: type, text: record.text, 来源: 'store-api',
      置信度: record.置信度, created_at: new Date(clock()).toISOString(),
      状态: '已转正', 落库id: record.id, 落库类别: collection,
    }
  }

  function normalizeCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TypeError('候选必须是对象')
    let serialized
    try { serialized = JSON.stringify(candidate) } catch { throw new TypeError('候选必须可序列化为 JSON') }
    if (typeof serialized !== 'string') throw new TypeError('候选必须可序列化为 JSON 对象')
    const normalized = JSON.parse(serialized)
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new TypeError('候选必须是 JSON 对象')
    return normalized
  }

  function commitUnlocked(snapshot, detail, options = {}) {
    ensureDirectories()
    recoverTransactionUnlocked()
    const writtenAt = clock()
    const prior = readAllUnlocked()
    if (options.legacy !== false) ensureLegacy(prior, writtenAt)

    validateSnapshotInvariants(snapshot)
    if (!snapshot.策略 || typeof snapshot.策略 !== 'object' || Array.isArray(snapshot.策略)) {
      throw new TypeError('策略必须是对象')
    }

    const selected = options.collections ? new Set(options.collections) : new Set(Object.keys(RECORD_COLLECTIONS))
    const staged = []
    for (const [collection, file] of Object.entries(RECORD_COLLECTIONS)) {
      if (!selected.has(collection)) continue
      staged.push([join(currentDir, file), `${JSON.stringify(snapshot[collection], null, 2)}\n`])
    }
    if (options.policy !== false && !options.collections) {
      staged.push([join(currentDir, POLICY_COLLECTION), `${JSON.stringify(snapshot.策略, null, 2)}\n`])
    }
    if (options.mirror !== false) {
      staged.push([join(mirrorDir, `${localDay(writtenAt)}.md`), renderMirror(snapshot, writtenAt)])
      staged.push([join(mirrorDir, `${localDay(writtenAt)}.txt`), renderFullText(snapshot, writtenAt)])
    }
    const operations = staged.map(([target, data]) => ({ kind: 'replace', target, data }))
    for (const extra of options.extraFiles ?? []) operations.push(extra)
    operations.push({ kind: 'append', target: join(logDir, '写入日志.jsonl'), data: `${JSON.stringify({
      time: new Date(writtenAt).toISOString(),
      action: detail.action,
      collection: detail.collection ?? null,
      id: detail.id ?? null,
    })}\n` })
    refreshLock()
    runTransactionUnlocked(operations)
  }

  function commit(snapshot, detail, options = {}) {
    return withLock(() => commitUnlocked(snapshot, detail, options))
  }

  function writeCollection(collection, records) {
    if (!(collection in RECORD_COLLECTIONS)) throw new TypeError(`未知记忆类别：${collection}`)
    if (!Array.isArray(records)) throw new TypeError('写入内容必须是数组')
    return withLock(() => {
      const snapshot = readAllUnlocked()
      snapshot[collection] = structuredClone(records)
      commitUnlocked(snapshot, { action: 'write-collection', collection })
    })
  }

  function appendRecord(collection, record, options = {}) {
    validateRecord(record)
    return withLock(() => {
      const snapshot = readAllUnlocked()
      if (!(collection in RECORD_COLLECTIONS)) throw new TypeError(`未知记忆类别：${collection}`)
      if (Object.keys(RECORD_COLLECTIONS).some((name) => snapshot[name].some((item) => item.id === record.id))) throw new TypeError(`id 已存在：${record.id}`)
      const conflicts = new Set(Array.isArray(record.冲突) ? record.冲突.map(String) : [])
      for (const conflictId of conflicts) {
        let found = false
        for (const name of Object.keys(RECORD_COLLECTIONS)) {
          const target = snapshot[name].find((item) => String(item.id) === conflictId)
          if (!target) continue
          found = true
          const reverse = new Set(Array.isArray(target.冲突) ? target.冲突.map(String) : [])
          reverse.add(String(record.id))
          target.冲突 = [...reverse]
        }
        if (!found) throw new TypeError(`找不到冲突记忆：${conflictId}`)
      }
      snapshot[collection].push(structuredClone(record))
      const candidateValue = options.candidate ?? automaticCandidate(record, collection, '低层写入')
      const candidate = candidateFileOperationsUnlocked(candidateValue)
      commitUnlocked(snapshot, { action: 'append-record', collection, id: record.id }, { extraFiles: candidate.operations })
    })
  }

  // 2026-10-31：召回一次记一次。被召回次数不动，权重永远是 0，
  // 后面所有靠它算的东西（权重、干扰、淘汰）全站着。
  // 批量改、只 commit 一次——一轮召回 4 条要是写 4 次盘，旧版和镜像会跟着抖四次。
  function bumpRecall(ids = []) {
    const wanted = new Set(ids.map(String))
    if (wanted.size === 0) return 0
    return withLock(() => {
      const snapshot = readAllUnlocked()
      let touched = 0
      const touchedCollections = new Set()
      for (const collection of Object.keys(RECORD_COLLECTIONS)) {
        for (const record of snapshot[collection]) {
          if (!wanted.has(String(record.id))) continue
          record.被召回次数 = Math.max(0, Number(record.被召回次数) || 0) + 1
          record.last_recalled = new Date(clock()).toISOString()
          touched += 1
          touchedCollections.add(collection)
        }
      }
      if (touched > 0) commitUnlocked(snapshot, { action: 'bump-recall', collection: null, id: null }, { collections: [...touchedCollections], mirror: false, legacy: false, policy: false })
      return touched
    })
  }

  // 2026-10-31：更新机制要用。原地换掉一条，id 不变，版本号由调用方负责 +1。
  // 必须走和 appendRecord 同一条 commit（旧版快照、镜像、写入日志都会跟上）——
  // 绕过它直接改文件，就等于备份漏一份。
  function replaceRecord(collection, record, options = {}) {
    validateRecord(record)
    if (!(collection in RECORD_COLLECTIONS)) throw new TypeError(`未知记忆类别：${collection}`)
    return withLock(() => {
      const snapshot = readAllUnlocked()
      const index = snapshot[collection].findIndex((item) => item.id === record.id)
      if (index < 0) throw new TypeError(`找不到要更新的记录：${record.id}`)
      const previous = snapshot[collection][index]

      const previousConflicts = new Set(previous.冲突 ?? [])
      const nextConflicts = new Set(record.冲突 ?? [])
      const knownIds = new Set(Object.keys(RECORD_COLLECTIONS).flatMap((name) => snapshot[name].map((item) => item.id)))
      for (const conflictId of nextConflicts) {
        if (conflictId === record.id) throw new TypeError(`记忆不能与自身冲突：${record.id}`)
        if (!knownIds.has(conflictId)) throw new TypeError(`找不到冲突记忆：${conflictId}`)
      }
      for (const name of Object.keys(RECORD_COLLECTIONS)) {
        for (const target of snapshot[name]) {
          if (target.id === record.id) continue
          const reverse = new Set(target.冲突 ?? [])
          if (previousConflicts.has(target.id) && !nextConflicts.has(target.id)) reverse.delete(record.id)
          if (nextConflicts.has(target.id)) reverse.add(record.id)
          target.冲突 = reverse.size > 0 ? [...reverse] : null
        }
      }

    // 2026-10-31：结论层要留版本链——旧版本不能只剩在 json.gz 快照里，那不算能查。
    // 做法是把上一版推进这条记录自己的「历史」数组（不另开文件，
    // 这样 commit 写四个集合时自然会带上，不会出现两份结构不同步）。
    let next = record
    if (collection === '结论') {
      const history = Array.isArray(previous.历史) ? previous.历史.slice() : []
      history.push({
        版本: previous.版本,
        text: previous.text,
        置信度: previous.置信度,
        证据: previous.证据 ?? [],
        归档时间: new Date(clock()).toISOString(),
        归档原因: '被新版本替换',
      })
      next = { ...record, 历史: history }
    }

      snapshot[collection][index] = structuredClone(next)
      const candidateValue = options.candidate ?? automaticCandidate(next, collection, '低层更新')
      const candidate = candidateFileOperationsUnlocked(candidateValue)
      commitUnlocked(snapshot, { action: 'replace-record', collection, id: record.id }, { extraFiles: candidate.operations })
    })
  }

  function writePolicy(policy) {
    return withLock(() => {
      const snapshot = readAllUnlocked()
      snapshot.策略 = structuredClone(policy)
      commitUnlocked(snapshot, { action: 'write-policy' })
    })
  }

  function writeScene(text, date = clock()) {
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('情景文字不许为空')
    appendSceneBlock([{ who: '我', text }], date)
    return sceneFilePath(localDay(date))
  }

  function candidateFileOperationsUnlocked(candidate) {
    ensureDirectories()
    const normalizedCandidate = normalizeCandidate(candidate)
    const auditPath = join(logDir, `候选审计-${localDay(clock())}.jsonl`)
    const candidates = readCandidatesUnlocked()
    candidates.push(normalizedCandidate)
    const dropped = Math.max(0, candidates.length - CANDIDATE_LIMIT)
    if (dropped > 0) candidates.splice(0, dropped)
    const data = candidates.length > 0 ? `${candidates.map((item) => JSON.stringify(item)).join('\n')}\n` : ''
    const operations = [
      { kind: 'append', target: auditPath, data: `${JSON.stringify(normalizedCandidate)}\n` },
      { kind: 'replace', target: join(logDir, CANDIDATE_FILE), data },
    ]
    if (dropped > 0) operations.push({ kind: 'append', target: join(logDir, '写入日志.jsonl'), data: `${JSON.stringify({ time: new Date(clock()).toISOString(), action: 'drop-oldest-candidate-from-working-set', collection: null, id: candidate?.id ?? null, count: dropped })}\n` })
    return { operations, dropped, auditPath, candidate: normalizedCandidate }
  }

  function appendCandidate(candidate) {
    return withLock(() => {
      const plan = candidateFileOperationsUnlocked(candidate)
      runTransactionUnlocked(plan.operations)
      return { candidate: structuredClone(plan.candidate), dropped: plan.dropped, auditPath: plan.auditPath }
    })
  }

  const sceneIndexPath = join(logDir, '情景索引.json')
  const consolidationStatePath = join(logDir, '巩固状态.json')
  const consolidationLeasePath = join(logDir, '巩固待确认.json')
  const consolidationAckPath = join(logDir, '巩固最近确认.json')
  const consolidationResultsPath = join(logDir, '巩固结果.jsonl')

  function readConsolidationResultsUnlocked(compact = false) {
    if (!existsSync(consolidationResultsPath)) return []
    const parsed = readFileSync(consolidationResultsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    const bounded = parsed.slice(-CONSOLIDATION_RESULT_LIMIT)
    if (compact && bounded.length !== parsed.length) {
      const data = bounded.length ? `${bounded.map((item) => JSON.stringify(item)).join('\n')}\n` : ''
      runTransactionUnlocked([{ kind: 'replace', target: consolidationResultsPath, data }])
    }
    return bounded
  }

  function consolidationResultOperation(results, outcome) {
    const bounded = [...results, outcome].slice(-CONSOLIDATION_RESULT_LIMIT)
    return { kind: 'replace', target: consolidationResultsPath, data: `${bounded.map((item) => JSON.stringify(item)).join('\n')}\n` }
  }

  function readSceneEntryText(entry, cache = null) {
    const path = sceneFilePath(entry.date)
    if (!existsSync(path)) throw new Error(`情景文件不存在：${entry.date}`)
    if (entry.offsetKind === 'utf8') {
      const fileSize = statSync(path).size
      if (!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.start < 0 || entry.end <= entry.start || entry.end > fileSize) throw new Error('情景索引字节范围无效')
      const buffer = Buffer.alloc(entry.end - entry.start)
      const handle = openSync(path, 'r')
      try {
        const read = readSync(handle, buffer, 0, buffer.length, entry.start)
        if (read !== buffer.length) throw new Error('情景索引读取不完整')
      } finally { closeSync(handle) }
      return buffer.toString('utf8')
    }
    const original = cache?.has(path) ? cache.get(path) : readFileSync(path, 'utf8')
    if (cache && !cache.has(path)) cache.set(path, original)
    if (!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.start < 0 || entry.end <= entry.start || entry.end > original.length) throw new Error('情景索引范围无效')
    return original.slice(entry.start, entry.end)
  }

  function readSceneIndexUnlocked() {
    const entries = readJson(sceneIndexPath, [])
    if (!Array.isArray(entries)) throw new TypeError('情景索引必须为数组')
    const oldState = readJson(consolidationStatePath, { date: localDay(clock()), 轮数: 0, 上次巩固: null })
    const legacyPending = new Set(entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.date === oldState.date)
      .slice(-Math.max(0, Number(oldState.轮数) || 0))
      .map(({ index }) => index))
    let changed = false
    const textCache = new Map()
    const normalized = entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('情景索引项必须是对象')
      const next = { ...entry }
      if (typeof next.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(next.date)) throw new TypeError('情景索引日期无效')
      if (!Number.isSafeInteger(next.start) || !Number.isSafeInteger(next.end) || next.start < 0 || next.end <= next.start) throw new TypeError('情景索引范围无效')
      if (next.segmentId !== undefined && (typeof next.segmentId !== 'string' || !next.segmentId.trim())) throw new TypeError('情景索引段标识无效')
      if (!next.segmentId) { next.segmentId = stableSceneId(next); changed = true }
      if (!next.offsetKind) { next.offsetKind = 'utf16'; changed = true }
      if (next.offsetKind !== 'utf8' && next.offsetKind !== 'utf16') throw new TypeError('情景索引偏移类型无效')
      if (typeof next.confirmed !== 'boolean') { next.confirmed = !legacyPending.has(index); changed = true }
      if (!Number.isSafeInteger(next.confirmedChars) || next.confirmedChars < 0) { next.confirmedChars = next.confirmed ? Number.MAX_SAFE_INTEGER : 0; changed = true }
      if (!next.hhmm) {
        try { next.hhmm = (/^## (?:\[scene:[^\]]+\] )?(\d{1,2}:\d{2})/.exec(readSceneEntryText(next, textCache)) || [])[1] ?? null } catch { next.hhmm = null }
        changed = true
      }
      return next
    })
    const segmentIds = new Set(normalized.map((entry) => entry.segmentId))
    if (segmentIds.size !== normalized.length) throw new TypeError('情景索引段标识重复')
    if (changed) runTransactionUnlocked([{ kind: 'replace', target: sceneIndexPath, data: `${JSON.stringify(normalized)}\n` }])
    return normalized
  }

  function deriveConsolidationState(entries, date = clock(), last = undefined) {
    const prior = readJson(consolidationStatePath, { date: localDay(date), 轮数: 0, 上次巩固: null })
    return {
      date: localDay(date),
      轮数: entries.filter((entry) => !entry.confirmed).length,
      上次巩固: last === undefined ? (prior.上次巩固 ?? null) : last,
    }
  }

  function writeConsolidationStateUnlocked(entries, date = clock(), last = undefined) {
    const state = deriveConsolidationState(entries, date, last)
    const data = `${JSON.stringify(state, null, 2)}\n`
    const current = existsSync(consolidationStatePath) ? readFileSync(consolidationStatePath, 'utf8') : ''
    if (current !== data) runTransactionUnlocked([{ kind: 'replace', target: consolidationStatePath, data }])
    return state
  }

  function readConsolidationState(date = clock()) {
    return withLock(() => {
      const entries = readSceneIndexUnlocked()
      return deriveConsolidationState(entries, date)
    })
  }

  // 2026-10-31：情景文件靠「行首 ## 」分段、靠「三个反引号」判代码块。
  // 我的回复里可能带这两样，会把后面的分段裹进去，所以落盘前换掉（只有我这半边）：
  //   三个反引号 → 三个单引号；行首的 # → 全角＃
  // **用户原话一个字都不改**——那是证据，不能动。
  // 注意：偏移索引用的是转义之后的 text.length，所以 consolidateScenes 切片仍然对齐。
  function sanitizeSceneText(value) {
    return String(value ?? '')
      .replace(/```/g, "'''")
      .replace(/^([ \t]*)(#+)/gm, (match, space, hashes) => space + '＃'.repeat(hashes.length))
  }

  // 2026-11-02：全量落盘版。一轮里的多条消息逐条进一个段（## HH:mm + 你说/我说 多行），
  // 不再只抓最后一条。索引、未巩固轮数照旧走一条线，保证 consolidate 对齐。
  function appendSceneBlock(entries, date = clock(), trace = () => {}) {
    return withLock(() => {
      const day = localDay(date)
      const path = sceneFilePath(day)
      const time = new Date(date)
      const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
      const segmentId = randomUUID()
      const lines = entries.map(({ who, text }) => {
        const value = who === '你' ? String(text ?? '') : sanitizeSceneText(String(text ?? ''))
        return `${who === '你' ? '你说' : '我说'}：${value}`
      })
      const text = `## [scene:${segmentId}] ${hhmm}\n${lines.length ? lines.join('\n') : '（本轮无对话文本）'}\n`
      ensureDirectories()
      const size = existsSync(path) ? statSync(path).size : 0
      let separator = ''
      if (size > 0) {
        const handle = openSync(path, 'r')
        try {
          const last = Buffer.alloc(1)
          readSync(handle, last, 0, 1, size - 1)
          if (last[0] !== 10) separator = '\n'
        } finally { closeSync(handle) }
      }
      const start = size + Buffer.byteLength(separator)
      trace('情景追加开始')
      const oldEntries = readSceneIndexUnlocked()
      const textBuffer = Buffer.from(text, 'utf8')
      oldEntries.push({ segmentId, date: day, hhmm, start, end: start + textBuffer.length, offsetKind: 'utf8', sha256: sha256(textBuffer), confirmed: false, confirmedChars: 0 })
      const next = deriveConsolidationState(oldEntries, date)
      runTransactionUnlocked([
        { kind: 'append', target: path, data: Buffer.from(separator + text, 'utf8') },
        { kind: 'replace', target: sceneIndexPath, data: `${JSON.stringify(oldEntries)}\n` },
        { kind: 'replace', target: consolidationStatePath, data: `${JSON.stringify(next, null, 2)}\n` },
        { kind: 'append', target: join(logDir, '写入日志.jsonl'), data: `${JSON.stringify({ time: new Date(clock()).toISOString(), action: 'write-scene', collection: null, id: segmentId })}\n` },
      ])
      trace('情景追加与索引事务提交 OK')
      trace(`未巩固轮数保存 OK: ${next.轮数}`)
      return { ...next, segmentId }
    })
  }

  function appendTurn(userText, assistantText, date = clock(), trace = () => {}) {
    const entries = []
    if (userText) entries.push({ who: '你', text: userText })
    if (assistantText) entries.push({ who: '我', text: assistantText })
    return appendSceneBlock(entries, date, trace)
  }

  // 2026-11-02：按「日期 + 时分」回原文段（召回带原文用）。
  // 段以行首 ## HH:mm 分界；找不到返回 null。不解析 Markdown，整段原样给。
  function sceneSegmentById(segmentId) {
    return withLock(() => {
      const entry = readSceneIndexUnlocked().find((item) => String(item.segmentId) === String(segmentId))
      return entry ? readSceneEntryText(entry).replace(/\s+$/g, '') : null
    })
  }

  function sceneSegment(day, hhmm) {
    return withLock(() => {
      const matches = readSceneIndexUnlocked().filter((entry) => entry.date === day && entry.hhmm === hhmm)
      if (matches.length !== 1) return null
      return readSceneEntryText(matches[0]).replace(/\s+$/g, '')
    })
  }

  // 2026-11-02：trace 字面溯源。把查询和段正文都去掉空白后做包含匹配——
  // 「他答应过我吗」「这句话谁说的」要的是字面证据，不是意思相近。
  // 旧数据里「你说」可能存着系统注入块，匹配和返回前都剥掉，别让注入块冒充命中。
  // 扫最近 days 天的情景文件，命中的段按时间倒序给，最多 maxHits 条，每条截 maxChars 字。
  function traceScene(query, { days = 30, maxHits = 5, maxChars = 400 } = {}) {
    const needle = String(query ?? '').replace(/\s+/g, '')
    if (needle.length < 2) return []
    return withLock(() => {
      const today = localDay(clock())
      const windowStart = new Date(new Date(today + 'T00:00:00').getTime() - (days - 1) * 86400000)
      const entries = readSceneIndexUnlocked()
        .filter((entry) => entry.date >= localDay(windowStart) && entry.date <= today)
        .reverse()
      const hits = []
      const textCache = new Map()
      for (const entry of entries) {
        let segment
        try { segment = readSceneEntryText(entry, textCache) } catch { continue }
        const cleaned = segment.replace(/你说：Current runtime context[\s\S]*?(?=\n我说：|$)/g, '你说：（系统注入，已省略）')
        if (!cleaned.replace(/\s+/g, '').includes(needle)) continue
        hits.push({ segmentId: entry.segmentId, date: entry.date, hhmm: entry.hhmm, text: Array.from(cleaned).slice(0, maxChars).join('').replace(/\s+$/g, '') })
        if (hits.length >= maxHits) break
      }
      return hits
    })
  }

  function consolidateScenes(rounds, date = clock(), trace = () => {}, options = {}) {
    if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 1)) throw new TypeError('rounds 必须为正整数')
    return withLock(() => {
      const ackToken = String(options.ackToken ?? '').trim()
      const abandonToken = String(options.abandonToken ?? '').trim()
      if (ackToken && abandonToken) throw new Error('ackToken 和 abandonToken 不能同时提供')
      if ((ackToken || abandonToken) && rounds !== undefined) throw new Error('确认或放弃租约时不能同时指定 rounds')
      const requestedToken = ackToken || abandonToken
      const results = requestedToken ? readConsolidationResultsUnlocked(true) : []
      const previousResult = requestedToken
        ? (results.findLast?.((item) => item?.token === requestedToken) ?? [...results].reverse().find((item) => item?.token === requestedToken))
        : undefined
      if (abandonToken) {
        if (previousResult?.status === 'abandoned') return { ok: true, abandoned: true, idempotent: true, remaining: previousResult.remaining }
        if (previousResult?.status === 'acked') throw new Error('该租约已经确认，不能放弃')
        if (!existsSync(consolidationLeasePath)) {
          throw new Error('找不到这次巩固的待确认租约')
        }
        const lease = readJson(consolidationLeasePath, null)
        if (!lease || lease.token !== abandonToken) throw new Error('巩固放弃令牌不匹配')
        const remaining = readSceneIndexUnlocked().filter((entry) => !entry.confirmed).length
        const outcome = { token: abandonToken, status: 'abandoned', remaining, at: new Date(date).toISOString() }
        runTransactionUnlocked([
          consolidationResultOperation(results, outcome),
          { kind: 'append', target: join(logDir, '写入日志.jsonl'), data: `${JSON.stringify({ time: new Date(clock()).toISOString(), action: 'consolidation-abandon', collection: null, id: abandonToken })}\n` },
          { kind: 'delete', target: consolidationLeasePath },
        ])
        return { ok: true, abandoned: true, idempotent: false, remaining }
      }
      if (ackToken) {
        if (previousResult?.status === 'acked') return { ok: true, acknowledged: true, idempotent: true, remaining: previousResult.remaining }
        if (previousResult?.status === 'abandoned') throw new Error('该租约已经放弃，不能确认')
        if (!existsSync(consolidationLeasePath)) {
          throw new Error('找不到这次巩固的待确认租约')
        }
        const lease = readJson(consolidationLeasePath, null)
        if (!lease || lease.token !== ackToken || !Array.isArray(lease.parts)) throw new Error('巩固确认令牌不匹配')
        const entries = readSceneIndexUnlocked()
        for (const part of lease.parts) {
          const entry = entries.find((item) => item.segmentId === part.segmentId)
          if (!entry) throw new Error(`巩固索引已变化：${part.segmentId}`)
          const current = Array.from(readSceneEntryText(entry)).slice(part.from, part.to).join('')
          if (part.sha256 && sha256(Buffer.from(current, 'utf8')) !== part.sha256) throw new Error('巩固原文哈希不匹配')
          entry.confirmedChars = Math.max(Number(entry.confirmedChars) || 0, part.to)
          if (entry.confirmedChars >= part.total) entry.confirmed = true
        }
        const time = new Date(date)
        const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
        const state = deriveConsolidationState(entries, date, `${localDay(date)} ${hhmm}`)
        const outcome = { token: ackToken, status: 'acked', remaining: state.轮数, at: new Date(date).toISOString() }
        runTransactionUnlocked([
          { kind: 'replace', target: sceneIndexPath, data: `${JSON.stringify(entries)}\n` },
          { kind: 'replace', target: consolidationStatePath, data: `${JSON.stringify(state, null, 2)}\n` },
          { kind: 'replace', target: consolidationAckPath, data: `${JSON.stringify({ token: ackToken, at: new Date(date).toISOString() }, null, 2)}\n` },
          consolidationResultOperation(results, outcome),
          { kind: 'append', target: join(logDir, '写入日志.jsonl'), data: `${JSON.stringify({ time: new Date(clock()).toISOString(), action: 'consolidation-ack', collection: null, id: ackToken })}\n` },
          { kind: 'delete', target: consolidationLeasePath },
        ])
        trace(`巩固确认 OK，剩余 ${state.轮数} 轮`)
        return { ok: true, acknowledged: true, idempotent: false, remaining: state.轮数 }
      }

      if (existsSync(consolidationLeasePath)) {
        const lease = readJson(consolidationLeasePath, null)
        if (lease?.token && Array.isArray(lease.parts)) return { ok: true, date: lease.date, rounds: lease.rounds, text: lease.text, ackToken: lease.token, remaining: lease.remaining, truncated: lease.truncated, resumed: true }
      }

      const entries = readSceneIndexUnlocked()
      const pending = entries.filter((entry) => !entry.confirmed)
      const targets = pending.slice(0, Math.min(rounds ?? pending.length, pending.length))
      const parts = []
      const chunks = []
      let budget = 8000
      for (const entry of targets) {
        if (budget <= 0) break
        const full = Array.from(readSceneEntryText(entry))
        const from = Math.min(Number(entry.confirmedChars) || 0, full.length)
        const take = Math.min(budget, full.length - from)
        if (take <= 0) continue
        const chunk = full.slice(from, from + take).join('')
        chunks.push(chunk)
        parts.push({ segmentId: entry.segmentId, from, to: from + take, total: full.length, sha256: sha256(Buffer.from(chunk, 'utf8')) })
        budget -= take
        if (from + take < full.length) break
      }
      const text = chunks.join('')
      const token = parts.length ? randomUUID() : ''
      const covered = new Set(parts.map((part) => part.segmentId)).size
      const remaining = pending.length
      const truncated = parts.some((part) => part.to < part.total) || covered < targets.length
      if (token) runTransactionUnlocked([
        { kind: 'replace', target: consolidationLeasePath, data: `${JSON.stringify({ token, date: localDay(date), rounds: covered, text, parts, remaining, truncated, createdAt: new Date(date).toISOString() }, null, 2)}\n` },
        { kind: 'append', target: join(logDir, '写入日志.jsonl'), data: `${JSON.stringify({ time: new Date(clock()).toISOString(), action: 'consolidation-lease', collection: null, id: token })}\n` },
      ])
      trace(`情景原文读取 OK: ${covered} 轮，等待确认`)
      return { ok: true, date: localDay(date), rounds: covered, text, ackToken: token, remaining, truncated, resumed: false }
    })
  }

  function readCandidatesUnlocked() {
    const path = join(logDir, CANDIDATE_FILE)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  function readCandidates() {
    return withLock(() => readCandidatesUnlocked())
  }

  function writeCandidatesUnlocked(candidates) {
    if (!Array.isArray(candidates)) throw new TypeError('候选必须是数组')
    ensureDirectories()
    const kept = candidates.slice(-CANDIDATE_LIMIT).map(normalizeCandidate)
    const data = kept.length > 0 ? `${kept.map((item) => JSON.stringify(item)).join('\n')}\n` : ''
    runTransactionUnlocked([{ kind: 'replace', target: join(logDir, CANDIDATE_FILE), data }])
    return kept.length
  }

  function writeCandidates(candidates) {
    return withLock(() => writeCandidatesUnlocked(candidates))
  }

  ensureDirectories()
  withLock(() => recoverTransactionUnlocked())
  return {
    rootDir,
    readAll,
    readCollection,
    appendRecord,
    replaceRecord,
    bumpRecall,
    writePolicy,
    writeScene,
    appendTurn,
    appendSceneBlock,
    sceneSegment,
    sceneSegmentById,
    traceScene,
    readConsolidationState,
    consolidateScenes,
    appendCandidate,
    readCandidates,
    writeCandidates,
  }
}
