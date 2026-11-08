import { isValid } from './valid.js'
import { getWeight } from './weight.js'
import { isExpired } from './expiry.js'
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
  if (directlyRelevant.length === 0) return []

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

