import { isValid } from './valid.js'
import { getWeight } from './weight.js'
import { isExpired } from './expiry.js'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY = 24 * 60 * 60 * 1000
const COLLECTIONS = ['语义', '结论', '画像', '临时']
const MIN_LEXICAL_DIRECT = 0.2
const MIN_SEMANTIC_DIRECT = 0.55

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function termsOf(value) {
  const source = String(value ?? '').toLowerCase()
  const terms = new Set(source.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) || [])
  for (const part of [...terms]) {
    if (!/[\p{Script=Han}]/u.test(part)) continue
    for (let size = 2; size <= Math.min(4, part.length); size++) {
      for (let index = 0; index + size <= part.length; index++) terms.add(part.slice(index, index + size))
    }
  }
  return [...terms]
}

function entitiesOf(record) {
  const source = record?.实体 ?? record?.entities ?? record?.实体列表 ?? []
  const values = Array.isArray(source) ? source : String(source ?? '').split(/[,，、|]/)
  return [...new Set(values
    .map((item) => String(item).trim())
    .filter((item) => item && normalizeText(item).length > 0))].slice(0, 5)
}

function recordTime(record) {
  for (const value of [record?.last_confirmed, record?.event_time, record?.created_at, record?.createdAt, record?.来源]) {
    const time = new Date(value).getTime()
    if (Number.isFinite(time)) return time
  }
  return null
}

function conflictIds(record) {
  const source = record?.冲突 ?? record?.conflictsWith ?? []
  const values = Array.isArray(source) ? source : [source]
  const result = []
  for (const item of values) {
    if (typeof item === 'string' && item) result.push(item)
    else if (item && typeof item === 'object') {
      const id = item.id ?? item.记录id ?? item.with
      if (id) result.push(String(id))
    }
  }
  return result
}

function areConflicting(left, right) {
  if (!left || !right || left.id === right.id) return false
  if (conflictIds(left).includes(String(right.id)) || conflictIds(right).includes(String(left.id))) return true
  return Boolean(left.冲突组 && right.冲突组 && left.冲突组 === right.冲突组)
}

function recordsFrom(options) {
  if (Array.isArray(options.records)) return options.records
  const snapshot = options.snapshot ?? options.store?.readAll?.()
  if (!snapshot) return []
  return COLLECTIONS.flatMap((collection) => (
    Array.isArray(snapshot[collection])
      ? snapshot[collection].map((record) => ({ ...record, 记忆类别: collection }))
      : []
  ))
}

export function vectorRecall() {
  return []
}

// ===== 语义召回（embedding，bge-small-zh 模型，开关控制）=====
let extractor = null
let modelLoading = null

async function getExtractor() {
  if (extractor) return extractor
  if (modelLoading) return modelLoading
  modelLoading = (async () => {
    const { pipeline, env } = await import('@xenova/transformers')
    const modelsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'models')
    env.localModelPath = modelsDir.replace(/\\/g, '/') + '/'
    env.allowRemoteModels = false
    extractor = await pipeline('feature-extraction', 'bge-small-zh', { quantized: true })
    return extractor
  })()
  try {
    return await modelLoading
  } catch (error) {
    modelLoading = null
    throw error
  }
}

function dotProduct(left, right) {
  let result = 0
  for (let i = 0; i < left.length; i++) result += left[i] * right[i]
  return result
}

function normOf(vector) {
  let result = 0
  for (const value of vector) result += value * value
  return Math.sqrt(result)
}

async function embedText(text) {
  const instance = await getExtractor()
  const output = await instance(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

// 记忆向量缓存：text 没变就复用，变了才重算，避免每次召回把整库重算一遍
const vectorCache = new Map()

// 语义召回：把查询和每条记忆都转成向量，按余弦相似度排序返回
export async function semanticRecall(query, records, { minSimilarity = 0.55 } = {}) {
  const queryVector = await embedText(query)
  const scored = []
  for (const record of records) {
    const id = String(record.id)
    const text = `${record.text ?? ''} ${record.原话 ?? ''}`
    const cached = vectorCache.get(id)
    let recordVector
    if (cached && cached.text === text) {
      recordVector = cached.vector
    } else {
      recordVector = await embedText(text)
      vectorCache.set(id, { text, vector: recordVector })
      if (vectorCache.size > 1000) vectorCache.delete(vectorCache.keys().next().value)
    }
    const similarity = dotProduct(queryVector, recordVector) / (normOf(queryVector) * normOf(recordVector) || 1)
    scored.push({ id, similarity })
  }
  return scored.filter((item) => item.similarity >= minSimilarity).sort((left, right) => right.similarity - left.similarity)
}

// ===== 当天情景原文兜底 =====
// 条目库没有直接命中时，回当天情景 md 按词做字面搜索。
// 目录取法复用 store.js 的约定：options.情景目录（测试注入）优先，
// 其次 options.store.rootDir 下的「情景」，最后 DSH_HOME / 家目录下的默认库。
function sceneRootOf(options) {
  if (options?.情景目录) return String(options.情景目录)
  if (options?.store?.rootDir) return join(options.store.rootDir, '情景')
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-memory', '情景')
}

function localDay(value) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 读一次目录，把日期命名的 .md 文件名从近往远排好（YYYY-MM-DD 字典序=时间序）。
// 只列文件名，不读内容；半年层最多一百多个文件，逐层处理时才按需读。
function sceneFileNames(root) {
  try {
    return readdirSync(root)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .reverse()
  } catch { return [] }
}

// 在按日期从近往远排好的文件名里，查日期落在 [start, end]（YYYY-MM-DD，含两端）的文件，
// 窗口内按「与 center 的日期距离」升序排（说「昨天」就优先昨天，再向两侧展开），
// 逐个读、逐行跑 sceneRecordsFrom，命中即返回。每次只持有一个文件的内容。
function searchSceneFiles(names, start, end, center, root, terms) {
  const centerTime = new Date(`${center}T00:00:00`).getTime()
  const windowNames = names.filter((name) => {
    const day = name.slice(0, 10)
    return day >= start && day <= end
  })
  if (Number.isFinite(centerTime)) {
    windowNames.sort((left, right) => {
      const leftGap = Math.abs(new Date(`${left.slice(0, 10)}T00:00:00`).getTime() - centerTime)
      const rightGap = Math.abs(new Date(`${right.slice(0, 10)}T00:00:00`).getTime() - centerTime)
      return leftGap - rightGap
    })
  }
  for (const name of windowNames) {
    let lines
    try { lines = readFileSync(join(root, name), 'utf8').split(/\r?\n/) } catch { continue }
    const records = sceneRecordsFrom(lines, name, terms)
    if (records.length > 0) return records
  }
  return []
}

// ===== 时间线索解析 =====
// 纯函数：从 query 里提取时间线索，返回要优先查的日期窗口 { start, end }（YYYY-MM-DD，含两端）；
// 解析不出来返回 null，调用方直接走默认阶梯。支持：
//   昨天/前天/大前天（以该日为中心前后各 2 天）、上周（7~13 天前）、上个月/上上个月（整月）、
//   X天前/X周前/X个月前（X 支持阿拉伯数字和常见中文数字；以目标日为中心前后各 2 天）、
//   今年X月（整月）、YYYY-MM-DD、YYYY年M月D日、M月D[日|号]（无年份按最近过去的那个日期）。
// 清单之外的表达（国庆、去年年底等）一律返回 null，不猜。
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const CN_AMOUNT_CLASS = '[0-9一二两俩三四五六七八九十]'

function parseAmount(value) {
  const trimmed = String(value ?? '').trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  return CN_DIGITS[trimmed] ?? null
}

// 日历加减月：clamp 到目标月最后一天，避免 10-31 减一月进位成 10-01 这类坑
function shiftMonths(date, delta) {
  const target = new Date(date.getFullYear(), date.getMonth() + delta, 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay))
}

// 某年某月（1-based）的整月窗口；center 取该月 15 号（月末不足 15 天时 clamp 到最后一天）
function monthWindow(year, month) {
  const lastDay = new Date(year, month, 0).getDate()
  const centerDay = Math.min(15, lastDay)
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    center: `${year}-${String(month).padStart(2, '0')}-${String(centerDay).padStart(2, '0')}`,
  }
}

function parseTimeWindow(query, now) {
  const text = String(query ?? '')
  const today = new Date(now.getTime())
  const dayAt = (offset) => localDay(today.getTime() + offset * DAY)
  // 每个窗口都带 center（YYYY-MM-DD）：窗口内文件按与 center 的日期距离从近往远搜，
  // 说「昨天」就优先昨天，不因 ±2 窗口把今天也包进来而先命中今天。
  const around = (offset) => ({ start: dayAt(offset - 2), end: dayAt(offset + 2), center: dayAt(offset) })
  const aroundDate = (date) => ({ start: localDay(date.getTime() - 2 * DAY), end: localDay(date.getTime() + 2 * DAY), center: localDay(date) })

  if (/上上个月/.test(text)) {
    const base = shiftMonths(today, -2)
    return monthWindow(base.getFullYear(), base.getMonth() + 1)
  }
  if (/上个月/.test(text)) {
    const base = shiftMonths(today, -1)
    return monthWindow(base.getFullYear(), base.getMonth() + 1)
  }
  if (/大前天/.test(text)) return around(-3)
  if (/前天/.test(text)) return around(-2)
  if (/昨天/.test(text)) return around(-1)
  // 「上上周」不在支持清单里：负向断言挡掉，避免被误当「上周」
  if (/(?<!上)上周/.test(text)) return { start: dayAt(-13), end: dayAt(-7), center: dayAt(-10) }

  const thisYearMonth = /今年\s*(\d{1,2})\s*月/.exec(text)
  if (thisYearMonth) {
    const month = Number(thisYearMonth[1])
    if (month >= 1 && month <= 12) return monthWindow(today.getFullYear(), month)
  }

  const daysAgo = new RegExp(`(?<![${CN_AMOUNT_CLASS}])(\\d+|[一二两俩三四五六七八九十])\\s*天前`).exec(text)
  if (daysAgo) { const amount = parseAmount(daysAgo[1]); if (amount) return around(-amount) }
  const weeksAgo = new RegExp(`(?<![${CN_AMOUNT_CLASS}])(\\d+|[一二两俩三四五六七八九十])\\s*周前`).exec(text)
  if (weeksAgo) { const amount = parseAmount(weeksAgo[1]); if (amount) return around(-7 * amount) }
  const monthsAgo = new RegExp(`(?<![${CN_AMOUNT_CLASS}])(\\d+|[一二两俩三四五六七八九十])\\s*个月前`).exec(text)
  if (monthsAgo) {
    const amount = parseAmount(monthsAgo[1])
    if (amount) return aroundDate(shiftMonths(today, -amount))
  }

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text)
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    if (Number.isFinite(date.getTime())) return aroundDate(date)
  }
  const cnDate = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(text)
  if (cnDate) {
    const date = new Date(Number(cnDate[1]), Number(cnDate[2]) - 1, Number(cnDate[3]))
    if (Number.isFinite(date.getTime())) return aroundDate(date)
  }
  const mdDate = /(\d{1,2})\s*月\s*(\d{1,2})(?:\s*[日号])?/.exec(text)
  if (mdDate) {
    const month = Number(mdDate[1])
    const day = Number(mdDate[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      // 无年份：默认今年；今年的这个日期还没到就用去年（最近过去的那个）
      let date = new Date(today.getFullYear(), month - 1, day)
      if (date.getTime() > today.getTime()) date = new Date(today.getFullYear() - 1, month - 1, day)
      return aroundDate(date)
    }
  }
  return null
}

// 兜底搜索：条目库无直接命中时先按时间线索窗口查，没命中再走默认阶梯
// （近2天 → 近7天 → 近30天 → 近180天），任何一层命中即返回，不往下。
function sceneFallback(query, options, now) {
  const terms = [...new Set(termsOf(query))].map((term) => normalizeText(term)).filter(Boolean)
  if (terms.length === 0) return []
  // 目录来源闸：只有明确给出情景目录来源（测试注入的 options.情景目录，或插件传入的 store）
  // 才兜底；直接传 records 的调用方（库外调用、单元测试）不碰默认库。
  if (!options?.情景目录 && !options?.store) return []
  const root = sceneRootOf(options)
  const names = sceneFileNames(root)
  if (names.length === 0) return []

  const window = parseTimeWindow(query, now)
  if (window) {
    const records = searchSceneFiles(names, window.start, window.end, window.center, root, terms)
    if (records.length > 0) return records
  }

  // 层与层不重叠：近2天=距今0~1天，近7天=2~6天，近30天=7~29天，近180天=30~179天
  const tiers = [
    { minAge: 0, maxAge: 1 },
    { minAge: 2, maxAge: 6 },
    { minAge: 7, maxAge: 29 },
    { minAge: 30, maxAge: 179 },
  ]
  const startOfToday = new Date(`${localDay(now.getTime())}T00:00:00`).getTime()
  for (const { minAge, maxAge } of tiers) {
    const files = names.filter((name) => {
      const start = new Date(`${name.slice(0, 10)}T00:00:00`).getTime()
      if (!Number.isFinite(start)) return false
      const age = Math.floor((startOfToday - start) / DAY)
      return age >= minAge && age <= maxAge
    })
    if (files.length === 0) continue
    for (const name of files) {
      let lines
      try { lines = readFileSync(join(root, name), 'utf8').split(/\r?\n/) } catch { continue }
      const records = sceneRecordsFrom(lines, name, terms)
      if (records.length > 0) return records
    }
  }
  return []
}

// 命中行 + 前后各 2 行拼片段，最多 3 段、每段截 300 字。
// 相邻命中行落在同一窗口时扩窗合并，不产出几乎重复的片段。
function sceneRecordsFrom(lines, file, terms) {
  const records = []
  let window = null
  for (let index = 0; index < lines.length; index++) {
    const haystack = normalizeText(lines[index])
    const hits = terms.filter((term) => haystack.includes(term))
    if (hits.length === 0) continue
    if (window && index <= window.end) {
      window.end = Math.min(lines.length - 1, index + 2)
      for (const term of hits) if (!window.hits.includes(term)) window.hits.push(term)
      continue
    }
    if (records.length >= 3) break
    window = { start: Math.max(0, index - 2), end: Math.min(lines.length - 1, index + 2), line: index + 1, hits }
    records.push(window)
  }
  return records.map(({ start, end, line, hits }) => ({
    id: `scene:${file}:${line}`,
    // 与 store.js 的原文段清洗口径一致：系统注入块整体替换为省略标记，
    // 先清洗再截断，不让注入块占掉 300 字配额。
    text: Array.from(lines.slice(start, end + 1).join('\n')
      .replace(/你说：Current runtime context[\s\S]*?(?=\n我说：|$)/g, '你说：（系统注入，已省略）'))
      .slice(0, 300).join('').trim(),
    来源: `情景原文 ${file} 第${line}行附近`,
    状态: '生效',
    记忆类别: '情景原文',
    相关度: 1,
    权重: 1,
    召回依据: { 关键词命中: hits, 时间近因: 1, 实体邻接: 0 },
    可能过时: false,
  }))
}

export function recall(query, options = {}) {
  const now = new Date(options.now ?? Date.now())
  const requested = options.limit ?? (options.complex ? 4 : 2)
  const limit = Math.max(1, Math.min(options.complex ? 4 : 2, Number(requested) || 2))
  const queryTerms = termsOf(query)
  const queryText = normalizeText(query)
  const records = recordsFrom(options).filter((record) => {
    // 只有当前生效记录进入日常召回；失效、已取代、归档和已完成记录仍保留在库中供审计。
    if (record?.状态 !== '生效') return false
    if (isValid(record, now)) return true
    // 2026-10-31：过期不等于失效。他定的是「到期不删，只标可能已过时，下次相关时问一句」，
    // 所以状态过期了仍然进召回，只是降权 + 挂提示，不能像以前那样一刀筛掉。
    return isExpired(record, now)
  })
  if (records.length === 0) return []

  const rows = records.map((record) => {
    const text = normalizeText(`${record.text ?? ''} ${record.原话 ?? ''} ${record.我的推断 ?? ''}`)
    const keywordHits = queryTerms.filter((term) => text.includes(normalizeText(term)))
    const wholeHit = queryText.length >= 2 && text.includes(queryText) ? 1 : 0
    const keyword = Math.min(1, wholeHit + keywordHits.length / Math.max(1, queryTerms.length))
    const entitySignal = entitiesOf(record).some((entity) => queryText.includes(normalizeText(entity)))
    const time = recordTime(record)
    const recency = time === null ? 0 : Math.exp(-Math.max(0, now.getTime() - time) / (30 * DAY))
    return {
      record,
      entities: entitiesOf(record),
      keyword,
      directSignal: wholeHit > 0 || keyword >= MIN_LEXICAL_DIRECT || entitySignal,
      recency,
      adjacency: 0,
      keywordHits,
      // 2026-10-31：权重接进召回。它管的是「先想哪个」，
      // isValid 管的是「能不能用」——两件事，各在各的位置上。
      weight: getWeight(record, now),
    }
  })

  const seedEntities = new Set(
    rows
      .filter((row) => row.directSignal)
      .flatMap((row) => row.entities),
  )
  for (const entity of rows.flatMap((row) => row.entities)) {
    if (queryText.includes(normalizeText(entity))) seedEntities.add(entity)
  }

  for (const entity of seedEntities) {
    const neighbors = rows
      .filter((row) => row.entities.includes(entity))
      .sort((left, right) => (right.keyword + right.recency) - (left.keyword + left.recency))
      .slice(0, 3)
    for (const row of neighbors) row.adjacency = Math.min(1, row.adjacency + 0.5)
  }

  const vectorSource = Array.isArray(options.vectorIds)
    ? options.vectorIds
    : vectorRecall(query, { ...options, records }).map((item) => item.id)
  const vectorIds = new Set(vectorSource.map(String))
  const vectorScores = options.vectorScores instanceof Map
    ? options.vectorScores
    : new Map(Object.entries(options.vectorScores ?? {}))
  const scoredRows = rows
    .map((row) => {
      const id = String(row.record.id)
      const rawVector = vectorScores.has(id) ? Number(vectorScores.get(id)) : (vectorIds.has(id) ? 1 : 0)
      const vector = Number.isFinite(rawVector) ? Math.max(0, Math.min(1, rawVector)) : 0
      const direct = Math.max(row.keyword, vector)
      const base = direct * 0.55 + row.recency * 0.2 + row.adjacency * 0.25
      // 权重当乘数（下限 0.4），不当加数：
      // 加的话「不相关但权重高」会挤掉「相关但权重低」，那就成按资历排座次了。
      // 2026-10-31：过期状态再打七折——能想起来，但不该排在前头，还得让他有机会确认。
      const staleFactor = row.record?.状态 !== '失效' && isValid(row.record, now) ? 1 : 0.7
      const relevance = base * (0.4 + 0.6 * row.weight) * staleFactor
      return { ...row, vector, relevance }
    })
  const directlyRelevant = scoredRows.filter((row) => row.directSignal || row.vector >= MIN_SEMANTIC_DIRECT)
  if (directlyRelevant.length === 0) return sceneFallback(query, options, now)

  // 时间近因和权重只负责排序，不能独自证明「相关」。
  // 但直接命中的记忆如果有冲突项，必须把冲突对方一并带出。
  const eligible = new Set(directlyRelevant.map((row) => String(row.record.id)))
  for (const row of directlyRelevant) {
    for (const candidate of scoredRows) {
      if (areConflicting(row.record, candidate.record)) eligible.add(String(candidate.record.id))
    }
  }
  const ordered = scoredRows
    .filter((row) => eligible.has(String(row.record.id)))
    .sort((left, right) => right.relevance - left.relevance || String(left.record.id).localeCompare(String(right.record.id)))

  const used = new Set()
  const groups = []
  for (const row of ordered) {
    if (used.has(row.record.id)) continue
    const mate = ordered.find((candidate) => !used.has(candidate.record.id) && areConflicting(row.record, candidate.record))
    if (mate) {
      used.add(row.record.id)
      used.add(mate.record.id)
      groups.push({ relevance: Math.max(row.relevance, mate.relevance) + 0.01, rows: [row, mate] })
    } else {
      used.add(row.record.id)
      groups.push({ relevance: row.relevance, rows: [row] })
    }
  }
  groups.sort((left, right) => right.relevance - left.relevance)

  const selected = []
  for (const group of groups) {
    if (selected.length + group.rows.length > limit) continue
    selected.push(...group.rows)
    if (selected.length === limit) break
  }

  return selected.map((row) => ({
    ...row.record,
    实体: row.entities,
    相关度: Number(row.relevance.toFixed(6)),
    权重: Number(row.weight.toFixed(6)),
    // 2026-10-31：接上 isExpired。它只负责说一句「这条可能过时了」，
    // 不改内容、不筛掉——所以跟 isValid（硬界限）不是一回事。
    可能过时: isExpired(row.record, now),
    召回依据: {
      关键词命中: row.keywordHits,
      时间近因: Number(row.recency.toFixed(6)),
      实体邻接: Number(row.adjacency.toFixed(6)),
    },
  }))
}

