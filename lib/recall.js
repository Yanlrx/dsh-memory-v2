import { isValid } from './valid.js'
import { getWeight } from './weight.js'
import { isExpired } from './expiry.js'

const DAY = 24 * 60 * 60 * 1000
const COLLECTIONS = ['语义', '结论', '画像', '临时']

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
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].slice(0, 5)
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

// 字符 n-gram 向量化：单字 + 相邻二字作为特征，算余弦相似度做「轻量向量召回」。
// 不依赖外部模型；真正的语义 embedding（累→困 那种跨词义）需要另接向量模型。
function ngramVector(text) {
  const value = normalizeText(text)
  const vec = new Map()
  const add = (term) => vec.set(term, (vec.get(term) || 0) + 1)
  for (let i = 0; i < value.length; i++) {
    add(value[i])
    if (i + 1 < value.length) add(value.slice(i, i + 2))
  }
  return vec
}

function cosineSimilarity(left, right) {
  if (!left.size || !right.size) return 0
  const smaller = left.size <= right.size ? left : right
  const larger = left.size <= right.size ? right : left
  let dot = 0
  for (const [term, count] of smaller) {
    if (larger.has(term)) dot += count * larger.get(term)
  }
  let normLeft = 0
  let normRight = 0
  for (const count of left.values()) normLeft += count * count
  for (const count of right.values()) normRight += count * count
  if (!normLeft || !normRight) return 0
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight))
}

export function vectorRecall(query, options = {}) {
  const records = recordsFrom(options).filter((record) => record?.状态 !== '失效')
  if (records.length === 0) return []
  const queryVec = ngramVector(query)
  if (queryVec.size === 0) return []
  const limit = Math.max(1, Math.min(Number(options.limit) || 8, 16))
  return records
    .map((record) => {
      const text = `${record.text ?? ''} ${record.原话 ?? ''}`
      return { id: String(record.id), similarity: cosineSimilarity(queryVec, ngramVector(text)) }
    })
    .filter((item) => item.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit)
}

export function recall(query, options = {}) {
  const now = new Date(options.now ?? Date.now())
  const requested = options.limit ?? (options.complex ? 8 : 4)
  const limit = Math.max(1, Math.min(options.complex ? 8 : 4, Number(requested) || 4))
  const queryTerms = termsOf(query)
  const queryText = normalizeText(query)
  const records = recordsFrom(options).filter((record) => {
    if (record?.状态 === '失效') return false
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
    const time = recordTime(record)
    const recency = time === null ? 0 : Math.exp(-Math.max(0, now.getTime() - time) / (30 * DAY))
    return {
      record,
      entities: entitiesOf(record),
      keyword,
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
      .filter((row) => row.keyword > 0)
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

  const vectorScores = new Map(vectorRecall(query, { ...options, records }).map((item) => [String(item.id), item.similarity]))
  const ordered = rows.filter((row) => row.keyword > 0 || row.adjacency > 0)
    .map((row) => {
      const vector = vectorScores.get(String(row.record.id)) ?? 0
      const base = row.keyword * 0.5 + row.recency * 0.2 + row.adjacency * 0.2 + vector * 0.1
      // 权重当乘数（下限 0.4），不当加数：
      // 加的话「不相关但权重高」会挤掉「相关但权重低」，那就成按资历排座次了。
      // 2026-10-31：过期状态再打七折——能想起来，但不该排在前头，还得让他有机会确认。
      const staleFactor = row.record?.状态 !== '失效' && isValid(row.record, now) ? 1 : 0.7
      const relevance = base * (0.4 + 0.6 * row.weight) * staleFactor
      return { ...row, relevance }
    })
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

