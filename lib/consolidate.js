import { randomUUID } from 'node:crypto'

const MEMORY_MARKERS = /(喜欢|讨厌|偏好|要求|决定|约定|以后|一直|从不|不要|不许|叫我|称呼|是|有|住在|工作|习惯|需要)/
const LOW_VALUE = /^(你好|在吗|哈+哈*|嗯+|好的|知道了|今天天气|吃了什么)[。！？!?]*$/

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function sourceOf(context = {}) {
  return context.来源 ?? context.source ?? context.门牌 ?? new Date(context.now ?? Date.now()).toISOString()
}

function makeCandidate(type, text, source, confidence, extra = {}) {
  return {
    id: randomUUID(),
    类型: type,
    text: cleanText(text),
    来源: source,
    置信度: Math.max(0, Math.min(1, Number(confidence) || 0)),
    created_at: new Date(extra.now ?? Date.now()).toISOString(),
    状态: '候选',
    ...extra,
  }
}

function worthKeeping(text) {
  if (!text || text.length < 4 || LOW_VALUE.test(text)) return false
  if (/[？?]$/.test(text) && !/(我|用户)/.test(text)) return false
  return MEMORY_MARKERS.test(text) || /(明确|固定|每次|永远|必须|不能)/.test(text)
}

function buildLightCandidate(text, context = {}) {
  const cleaned = cleanText(text)
  if (!worthKeeping(cleaned)) return null
  const confidence = /(明确|必须|不许|永远|要求|决定)/.test(cleaned) ? 0.9 : 0.72
  return makeCandidate('事实', cleaned.slice(0, 200), sourceOf(context), confidence, { now: context.now })
}

function normalize(value) {
  return cleanText(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function canonicalPolarity(value) {
  const text = normalize(value)
  const negative = /(不喜欢|不是|不能|不要|没有|从不|讨厌)/.test(text)
  return {
    negative,
    subject: text.replace(/(不喜欢|不是|不能|不要|没有|从不|讨厌|喜欢|是|能|要|有)/g, ''),
  }
}

function sameFact(left, right) {
  const a = normalize(left)
  const b = normalize(right)
  if (!a || !b) return false
  return a === b || (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a)))
}

function conflicts(left, right) {
  const a = canonicalPolarity(left)
  const b = canonicalPolarity(right)
  return a.subject.length >= 2 && a.subject === b.subject && a.negative !== b.negative
}

function roundText(round) {
  if (typeof round === 'string') return round
  return round?.text ?? round?.content ?? round?.user ?? round?.message ?? ''
}

function roundSource(round, index) {
  if (!round || typeof round === 'string') return `recentRounds[${index}]`
  return round.来源 ?? round.source ?? round.门牌 ?? `recentRounds[${index}]`
}

export function light(text, context = {}) {
  const candidate = buildLightCandidate(text, context)
  if (candidate && context.store?.appendCandidate) context.store.appendCandidate(candidate)
  return candidate
}

export function heavy(recentRounds, context = {}) {
  if (!Array.isArray(recentRounds)) throw new TypeError('recentRounds 必须是数组')
  const facts = recentRounds
    .map((round, index) => buildLightCandidate(roundText(round), {
      ...context,
      来源: roundSource(round, index),
      now: round?.now ?? context.now,
    }))
    .filter(Boolean)

  const groups = []
  for (const fact of facts) {
    const group = groups.find((item) => sameFact(item[0].text, fact.text))
    if (group) group.push(fact)
    else groups.push([fact])
  }

  const candidates = groups.map((group) => {
    if (group.length === 1) return group[0]
    const latest = group[group.length - 1]
    return makeCandidate('结论', latest.text, group.map((item) => item.来源), Math.min(0.98, 0.78 + group.length * 0.05), {
      now: context.now,
      去重数: group.length,
    })
  })

  const comparable = [...candidates]
  for (let left = 0; left < comparable.length; left++) {
    for (let right = left + 1; right < comparable.length; right++) {
      if (!conflicts(comparable[left].text, comparable[right].text)) continue
      candidates.push(makeCandidate(
        '冲突',
        `存在冲突：${comparable[left].text} ↔ ${comparable[right].text}`,
        [comparable[left].来源, comparable[right].来源],
        Math.min(comparable[left].置信度, comparable[right].置信度),
        { now: context.now, 冲突双方: [comparable[left].id, comparable[right].id] },
      ))
    }
  }

  if (context.store?.appendCandidate) {
    for (const candidate of candidates) context.store.appendCandidate(candidate)
  }
  return candidates
}

