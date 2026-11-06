import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const RECORD_COLLECTIONS = Object.freeze({
  语义: '语义.json',
  结论: '结论.json',
  画像: '画像.json',
  临时: '临时.json',
})

const POLICY_COLLECTION = '策略.json'
const CANDIDATE_FILE = '候选.jsonl'
const CANDIDATE_LIMIT = 50

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, data, { flag: 'wx' })
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
  if (typeof record.门牌 !== 'string' || record.门牌.trim() === '' || record.门牌 === '位置未知') throw new TypeError('门牌不许为空或写位置未知')
  if (!Array.isArray(record.证据)) throw new TypeError('证据必须是数组')

  const kinds = record.kind
  if (kinds.includes('事件') && !record.event_time) throw new TypeError('事件必须有 event_time')
  if (kinds.includes('状态') && (!record.last_confirmed || !record.ttl)) throw new TypeError('状态必须有 last_confirmed 和 ttl')
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

// 完整 txt 备份：镜像 md 是给人看的摘要（字段不全），
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

  function ensureDirectories() {
    for (const path of [currentDir, sceneDir, legacyDir, mirrorDir, logDir]) {
      mkdirSync(path, { recursive: true })
    }
  }

  function readAll() {
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

  function appendLog(entry) {
    ensureDirectories()
    const path = join(logDir, '写入日志.jsonl')
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
    atomicWrite(path, `${previous}${JSON.stringify(entry)}\n`)
  }

  function commit(snapshot, detail) {
    ensureDirectories()
    const writtenAt = clock()
    const prior = readAll()
    ensureLegacy(prior, writtenAt)

    for (const [collection, file] of Object.entries(RECORD_COLLECTIONS)) {
      if (!Array.isArray(snapshot[collection])) throw new TypeError(`${collection} 必须是数组`)
      for (const record of snapshot[collection]) validateRecord(record)
    }
    if (!snapshot.策略 || typeof snapshot.策略 !== 'object' || Array.isArray(snapshot.策略)) {
      throw new TypeError('策略必须是对象')
    }

    const staged = []
    for (const [collection, file] of Object.entries(RECORD_COLLECTIONS)) {
      staged.push([join(currentDir, file), `${JSON.stringify(snapshot[collection], null, 2)}\n`])
    }
    staged.push([join(currentDir, POLICY_COLLECTION), `${JSON.stringify(snapshot.策略, null, 2)}\n`])
    staged.push([join(mirrorDir, `${localDay(writtenAt)}.md`), renderMirror(snapshot, writtenAt)])
    staged.push([join(mirrorDir, `${localDay(writtenAt)}.txt`), renderFullText(snapshot, writtenAt)])

    const temporaryFiles = staged.map(([path, data]) => {
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temporaryPath, data, { flag: 'wx' })
      return [temporaryPath, path]
    })
    for (const [temporaryPath, path] of temporaryFiles) renameSync(temporaryPath, path)

    appendLog({
      time: new Date(writtenAt).toISOString(),
      action: detail.action,
      collection: detail.collection ?? null,
      id: detail.id ?? null,
    })
  }

  function writeCollection(collection, records) {
    if (!(collection in RECORD_COLLECTIONS)) throw new TypeError(`未知记忆类别：${collection}`)
    if (!Array.isArray(records)) throw new TypeError('写入内容必须是数组')
    const snapshot = readAll()
    snapshot[collection] = structuredClone(records)
    commit(snapshot, { action: 'write-collection', collection })
  }

  function appendRecord(collection, record) {
    validateRecord(record)
    const snapshot = readAll()
    if (!(collection in RECORD_COLLECTIONS)) throw new TypeError(`未知记忆类别：${collection}`)
    if (snapshot[collection].some((item) => item.id === record.id)) throw new TypeError(`id 已存在：${record.id}`)
    snapshot[collection].push(structuredClone(record))
    commit(snapshot, { action: 'append-record', collection, id: record.id })
  }

  // 2026-10-31：召回一次记一次。被召回次数不动，权重永远是 0，
  // 后面所有靠它算的东西（权重、干扰、淘汰）全站着。
  // 批量改、只 commit 一次——一轮召回 4 条要是写 4 次盘，旧版和镜像会跟着抖四次。
  function bumpRecall(ids = []) {
    const wanted = new Set(ids.map(String))
    if (wanted.size === 0) return 0
    const snapshot = readAll()
    let touched = 0
    for (const collection of Object.keys(RECORD_COLLECTIONS)) {
      for (const record of snapshot[collection]) {
        if (!wanted.has(String(record.id))) continue
        record.被召回次数 = Math.max(0, Number(record.被召回次数) || 0) + 1
        record.last_recalled = new Date(clock()).toISOString()
        touched += 1
      }
    }
    if (touched > 0) commit(snapshot, { action: 'bump-recall', collection: null, id: null })
    return touched
  }

  // 2026-10-31：更新机制要用。原地换掉一条，id 不变，版本号由调用方负责 +1。
  // 必须走和 appendRecord 同一条 commit（旧版快照、镜像、写入日志都会跟上）——
  // 绕过它直接改文件，就等于备份漏一份。
  function replaceRecord(collection, record) {
    validateRecord(record)
    if (!(collection in RECORD_COLLECTIONS)) throw new TypeError(`未知记忆类别：${collection}`)
    const snapshot = readAll()
    const index = snapshot[collection].findIndex((item) => item.id === record.id)
    if (index < 0) throw new TypeError(`找不到要更新的记录：${record.id}`)
    const previous = snapshot[collection][index]

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
    commit(snapshot, { action: 'replace-record', collection, id: record.id })
  }

  function writePolicy(policy) {
    const snapshot = readAll()
    snapshot.策略 = structuredClone(policy)
    commit(snapshot, { action: 'write-policy' })
  }

  function writeScene(text, date = clock()) {
    if (typeof text !== 'string' || text.length === 0) throw new TypeError('情景文字不许为空')
    ensureDirectories()
    const path = join(sceneDir, `${localDay(date)}.md`)
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const separator = previous && !previous.endsWith('\n') ? '\n' : ''
    atomicWrite(path, `${previous}${separator}${text}${text.endsWith('\n') ? '' : '\n'}`)
    appendLog({ time: new Date(clock()).toISOString(), action: 'write-scene', collection: null, id: null })
    return path
  }

  function appendCandidate(candidate) {
    ensureDirectories()
    const candidates = readCandidates()
    candidates.push(structuredClone(candidate))
    const dropped = Math.max(0, candidates.length - CANDIDATE_LIMIT)
    if (dropped > 0) candidates.splice(0, dropped)
    writeCandidates(candidates)
    if (dropped > 0) {
      appendLog({
        time: new Date(clock()).toISOString(),
        action: 'drop-oldest-candidate',
        collection: null,
        id: candidate?.id ?? null,
        count: dropped,
      })
    }
    return { candidate: structuredClone(candidate), dropped }
  }

  // 2026-10-31：情景原文按偏移索引，计数独立存盘；不涉及有效性、权重、过期三个函数。
  function readConsolidationState(date = clock()) {
    const day = localDay(date)
    const state = readJson(join(logDir, '巩固状态.json'), { date: day, 轮数: 0, 上次巩固: null, cursor: 0, offset: 0 })
    if (typeof state.date !== 'string' || !Number.isSafeInteger(state.轮数) || state.轮数 < 0) {
      throw new TypeError('巩固状态格式无效')
    }
    const entries = readJson(join(logDir, '情景索引.json'), [])
    if (!Array.isArray(entries)) throw new TypeError('情景索引必须为数组')
    // 兼容旧状态；旧版尚未跨日的积压也保留。新版游标不按日期重置。
    const legacyEnd = entries.filter((entry) => entry.date <= state.date).length
    const cursor = state.cursor ?? Math.max(0, legacyEnd - state.轮数)
    const offset = state.offset ?? 0
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entries.length || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError('巩固游标无效')
    return { date: day, 轮数: entries.length - cursor, 上次巩固: state.上次巩固 ?? null, cursor, offset }
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
    const day = localDay(date)
    const state = readConsolidationState(date)
    const path = join(sceneDir, `${day}.md`)
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const time = new Date(date)
    const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
    const lines = entries.map(({ who, text }) => {
      const value = who === '你' ? String(text ?? '') : sanitizeSceneText(String(text ?? ''))
      return `${who === '你' ? '你说' : '我说'}：${value}`
    })
    const text = `## ${hhmm}\n${lines.length ? lines.join('\n') : '（本轮无对话文本）'}\n`
    const separator = previous && !previous.endsWith('\n') ? '\n' : ''
    const indexPath = join(logDir, '情景索引.json')
    const entriesOld = readJson(indexPath, [])
    if (!Array.isArray(entriesOld)) throw new TypeError('情景索引必须为数组')
    trace('情景追加开始')
    writeScene(text, date)
    trace('情景追加 OK')
    entriesOld.push({ date: day, start: previous.length + separator.length, end: previous.length + separator.length + text.length })
    atomicWrite(indexPath, `${JSON.stringify(entriesOld)}\n`)
    trace('情景索引保存 OK')
    const next = { ...state, 轮数: state.轮数 + 1 }
    atomicWrite(join(logDir, '巩固状态.json'), `${JSON.stringify(next, null, 2)}\n`)
    trace(`未巩固轮数保存 OK: ${next.轮数}`)
    return next
  }

  function appendTurn(userText, assistantText, date = clock(), trace = () => {}) {
    const entries = []
    if (userText) entries.push({ who: '你', text: userText })
    if (assistantText) entries.push({ who: '我', text: assistantText })
    return appendSceneBlock(entries, date, trace)
  }

  // 2026-11-02：按「日期 + 时分」回原文段（召回带原文用）。
  // 段以行首 ## HH:mm 分界；找不到返回 null。不解析 Markdown，整段原样给。
  function sceneSegment(day, hhmm) {
    const path = join(sceneDir, `${day}.md`)
    if (!existsSync(path)) return null
    const original = readFileSync(path, 'utf8')
    const marker = `## ${hhmm}`
    const entries = readJson(join(logDir, '情景索引.json'), []).filter((entry) => entry.date === day)
    const segments = entries.length ? entries.map(({ start, end }) => original.slice(start, end)) : original.split(/(?=^## )/gm)
    const hits = segments.filter((seg) => seg.startsWith(marker + '\n') || seg.startsWith(marker + '\r\n'))
    // 老来源只有分钟时无法区分同分钟的多轮，宁可不带原文，也不冒充证据。
    if (hits.length !== 1) return null
    return hits[0].replace(/\s+$/g, '')
  }

  // 2026-11-02：trace 字面溯源。把查询和段正文都去掉空白后做包含匹配——
  // 「他答应过我吗」「这句话谁说的」要的是字面证据，不是意思相近。
  // 旧数据里「你说」可能存着系统注入块，匹配和返回前都剥掉，别让注入块冒充命中。
  // 扫最近 days 天的情景文件，命中的段按时间倒序给，最多 maxHits 条，每条截 maxChars 字。
  function traceScene(query, { days = 30, maxHits = 5, maxChars = 400 } = {}) {
    const needle = String(query ?? '').replace(/\s+/g, '')
    if (needle.length < 2) return []
    ensureDirectories()
    const files = []
    try {
      for (const name of readdirSync(sceneDir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)
        if (m) files.push({ day: m[1], path: join(sceneDir, name) })
      }
    } catch { return [] }
    const today = localDay(clock())
    const windowStart = new Date(new Date(today + 'T00:00:00').getTime() - (days - 1) * 86400000)
    const hits = []
    const recent = files
      .filter((f) => f.day >= localDay(windowStart) && f.day <= today)
      .sort((a, b) => (a.day < b.day ? 1 : -1))
    for (const file of recent) {
      let original
      try { original = readFileSync(file.path, 'utf8') } catch { continue }
      const indexed = readJson(join(logDir, '情景索引.json'), []).filter((entry) => entry.date === file.day)
      const segments = indexed.length ? indexed.map(({ start, end }) => original.slice(start, end)) : original.split(/(?=^## )/gm)
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i]
        const m = /^## (\d{1,2}:\d{2})/.exec(seg)
        if (!m) continue
        const cleaned = seg.replace(/你说：Current runtime context[\s\S]*?(?=\n我说：|$)/g, '你说：（系统注入，已省略）')
        if (!cleaned.replace(/\s+/g, '').includes(needle)) continue
        hits.push({
          date: file.day,
          hhmm: m[1],
          text: Array.from(cleaned).slice(0, maxChars).join('').replace(/\s+$/g, ''),
        })
        if (hits.length >= maxHits) return hits
      }
    }
    return hits
  }

  function consolidateScenes(rounds, date = clock(), trace = () => {}) {
    if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 1)) {
      throw new TypeError('rounds 必须为正整数')
    }
    const state = readConsolidationState(date)
    const count = Math.min(rounds ?? state.轮数, state.轮数)
    let text = ''
    let cursor = state.cursor
    let offset = state.offset
    let completed = 0
    let budget = 8000
    if (count > 0) {
      const entries = readJson(join(logDir, '情景索引.json'), [])
      if (!Array.isArray(entries)) throw new TypeError('情景索引必须为数组')
      const selected = entries.slice(cursor, cursor + count)
      if (selected.length !== count) throw new Error('情景索引与未巩固轮数不符')
      for (const { date: entryDay, start, end } of selected) {
        const original = readFileSync(join(sceneDir, `${entryDay}.md`), 'utf8')
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > original.length) {
          throw new Error('情景索引范围无效')
        }
        const chars = Array.from(original.slice(start, end))
        if (offset >= chars.length) throw new Error('巩固段内游标无效')
        const part = chars.slice(offset, offset + budget)
        text += part.join('')
        budget -= part.length
        offset += part.length
        if (offset === chars.length) { cursor++; completed++; offset = 0 }
        if (budget === 0) break
      }
    }
    trace(`情景原文读取 OK: ${count} 轮`)
    const time = new Date(date)
    const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
    atomicWrite(join(logDir, '巩固状态.json'), `${JSON.stringify({ date: state.date, 轮数: state.轮数 - completed, 上次巩固: `${state.date} ${hhmm}`, cursor, offset }, null, 2)}\n`)
    trace('巩固游标保存 OK')
    return { ok: true, date: state.date, rounds: completed, text }
  }

  function readCandidates() {
    const path = join(logDir, CANDIDATE_FILE)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  function writeCandidates(candidates) {
    if (!Array.isArray(candidates)) throw new TypeError('候选必须是数组')
    ensureDirectories()
    const kept = candidates.slice(-CANDIDATE_LIMIT)
    const data = kept.length > 0 ? `${kept.map((item) => JSON.stringify(item)).join('\n')}\n` : ''
    atomicWrite(join(logDir, CANDIDATE_FILE), data)
    return kept.length
  }

  ensureDirectories()
  return {
    rootDir,
    readAll,
    readCollection,
    writeCollection,
    appendRecord,
    replaceRecord,
    bumpRecall,
    writePolicy,
    writeScene,
    appendTurn,
    appendSceneBlock,
    sceneSegment,
    traceScene,
    readConsolidationState,
    consolidateScenes,
    appendCandidate,
    readCandidates,
    writeCandidates,
  }
}
