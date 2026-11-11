// 2026-10-31：仅存可见文本，优先 inbox 原话，缺栏仍存档并限次诊断；四组合测试随本轮七项回归运行。
import { createHash, randomUUID } from 'node:crypto'
// 2026-10-31：移除输入和输出 schema 的 required，保留 execute 校验及 diag；四组合测试随六项回归运行。
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStore } from './store.js'
import { recall, semanticRecall } from './recall.js'
import { planUpdate, applyUpdate } from './update.js'
import { isValid } from './valid.js'
import { isExpired } from './expiry.js'
import { loadHostDeps } from './hostdeps.mjs'
import z from '@deepseek-ai/schemastery'

export const name = 'memory-v2'
export const inject = ['systemPrompt', 'agents', 'timer', 'tools', 'webServer']

export const Config = z.object({
  语义召回: z.boolean().default(false).description('开关：打开后，记忆召回会用 AI 语义搜索（embedding），问「累」能召回「困」这种意思相近但字不同的记忆。默认关，首次打开加载模型约几秒。'),
  诊断日志: z.boolean().default(false).description('是否写入本地诊断日志。默认关闭；日志不包含消息正文、会话 ID 或 RPC 标识。'),
  启用敏感调试路由: z.boolean().default(false).description('是否开启 /memory-v2/candidates。该路由可返回记忆候选正文，默认关闭。'),
  启用全局主库工具: z.boolean().default(false).description('仅限明确的单用户部署；多用户分库应保持关闭并使用会话专属工具。'),
})

const COLLECTIONS = ['语义', '结论', '画像', '临时']

function normalizedMemoryText(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

const ALLOWED_KINDS = new Set(['事件', '状态', '偏好', '策略'])
const TTL_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|mo|y)$/

function normalizeKinds(value, fallback = ['事件']) {
  const source = value === undefined ? fallback : value
  if (!Array.isArray(source) || source.length === 0 || source.some((item) => typeof item !== 'string')) throw new TypeError('kinds 必须是非空字符串数组')
  const kinds = [...new Set(source.map((item) => item.trim()).filter(Boolean))]
  if (kinds.length === 0 || kinds.some((kind) => !ALLOWED_KINDS.has(kind))) throw new TypeError('kind 只能是事件、状态、偏好或策略')
  if (kinds.includes('状态') && (kinds.includes('偏好') || kinds.includes('策略'))) throw new TypeError('状态不能和偏好或策略同时写入')
  return kinds
}

function normalizeTtl(value) {
  const raw = String(value ?? '').trim()
  const match = raw.match(TTL_PATTERN)
  if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) throw new TypeError('ttl 必须是正数加单位，例如 7d')
  return raw
}

function normalizeEntities(value, fallback = []) {
  const source = value === undefined ? fallback : value
  if (!Array.isArray(source) || source.some((item) => typeof item !== 'string')) throw new TypeError('entities 必须是字符串数组')
  if (source.length > 5) throw new TypeError('实体最多 5 个')
  const result = []
  const seen = new Set()
  for (const item of source) {
    const display = item.trim()
    const key = normalizedMemoryText(display)
    if (!key) throw new TypeError('实体不能只包含空白或标点')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(display)
  }
  return result
}

function textOfMessage(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  if (/reasoning|thinking/i.test(String(message.type ?? ''))) return ''
  if (typeof message.text === 'string') return message.text
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    if (typeof part === 'string') return [part]
    if (!part || /reasoning|thinking/i.test(String(part.type ?? ''))) return []
    return (part.type === undefined || part.type === 'text') && typeof part.text === 'string' ? [part.text] : []
  }).join('\n')
}

function textOfEvent(event) {
  for (const message of [event?.data?.message, event?.data, event?.message]) {
    const text = textOfMessage(message)
    if (text) return text
  }
  return ''
}

function lastUserTextOf(session) {
  try {
    const events = session?.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index]?.type === 'user/message') {
        const text = textOfEvent(events[index])
        if (text) return text
      }
    }
  } catch {}
  return ''
}

function renderProfile(records) {
  // 身份锚只保留稳定身份、称呼和核心偏好；流程性规则不应混入长期画像。
  const preferenceLines = []
  const operational = /规则|规矩|流程|操作|确认|备份|巩固|插件|文件|高危|验收|路径|工具|记忆/
  const ordered = [...records].sort((left, right) => {
    const leftAt = new Date(left?.last_confirmed ?? left?.event_time ?? 0).getTime() || 0
    const rightAt = new Date(right?.last_confirmed ?? right?.event_time ?? 0).getTime() || 0
    return rightAt - leftAt
  })
  for (const record of ordered) {
    if (record?.状态 !== '生效') continue
    const kinds = Array.isArray(record.kind) ? record.kind : []
    if (!kinds.includes('偏好')) continue
    const original = String(record.原话 || record.text || '').replace(/^[「『“"]|[」』”"]$/g, '')
    if (!original || operational.test(original)) continue
    preferenceLines.push(`[你说的] ${original}`)
    if (record.我的推断) {
      preferenceLines.push(`[我读出来的] ${record.我的推断} ← 原话「${original}」｜语境 ${record.来源}`)
    }
    if (preferenceLines.join('\n').length >= 300) break
  }
  return preferenceLines.join('\n').slice(0, 300)
}

function renderRecall(records) {
  if (records.length === 0) return ''
  // 2026-10-31：可能过时的（状态类超过 ttl）在那一行后面挂一句，提醒可以问一声。
  // 只是提示，不改内容、不拦召回。
  return ['[本轮召回]', ...records.map((record) => {
    const stale = record.可能过时 ? '（这条可能过时了，可以问他一句）' : ''
    return `- ${record.text}${stale}｜来源 ${record.来源}`
  })].join('\n')
}

// 2026-11-02：召回带原文段。命中记录的「来源」里有日期+时间（如 2026-11-01 21:08），
// 按它回情景库找那个时间的段，截 200 字、最多 1 段、同一段不重复。找不到就少给，不硬凑。
// 2026-11-02 克制：shown 是「本会话浮出时间表」（day+hhmm → 时间戳），冷却期内不再端。
function renderSceneHints(records, store, { maxSegments = 1, maxChars = 200, shown, cooldownMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  if (!Array.isArray(records) || records.length === 0 || typeof store?.sceneSegment !== 'function') return ''
  const seen = new Set()
  const parts = []
  for (const record of records) {
    if (parts.length >= maxSegments) break
    const source = String(record?.来源 ?? '')
    const sceneId = (source.match(/scene:([0-9a-f-]{16,})/i) || [])[1]
    if (sceneId && typeof store.sceneSegmentById === 'function') {
      try {
        const segment = store.sceneSegmentById(sceneId)
        if (segment) {
          const cleaned = segment.replace(/你说：Current runtime context[\s\S]*?(?=\n我说：|$)/g, '你说：（系统注入，已省略）')
          const body = Array.from(cleaned).slice(0, maxChars).join('').trim()
          const key = `scene:${sceneId}`
          const last = shown?.get?.(key)
          if (body && !(typeof last === 'number' && now - last < cooldownMs)) {
            shown?.set?.(key, now)
            parts.push(`〔原文段 · ${key}〕\n${body}`)
            continue
          }
        }
      } catch { /* 按 ID 找不到时再尝试旧日期格式 */ }
    }
    const match = source.match(/(\d{4}-\d{2}-\d{2})[^\d]*?(\d{1,2}:\d{2})/)
    if (!match) continue
    const day = match[1]
    const hhmm = match[2]
    const key = day + ' ' + hhmm
    if (seen.has(key)) continue
    seen.add(key)
    if (shown && typeof shown.get === 'function') {
      const last = shown.get(key)
      if (typeof last === 'number' && now - last < cooldownMs) continue
    }
    try {
      const segment = store.sceneSegment(day, hhmm)
      if (!segment) continue
      // 旧数据里「你说」可能存着系统注入块（老代码抓最后一条消息抓到的），
      // 注入前剥掉整块（从「你说：Current runtime context」直到「我说：」或段尾），别让上下文块冒充原话。
      const cleaned = segment.replace(/你说：Current runtime context[\s\S]*?(?=\n我说：|$)/g, '你说：（系统注入，已省略）')
      const body = Array.from(cleaned).slice(0, maxChars).join('').trim()
      if (!body || body === `## ${hhmm}`) continue
      if (shown && typeof shown.set === 'function') shown.set(key, now)
      parts.push(`〔原文段 · ${day} ${hhmm}〕\n${body}`)
    } catch { /* 段读不出来就跳过，别影响主召回 */ }
  }
  return parts.length ? '[原文段]\n' + parts.join('\n') : ''
}

// 2026-11-02：情绪线索。他说了累/困/烦这类词时，额外按情绪召回一次「上次原因」。
const EMOTION_WORDS = [
  ['累死', '累'], ['累', '累'], ['困', '困'], ['烦', '烦'], ['难受', '难受'],
  ['委屈', '委屈'], ['气死', '生气'], ['火大', '生气'], ['崩溃', '难受'], ['郁闷', '郁闷'],
]
function detectEmotion(text) {
  const value = String(text ?? '')
  for (const [word, kind] of EMOTION_WORDS) {
    if (value.includes(word)) return { word, kind }
  }
  return null
}

function hasPastCue(text) {
  return /过去|以前|曾经|之前|上次|那次|刚才|昨天|前天|几天前|说过|让我|不是让你|记得|记没记|还记得/.test(String(text ?? ''))
}

function shouldAutoRecall(text) {
  const value = String(text ?? '')
  return hasPastCue(value) || /偏好|喜欢|讨厌|习惯|名字|称呼|谁是/.test(value) || Boolean(detectEmotion(value))
}

function outputSchema(properties) {
  return {
    schema: {
      type: 'object', additionalProperties: false,
      properties: { ok: { type: 'boolean' }, message: { type: 'string' }, ...properties },
    },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value) }]
    },
  }
}

function makeWriteTool(store, clock, defineTool, runtime = {}) {
  const diag = runtime.diag ?? (() => {})
  return defineTool({
    name: 'memory_write',
    description: '写入一条经明确确认的记忆，一条只写一件事。更新已有状态时必须传 supersede，避免新旧状态同时生效。',
    parameters: {
      text: { type: 'string', description: '记忆正文，1~100 字。' },
      collection: { type: 'string', description: '语义/结论/画像/临时，默认语义。' },
      kinds: { type: 'array', items: { type: 'string' }, description: '事件/状态/偏好等类型。' },
      entities: { type: 'array', items: { type: 'string' }, description: '最多 5 个实体。' },
      source: { type: 'string', description: '来源时间或会话位置。' },
      doorplate: { type: 'string', description: '可回找的会话门牌。' },
      ttl: { type: 'string', description: '状态的有效期，如 7d。' },
      conflict: { type: 'array', items: { type: 'string' }, description: '与本条冲突的记忆 id。' },
      supersede: { type: 'string', description: '更新已有状态或偏好时填写旧记录 id；新证据替代旧记录时必须提供。' },
      opposite: { type: 'boolean', description: '配合 supersede：这条新证据是不是反证。' },
      allowParallel: { type: 'boolean', description: '只有明确要保留同主题多条并行记忆时才传 true。' },
    },
    output: outputSchema({
      id: { type: 'string' },
      collection: { type: 'string' },
      // 2026-10-31：supersede 分支会多返回这两个，output schema 是 additionalProperties:false，
      // 不在这里声明就会被当成非法输出（真机上踩过一次）。
      action: { type: 'string' },
      reason: { type: 'string' },
      // 新写那条会在候选里留一条审计记录，返回它的 id（留痕失败时是空串）
      candidateId: { type: 'string' },
      duplicateOf: { type: 'string' },
      needsSupersede: { type: 'array', items: { type: 'string' } },
    }),
    async execute(args = {}) {
      if (args.text !== undefined && typeof args.text !== 'string') return { ok: false, message: 'text 必须是字符串' }
      if (args.supersede !== undefined && (typeof args.supersede !== 'string' || !args.supersede.trim())) return { ok: false, message: 'supersede 必须是非空字符串' }
      if (args.opposite !== undefined && typeof args.opposite !== 'boolean') return { ok: false, message: 'opposite 必须是布尔值' }
      if (args.allowParallel !== undefined && typeof args.allowParallel !== 'boolean') return { ok: false, message: 'allowParallel 必须是布尔值' }
      if (args.conflict !== undefined && (!Array.isArray(args.conflict) || args.conflict.some((item) => typeof item !== 'string' || !item.trim()))) {
        return { ok: false, message: 'conflict 必须是非空字符串数组' }
      }
      const text = String(args.text ?? '').trim()
      if (text.length < 1 || text.length > 100) return { ok: false, message: 'text 必须为 1~100 字' }
      const collection = args.collection === undefined ? '语义' : args.collection
      if (!COLLECTIONS.includes(collection)) return { ok: false, message: 'collection 只能是语义、结论、画像或临时' }
      const timestamp = new Date(clock()).toISOString()
      let kinds

      // 2026-10-31：接上更新机制。
      // 传了 supersede 就是「改旧的那条」，不传就是「新写一条」——不做自动猜测，
      // 因为猜错了会把两条不相干的事合成一条，比不更新更糟。
      if (args.supersede) {
        const targetId = String(args.supersede)
        let target = null
        let targetCollection = null
        for (const name of COLLECTIONS) {
          const found = store.readCollection(name).find((item) => String(item.id) === targetId)
          if (found) { target = found; targetCollection = name; break }
        }
        if (!target) return { ok: false, message: `找不到要更新的记录：${targetId}` }
        if (target.状态 !== '生效') return { ok: false, message: `要替代的记忆不是生效状态：${targetId}` }
        const targetKinds = Array.isArray(target.kind) ? target.kind : []
        try { kinds = normalizeKinds(args.kinds, targetKinds) } catch (error) { return { ok: false, message: error.message } }
        if (!kinds.some((kind) => targetKinds.includes(kind))) return { ok: false, message: `supersede 的新旧记忆类型不兼容：${targetId}` }
        const oldEntities = Array.isArray(target.实体) ? target.实体.map(String) : []
        let newEntities
        try { newEntities = args.entities === undefined ? normalizeEntities(oldEntities) : normalizeEntities(args.entities) } catch (error) { return { ok: false, message: error.message } }
        const oldEntityKeys = new Set(oldEntities.map(normalizedMemoryText).filter(Boolean))
        if (newEntities.length > 0 && oldEntityKeys.size > 0 && !newEntities.some((entity) => oldEntityKeys.has(normalizedMemoryText(entity)))) {
          return { ok: false, message: `supersede 的新旧记忆实体不相交：${targetId}` }
        }
        let ttl = null
        try {
          if (kinds.includes('状态')) ttl = normalizeTtl(args.ttl ?? target.ttl)
          else if (args.ttl !== undefined && String(args.ttl).trim()) return { ok: false, message: '非状态记忆不能设置 ttl' }
        } catch (error) { return { ok: false, message: error.message } }

        const plan = planUpdate(target, {
          now: clock(),
          evidence: { text, 相反: Boolean(args.opposite), 来源: args.source ?? timestamp },
        })
        const planned = applyUpdate(target, plan, clock())
        const textChanged = normalizedMemoryText(text) !== normalizedMemoryText(target.text)
        const next = {
          ...planned,
          text,
          原话: text,
          kind: kinds,
          实体: newEntities.length > 0 ? newEntities : oldEntities,
          来源: String(args.source ?? timestamp),
          门牌: String(args.doorplate ?? target.门牌),
          last_confirmed: kinds.some((kind) => ['状态', '偏好', '策略'].includes(kind)) ? timestamp : target.last_confirmed,
          ttl,
          版本: Number(planned.版本 ?? target.版本 ?? 1) + (textChanged && plan.action !== 'revise' ? 1 : 0),
          状态: '生效',
        }
        const candidate = {
          id: randomUUID(), 类型: '更新', text, 来源: String(args.source ?? timestamp),
          置信度: next.置信度 ?? target.置信度, created_at: new Date(clock()).toISOString(),
          状态: '已转正', 落库id: target.id, 落库类别: targetCollection,
          动作: plan.action, 原因: plan.reason,
        }
        try { store.replaceRecord(targetCollection, next, { candidate }) }
        catch (error) { return { ok: false, message: String(error?.message ?? error) } }
        return { ok: true, id: target.id, collection: targetCollection, action: plan.action, reason: plan.reason, candidateId: candidate.id }
      }

      try { kinds = normalizeKinds(args.kinds, ['事件']) } catch (error) { return { ok: false, message: error.message } }
      let ttl = null
      try {
        if (kinds.includes('状态')) ttl = normalizeTtl(args.ttl)
        else if (args.ttl !== undefined && String(args.ttl).trim()) return { ok: false, message: '非状态记忆不能设置 ttl' }
      } catch (error) { return { ok: false, message: error.message } }
      const all = store.readAll()
      const active = COLLECTIONS.flatMap((name) => (all[name] ?? []).map((record) => ({ ...record, collection: name }))).filter((record) => record?.状态 === '生效')
      const duplicate = active.find((record) => normalizedMemoryText(record.text) === normalizedMemoryText(text))
      if (duplicate) return { ok: false, message: `已有相同生效记忆：${duplicate.id}，请使用 supersede`, duplicateOf: String(duplicate.id) }
      let newEntities
      try { newEntities = normalizeEntities(args.entities, []) } catch (error) { return { ok: false, message: error.message } }
      if (kinds.some((kind) => kind === '状态' || kind === '偏好') && newEntities.length === 0) {
        return { ok: false, message: '状态/偏好记忆必须提供至少一个实体，用于防止同主题重复生效' }
      }
      const conflictIds = new Set((args.conflict ?? []).map((item) => item.trim()))
      const overlaps = active.filter((record) => {
        const recordKinds = Array.isArray(record.kind) ? record.kind : []
        const recordEntities = Array.isArray(record.实体) ? record.实体.map(String) : []
        const recordEntityKeys = new Set(recordEntities.map(normalizedMemoryText).filter(Boolean))
        return kinds.some((kind) => (kind === '状态' || kind === '偏好') && recordKinds.includes(kind)) && newEntities.some((entity) => recordEntityKeys.has(normalizedMemoryText(entity)))
      })
      const unresolved = overlaps.filter((record) => !conflictIds.has(String(record.id)))
      if (unresolved.length > 0 && !args.allowParallel) {
        return { ok: false, message: '发现同实体同类型的生效记忆，请显式使用 supersede、conflict 或 allowParallel', needsSupersede: unresolved.map((record) => String(record.id)) }
      }

      const record = {
        id: randomUUID(), text, kind: kinds, 主体: '本人', 说话人: '本人', 原话: text, 我的推断: '',
        来源: String(args.source ?? timestamp), 门牌: String(args.doorplate ?? `memory_write + ${timestamp}`),
        event_time: kinds.includes('事件') ? timestamp : null,
        // 2026-10-31：策略跟偏好一样需要 last_confirmed（持续有效、没有到期日）。
        // 这里漏过一次，结果策略写不进去、报「策略必须有 last_confirmed」。
        last_confirmed: kinds.includes('状态') || kinds.includes('偏好') || kinds.includes('策略') ? timestamp : null,
        ttl,
        置信度: 1, 证据: [], 出现次数: 1, 被召回次数: 0,
        实体: newEntities,
        冲突: conflictIds.size > 0 ? [...conflictIds] : null,
        版本: 1, 状态: '生效',
      }
      const candidate = {
        id: randomUUID(), 类型: '事实', text: record.text, 来源: record.来源,
        置信度: record.置信度, created_at: new Date(clock()).toISOString(),
        状态: '已转正', 落库id: record.id, 落库类别: collection, 实体: record.实体,
      }
      try { store.appendRecord(collection, record, { candidate }) }
      catch (error) { return { ok: false, message: String(error?.message ?? error) } }
      return { ok: true, id: record.id, collection, candidateId: candidate.id }
    },
  })
}

function makeRecallTool(store, clock, defineTool, runtime = {}) {
  const diag = runtime.diag ?? (() => {})
  const semanticEnabled = Boolean(runtime.semanticEnabled)
  return defineTool({
    name: 'memory_recall',
    description: '按当前问题查找最相关的当前记忆，默认最多 2 条；复杂历史问题最多 4 条。',
    parameters: {
      query: { type: 'string', description: '要查的问题或关键词。' },
      complex: { type: 'boolean', description: '复杂历史问题可扩到 4 条。' },
    },
    output: outputSchema({
      records: { type: 'array', items: { type: 'object', additionalProperties: true } },
      // 2026-10-31：多返回一个「这轮记了几条被召回次数」，必须在这里声明——
      // output schema 是 additionalProperties:false，不声明就是非法输出。
      bumped: { type: 'integer' },
      semanticRequested: { type: 'boolean' },
      semanticUsed: { type: 'boolean' },
      semanticError: { type: 'string' },
    }),
    async execute(args = {}) {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, message: 'query 不许为空' }
      let allRecords = null
      let semantic = []
      let semanticUsed = false
      let semanticError = ''
      if (semanticEnabled) {
        try {
          const all = store.readAll()
          allRecords = COLLECTIONS
            .flatMap((collection) => (Array.isArray(all[collection]) ? all[collection] : []))
            .filter((record) => record?.状态 === '生效' && (isValid(record, clock()) || isExpired(record, clock())))
          semantic = await semanticRecall(query, allRecords)
          semanticUsed = true
        } catch (error) {
          semanticError = 'semantic-model-unavailable'
          diag('语义召回失败: semantic-model-unavailable')
        }
      }
      const semanticScores = new Map(semantic.map((item) => [String(item.id), item.similarity]))
      const records = recall(query, {
        ...(allRecords ? { records: allRecords, store } : { store }),
        complex: Boolean(args.complex),
        now: clock(),
        vectorIds: [...semanticScores.keys()],
        vectorScores: semanticScores,
      }).map((record) => semanticScores.has(String(record.id))
        ? { ...record, 语义相似度: semanticScores.get(String(record.id)) }
        : record)
      // 召回一次记一次：被召回次数是权重唯一的输入，不记它，权重永远是 0。
      // 只在我主动调工具时记；每轮自动注入那条路不写盘（一晚上要写一百多次，太吵）。
      let bumped = 0
      try { bumped = store.bumpRecall(records.map((item) => item.id)) } catch { diag('bumpRecall 失败') }
      return { ok: true, records, bumped, semanticRequested: semanticEnabled, semanticUsed, semanticError }
    },
  })
}

const { defineTool } = await loadHostDeps()

// 2026-10-31：钩子只存档和计数，原文由调用者自行巩固；三函数未改，七项回归验证。
function makeConsolidateTool(store, clock, defineTool, runtime = {}) {
  const diag = runtime.diag ?? (() => {})
  return defineTool({
    name: 'memory_consolidate',
    description: '两阶段巩固：首次返回最多 8000 字原文和 ackToken，不清除待巩固记录。完成所有 memory_write 后，再用同一工具传 ackToken 确认；未确认或写入失败时不得确认。',
    parameters: {
      rounds: { type: 'integer', description: '本次最多读取多少个未巩固情景，默认按 8000 字自动分块。' },
      ackToken: { type: 'string', description: '仅在本批记忆全部写入成功后，传回上次返回的 ackToken。' },
      abandonToken: { type: 'string', description: '放弃未确认租约但不推进巩固进度。' },
    },
    output: outputSchema({
      date: { type: 'string' }, rounds: { type: 'integer' }, text: { type: 'string' },
      ackToken: { type: 'string' }, remaining: { type: 'integer' }, truncated: { type: 'boolean' },
      resumed: { type: 'boolean' }, acknowledged: { type: 'boolean' }, idempotent: { type: 'boolean' },
      abandoned: { type: 'boolean' },
    }),
    async execute(args = {}) {
      diag('memory_consolidate 调用')
      try {
        const result = store.consolidateScenes(args.rounds, clock(), diag, { ackToken: args.ackToken, abandonToken: args.abandonToken })
        diag('memory_consolidate 完成')
        return result
      } catch (error) {
        diag('memory_consolidate 失败')
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })
}

// 2026-11-02：trace 溯源工具。按字面查「他说过吗/我答应过吗/这句话谁说的」，
// 不问意思。查不到就是没有，别拿 recall 的相似段顶上。结果带日期+时分。
function makeTraceTool(store, clock, defineTool) {
  return defineTool({
    name: 'memory_trace',
    description: '按字面查原话在不在记忆里（他说过吗、我答应过吗、这句话谁说的）。一字不差地查，不问意思；结果带日期和时分，可回情景库核对。查不到就是没有，不要拿 recall 里「很像的一段」顶上。',
    parameters: {
      query: { type: 'string', description: '要查的那句话，可以整段贴进来。' },
    },
    output: outputSchema({
      hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
    async execute(args = {}) {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, message: 'query 不许为空' }
      const hits = store.traceScene(query)
      return { ok: true, hits }
    },
  })
}

export function apply(ctx, config = {}) {
  const semanticEnabled = Boolean(config?.语义召回)
  const diagnosticsEnabled = Boolean(config?.诊断日志)
  const sensitiveRouteEnabled = Boolean(config?.启用敏感调试路由)
  const globalToolsEnabled = Boolean(config?.启用全局主库工具)
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const diagnosticPath = join(dshHome, 'memory-v2-diag.log')
  const diag = (message) => {
    if (!diagnosticsEnabled) return
    try { appendFileSync(diagnosticPath, new Date().toISOString() + '  ' + message + '\n') } catch { /* 诊断不许把插件搞挂 */ }
  }
  const runtime = Object.freeze({ diag, semanticEnabled })
  diag('apply 开始 | ctx 字段: ' + Object.keys(ctx || {}).join(','))
  diag('开始 createStore')
  const store = createStore()
  diag('store 建好')

  const pluginConfigPath = join(dshHome, 'dsh-memory-v2-config.json')
  const defaultPluginConfig = Object.freeze({ 会话白名单: [], 排除会话: [], 会话归属: {}, 排除归属: [], 未映射会话写入待认领: false })
  let lastGoodConfig = null
  let configWasPresent = false
  let configRevision = 0

  function ownerStorageKey(value) {
    const original = String(value ?? '').normalize('NFKC').trim()
    if (!original) throw new TypeError('分库标识无效')
    if (original === 'main' || original === 'pending') throw new TypeError('分库标识不能使用保留名 main 或 pending')
    const slug = original.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'owner'
    const hash = createHash('sha256').update(original, 'utf8').digest('hex').slice(0, 16)
    return `owner-${slug}-${hash}`
  }

  function legacyOwnerStorageKey(value) {
    const normalized = String(value ?? '').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-')
    if (!normalized || normalized === '.' || normalized === '..') throw new TypeError('旧版分库标识无效')
    return normalized.slice(0, 64)
  }

  function legacyOwnerClaimKey(value) {
    const key = legacyOwnerStorageKey(value)
    return process.platform === 'win32' ? key.toLowerCase().replace(/[. ]+$/g, '') : key
  }

  function normalizePluginConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('插件配置必须是对象')
    const array = (key) => {
      if (value[key] === undefined) return []
      if (!Array.isArray(value[key])) throw new TypeError(`${key} 必须是数组`)
      if (value[key].some((item) => typeof item !== 'string' || !item.trim())) throw new TypeError(`${key} 只能包含非空字符串`)
      return [...new Set(value[key].map((item) => item.trim()))]
    }
    const mapping = value.会话归属 === undefined ? {} : value.会话归属
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new TypeError('会话归属必须是对象')
    const normalizedMapping = Object.create(null)
    for (const [sid, owner] of Object.entries(mapping)) {
      const cleanSid = sid.trim()
      if (typeof owner !== 'string') throw new TypeError('会话归属的值必须是非空字符串')
      const cleanOwner = owner.normalize('NFKC').trim()
      if (!cleanSid || !cleanOwner) throw new TypeError('会话归属不能包含空键或空值')
      ownerStorageKey(cleanOwner)
      Object.defineProperty(normalizedMapping, cleanSid, { value: cleanOwner, enumerable: true, configurable: false, writable: false })
    }
    const legacyClaims = Object.create(null)
    for (const owner of new Set(Object.values(normalizedMapping))) {
      const key = legacyOwnerClaimKey(owner)
      if (!legacyClaims[key]) Object.defineProperty(legacyClaims, key, { value: [], enumerable: true })
      legacyClaims[key].push(owner)
    }
    if (value.未映射会话写入待认领 !== undefined && typeof value.未映射会话写入待认领 !== 'boolean') throw new TypeError('未映射会话写入待认领必须是布尔值')
    return {
      会话白名单: array('会话白名单'),
      排除会话: array('排除会话'),
      会话归属: normalizedMapping,
      排除归属: array('排除归属'),
      未映射会话写入待认领: value.未映射会话写入待认领 ?? Object.keys(normalizedMapping).length > 0,
      旧版分库归属: legacyClaims,
    }
  }

  function readPluginConfig() {
    if (!existsSync(pluginConfigPath)) {
      if (configWasPresent && lastGoodConfig) return { config: lastGoodConfig, revision: configRevision, stale: true }
      if (configWasPresent) return { config: null, revision: configRevision, stale: true, failClosed: true }
      return { config: defaultPluginConfig, revision: 0, stale: false }
    }
    configWasPresent = true
    try {
      const next = normalizePluginConfig(JSON.parse(readFileSync(pluginConfigPath, 'utf8')))
      const serialized = JSON.stringify(next)
      if (!lastGoodConfig || JSON.stringify(lastGoodConfig) !== serialized) {
        lastGoodConfig = next
        configRevision += 1
      }
      return { config: lastGoodConfig, revision: configRevision, stale: false }
    } catch {
      diag('插件配置无效，保留上次有效配置或关闭会话访问')
      if (lastGoodConfig) return { config: lastGoodConfig, revision: configRevision, stale: true }
      return { config: null, revision: configRevision, stale: true, failClosed: true }
    }
  }

  // 通用分库：会话 ID 到库标识的映射只来自插件配置，不内置任何账号或人名。
  const 库缓存 = new Map([['main', store]])
  const 归属原值 = new Map()
  function 会话路由(sid) {
    const snapshot = readPluginConfig()
    if (!sid) return { read: 'main', write: 'main', skip: true, signature: `${snapshot.revision}|missing-session-id` }
    if (snapshot.failClosed || !snapshot.config) return { read: 'main', write: 'main', skip: true, signature: `${snapshot.revision}|config-invalid` }
    const local = snapshot.config
    if (local.排除会话.includes(sid)) return { read: 'main', write: 'main', skip: true, signature: `${snapshot.revision}|session-denied` }
    if (local.会话白名单.length > 0 && !local.会话白名单.includes(sid)) return { read: 'main', write: 'main', skip: true, signature: `${snapshot.revision}|not-allowed` }
    const mapped = Object.hasOwn(local.会话归属, sid) ? String(local.会话归属[sid]).trim() : ''
    const owner = mapped || (local.未映射会话写入待认领 ? 'pending' : 'main')
    if (local.排除归属.includes(owner)) return { read: 'main', write: 'main', skip: true, signature: `${snapshot.revision}|owner-denied` }
    const mappedKey = mapped ? ownerStorageKey(owner) : ''
    if (mappedKey) 归属原值.set(mappedKey, owner)
    const read = mapped ? mappedKey : 'main'
    const write = mapped ? mappedKey : (owner === 'pending' ? 'pending' : 'main')
    return { read, write, skip: false, signature: `${snapshot.revision}|${read}|${write}|0` }
  }
  function 取库(key) {
    const storageKey = key || 'main'
    if (storageKey === 'main') return store
    if (!/^(?:pending|owner-[\p{L}\p{N}-]+-[0-9a-f]{16})$/u.test(storageKey)) throw new TypeError('分库路径键无效')
    if (!库缓存.has(storageKey)) {
      const storagesRoot = resolve(dshHome, 'storages')
      const root = resolve(storagesRoot, 'dsh-memory-' + storageKey)
      if (!root.startsWith(storagesRoot + sep)) throw new TypeError('分库路径越界')
      const originalOwner = 归属原值.get(storageKey)
      if (originalOwner) {
        const legacyKey = legacyOwnerStorageKey(originalOwner)
        const legacyClaimKey = legacyOwnerClaimKey(originalOwner)
        const legacyRoot = resolve(storagesRoot, 'dsh-memory-' + legacyKey)
        if (!legacyRoot.startsWith(storagesRoot + sep)) throw new TypeError('旧版分库路径越界')
        if (legacyRoot !== root && existsSync(legacyRoot)) {
          throw new Error(`检测到无法验证归属的旧版分库（${legacyClaimKey}），必须人工迁移`)
        }
      }
      库缓存.set(storageKey, createStore({ rootDir: root }))
      diag('新建分库')
    }
    return 库缓存.get(storageKey)
  }
  const clock = () => new Date()
  const disposers = []
  const mounted = new Map()
  const keep = (disposer) => { if (typeof disposer === 'function') disposers.push(disposer); return disposer }

  // 2026-11-02：全量捕获。挂在事件流上，把每一条 user/assistant 原话攒进 pending，
  // turn-stopping 时整批落进情景库——不再只抓最后两条。runtime context 注入块不算「你说」。
  const pending = new Map() // sid -> [{ signature, store, entries }]，捕获时即绑定写入库
  const compactNotes = new Map() // sid -> { tokens, from, to, at, told }（上下文被压的记录）
  const activeSidCounts = new Map()
  const activateSid = (sid) => activeSidCounts.set(sid, (activeSidCounts.get(sid) ?? 0) + 1)
  const deactivateSid = (sid) => {
    const next = (activeSidCounts.get(sid) ?? 0) - 1
    if (next > 0) activeSidCounts.set(sid, next)
    else activeSidCounts.delete(sid)
  }
  try {
    const eventOff = ctx.on('session/event', (session, event) => {
      try {
        const sid = sessionIdOf(session)
        if (!sid || !activeSidCounts.has(sid)) return
        const route = 会话路由(sid)
        if (route.skip) return
        // 2026-11-02：上下文被压掉时记一笔——「你丢过东西」提醒的数据源。
        if (event?.type && /^compaction\//.test(String(event.type))) {
          const d = event.data || {}
          const prev = compactNotes.get(sid)
          compactNotes.set(sid, {
            tokens: (prev ? prev.tokens || 0 : 0) + (Number(d.shadowedTokenCount) || 0),
            from: d.shadowedRange?.start ?? undefined,
            to: d.shadowedRange?.end ?? undefined,
            at: Date.now(),
            told: false,
          })
          diag(`上下文压缩：${event.type}，${d.shadowedTokenCount || '?'} token`)
          return
        }
        if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return
        const text = textOfEvent(event)
        if (!text) return
        if (event.type === 'user/message' && text.startsWith('Current runtime context')) return
        const batches = pending.get(sid) || []
        const count = batches.reduce((total, batch) => total + batch.entries.length, 0)
        if (count >= 200) return
        let batch = batches[batches.length - 1]
        if (!batch || batch.signature !== route.signature) {
          batch = { signature: route.signature, store: 取库(route.write), entries: [] }
          batches.push(batch)
        }
        batch.entries.push({ who: event.type === 'user/message' ? '你' : '我', text })
        pending.set(sid, batches)
      } catch { diag('事件捕获失败') }
    })
    keep(eventOff)
  } catch { diag('挂不上 session/event 捕获') }

  if (globalToolsEnabled) {
    const globalToolOffs = []
    try {
      const tools = ctx?.tools
      if (typeof tools?.register !== 'function') throw new Error('全局工具注册器不可用')
      for (const tool of [
        makeWriteTool(store, clock, defineTool, runtime),
        makeTraceTool(store, clock, defineTool),
        makeRecallTool(store, clock, defineTool, runtime),
        makeConsolidateTool(store, clock, defineTool, runtime),
      ]) {
        const off = tools.register(tool)
        if (typeof off === 'function') globalToolOffs.push(off)
      }
      for (const off of globalToolOffs) keep(off)
      diag('全局主库工具注册 OK')
    } catch {
      for (const off of globalToolOffs.reverse()) { try { off() } catch {} }
      diag('全局主库工具注册失败，已回滚')
    }
  }

  function sessionIdOf(session) {
    for (const key of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
      const value = session?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  function flushPendingFor(sid) {
    if (!sid) return 0
    const batches = pending.get(sid) || []
    let count = 0
    while (batches.length > 0) {
      const batch = batches[0]
      if (!batch?.store || !Array.isArray(batch.entries) || batch.entries.length === 0) {
        batches.shift()
        continue
      }
      try {
        batch.store.appendSceneBlock(batch.entries, clock(), diag)
      } catch (error) {
        pending.set(sid, batches)
        throw error
      }
      count += batch.entries.length
      batches.shift()
    }
    pending.delete(sid)
    return count
  }

  function mount(agent) {
    const sid = sessionIdOf(agent?.session)
    const route = 会话路由(sid)
    if (route.skip) {
      diag('跳过：会话访问被关闭')
      return () => {}
    }
    const local = []
    let activated = false
    const cleanup = () => {
      if (activated) {
        deactivateSid(sid)
        activated = false
      }
      for (const off of local.splice(0).reverse()) { try { if (typeof off === 'function') off() } catch {} }
    }
    try {
      const 读库 = 取库(route.read)
      const 写库 = 取库(route.write)
      if (route.read !== 'main' || route.write !== 'main') diag('挂载会话分库')
      let lastText = ''
      let userShapeLogged = false
      // 工具、hooks 与提示注入属于同一次挂载：任一步失败都完整回滚。
      const tools = agent?.ctx?.tools
      if (typeof tools?.register !== 'function') throw new Error('会话工具注册器不可用')
      const off1 = tools.register(makeWriteTool(写库, clock, defineTool, runtime))
      if (typeof off1 === 'function') local.push(off1)
      const off2 = tools.register(makeRecallTool(读库, clock, defineTool, runtime))
      if (typeof off2 === 'function') local.push(off2)
      const off3 = tools.register(makeConsolidateTool(写库, clock, defineTool, runtime))
      if (typeof off3 === 'function') local.push(off3)
      const off4 = tools.register(makeTraceTool(读库, clock, defineTool))
      if (typeof off4 === 'function') local.push(off4)
      diag('会话专属工具已绑')

      const inboxOff = agent.ctx.on('agent/inbox/inserted', (payload) => {
      const message = payload?.message ?? payload
      // 2026-10-31：inbox 里不只有 ta 说的话，DSH 每轮注入的上下文块也走这条路。
      // source 是对象（不是字符串）；只读取 kind，不把来源对象写入诊断日志。
      const rawSource = message?.source ?? payload?.source
      const sourceKind = rawSource && typeof rawSource === 'object' ? String(rawSource.kind ?? '') : ''
      diag('inbox 收到')
      if (sourceKind && sourceKind !== 'user') {
        diag('inbox 跳过：非用户来源')
        return
      }
      const text = textOfMessage(message)
      if (text) lastText = text
      })
      if (typeof inboxOff === 'function') local.push(inboxOff)
      const stoppingOff = agent.ctx.on('agent/turn-stopping', () => {
      try {
        diag('turn-stopping 存档开始')
        const sid = sessionIdOf(agent.session)
        const batches = pending.get(sid) || []
        // 2026-11-02：优先用事件流攒到的全量原话；没抓到才退回旧逻辑（最后两条）。
        if (batches.length > 0) {
          const count = flushPendingFor(sid)
          lastText = ''
          diag('turn-stopping 全量存档完成: ' + count + ' 条')
          return
        }
        let events = []
        try { events = agent.session.snapshotEvents() ?? [] }
        catch { diag('turn-stopping 快照读取失败') }
        let userText = lastText
        let assistantText = ''
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index]
          if (!userText && event?.type === 'user/message') userText = textOfEvent(event)
          if (!assistantText && event?.type === 'assistant/message') assistantText = textOfEvent(event)
          if (userText && assistantText) break
        }
        if (!userText && !userShapeLogged) {
          const lastEvent = events[events.length - 1]
          diag('turn-stopping 用户结构诊断: type=' + String(lastEvent?.type ?? '（无事件）') + ' | data keys=' + Object.keys(lastEvent?.data ?? {}).join(','))
          userShapeLogged = true
        }
        const missing = [!userText && 'user', !assistantText && 'assistant'].filter(Boolean)
        if (missing.length) diag('turn-stopping 缺少 ' + missing.join('、') + '，以（未抓到）存档')
        diag('turn-stopping 消息提取完成')
        写库.appendTurn(userText || '（未抓到）', assistantText || '（未抓到）', clock(), diag)
        lastText = ''
        diag('turn-stopping 存档完成')
      } catch { diag('turn-stopping 存档失败') }
      })
      if (typeof stoppingOff === 'function') local.push(stoppingOff)
      diag('turn-stopping 钩子注册 OK')
    // 2026-11-02：身份锚——开会话时从画像库算一次，整场冻结（前缀缓存友好）。
    // 画像中途更新不影响本场；下一场开会话自动重算。
      let anchorText = ''
      try {
        const profile = renderProfile(读库.readCollection('画像'))
        if (profile) anchorText = '【我是谁 · 本场冻结】\n' + profile
      } catch { diag('身份锚算不出来') }
      if (anchorText) {
        local.push(agent.ctx.systemPrompt.section({
        name: 'memory-v2-anchor', order: 190,
        text: anchorText,
        }))
        diag('身份锚已挂: ' + Array.from(anchorText).length + ' 字')
      }
    // 2026-11-02：去重+冷却——本会话浮过的原文段在冷却期内不再端。
      const shown = new Map() // 'day hhmm' -> 浮出时间戳
      local.push(agent.ctx.systemPrompt.context({
      name: 'memory-v2-recall', order: 900,
      text: () => {
        const query = lastText || lastUserTextOf(agent.session)
        const 过去时提醒 = hasPastCue(query)
          ? '〔这句话涉及过去：回答前先调 memory_recall；查不到就直说没有可靠记录。〕'
          : ''
        let 记忆注入 = ''
        if (query && shouldAutoRecall(query)) {
          const hitRecords = recall(query, { store: 读库, now: clock() })
          const recalled = renderRecall(hitRecords)
          // 命中摘要之外，最多带一段两百字原文，去重并设冷却。
          const sceneHints = renderSceneHints(hitRecords, 读库, { shown, cooldownMs: 30 * 60 * 1000, now: Date.now() })
          记忆注入 = [recalled, sceneHints].filter(Boolean).join('\n')
          // 2026-11-02：情绪线索——他说了累/困/烦这类词，额外按情绪召回上次原因。
          const emotion = detectEmotion(query)
          if (emotion) {
            try {
              const emoRecords = recall(`${emotion.kind} 上次原因 ${query}`, { store: 读库, now: clock() }).slice(0, 1)
              const emoText = renderRecall(emoRecords)
              if (emoText) 记忆注入 += `\n〔情绪线索 · 他说了「${emotion.word}」〕\n${emoText}`
            } catch { /* 情绪召回失败不影响主注入 */ }
          }
        }
        // 2026-11-02：上下文被压掉后，提醒「你丢过东西」——原文情景库里还留着，别拿像的凑。
        const compactNote = compactNotes.get(sid)
        if (compactNote && !compactNote.told && Date.now() - compactNote.at <= 20 * 60 * 1000) {
          compactNote.told = true
          const size = compactNote.tokens ? `约 ${Math.round(compactNote.tokens / 1000)}k token` : '一段'
          const span = compactNote.from !== undefined && compactNote.to !== undefined ? `（第 ${compactNote.from}–${compactNote.to} 条）` : ''
          const 压缩提醒 = `【刚压掉了 ${size}${span}】那些内容我这儿还留着（情景库）。想得起来就想想，想不起来用 memory_trace / memory_recall 翻——不记得就直说记不清，别拿像的东西凑。`
          diag('压缩提醒注入: ' + size)
          return [压缩提醒, 记忆注入, 过去时提醒].filter(Boolean).join('\n')
        }
        try {
          const state = 写库.readConsolidationState(clock())
          // 累计五轮再提醒，避免每轮都先做巩固而挤占当前任务。
          if (state.轮数 >= 5) {
            const pressure = state.轮数 >= 10 ? '（积压了）' : ''
            diag(`context 巩固提醒注入: ${state.轮数} 轮`)
            return [记忆注入, 过去时提醒, `[记忆] ${state.轮数} 轮还没巩固${pressure}。先调 memory_consolidate。`].filter(Boolean).join('\n')
          }
          diag(`context 巩固提醒跳过: ${state.轮数} 轮（未到 5）`)
        } catch { diag('context 巩固提醒失败') }
        return [记忆注入, 过去时提醒].filter(Boolean).join('\n')
      },
      }))
      activateSid(sid)
      activated = true
      return cleanup
    } catch {
      cleanup()
      diag('会话记忆挂载失败，已完整回滚并关闭访问')
      return () => {}
    }
  }

  // 会话路由变化时卸载并重挂，避免继续读写旧分库。
  const 挂的路由 = new Map()
  function tick() {
    try {
      const agents = ctx.agents.list() ?? []
      const alive = new Set(agents)
      for (const agent of agents) {
        const route = 会话路由(sessionIdOf(agent?.session))
        const signature = route.signature
        const remembered = 挂的路由.get(agent)
        if (mounted.has(agent) && remembered !== undefined && remembered !== signature) {
          diag('会话路由变更，重挂')
          const sid = sessionIdOf(agent?.session)
          if (activeSidCounts.has(sid)) {
            try { flushPendingFor(sid) } catch { diag('会话路由变更前待存档内容写入失败') }
          }
          const off = mounted.get(agent)
          if (typeof off === 'function') off()
          mounted.delete(agent)
          挂的路由.delete(agent)
        }
        if (!mounted.has(agent)) {
          mounted.set(agent, mount(agent))
          挂的路由.set(agent, signature)
        }
      }
      for (const [agent, off] of mounted) {
        if (alive.has(agent)) continue
        const sid = sessionIdOf(agent?.session)
        if (activeSidCounts.has(sid)) {
          try { flushPendingFor(sid) } catch { diag('会话结束时待存档内容写入失败') }
        }
        compactNotes.delete(sid)
        off()
        mounted.delete(agent)
        挂的路由.delete(agent)
      }
      for (const sid of [...pending.keys()]) {
        if (activeSidCounts.has(sid)) continue
        try { flushPendingFor(sid) } catch { diag('孤立待存档内容重试失败') }
      }
    } catch { diag('tick 失败') }
  }

  diag('准备注册 stats 路由')
  keep(ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/memory-v2/stats',
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, message: '只允许 GET' }))
        return
      }
      const snapshot = store.readAll()
      const counts = Object.fromEntries(COLLECTIONS.map((collection) => [collection, snapshot[collection].length]))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        条数: Object.values(counts).reduce((total, count) => total + count, 0),
        各类数量: counts,
        候选数: store.readCandidates().length,
      }))
    },
  })))
  diag('stats 路由注册调用完毕')

  if (sensitiveRouteEnabled) {
    keep(ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/memory-v2/candidates',
      handler: async (req, res) => {
        if (req.method && req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, message: '只允许 GET' }))
          return
        }
        const candidates = store.readCandidates()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ 条数: candidates.length, 候选: candidates }))
      },
    })))
  }

  tick()
  if (typeof ctx.interval === 'function') keep(ctx.interval(tick, 500))

  return () => {
    for (const agent of mounted.keys()) {
      const sid = sessionIdOf(agent?.session)
      if (activeSidCounts.has(sid)) {
        try { flushPendingFor(sid) } catch { diag('卸载时待存档内容写入失败') }
      }
      compactNotes.delete(sid)
    }
    for (const off of mounted.values()) { try { off() } catch {} }
    mounted.clear()
    for (const sid of [...pending.keys()]) {
      try { flushPendingFor(sid) } catch { diag('卸载时孤立待存档内容最终重试失败') }
    }
    for (const off of disposers.reverse()) { try { off() } catch {} }
    pending.clear()
    compactNotes.clear()
    activeSidCounts.clear()
  }
}

export { createStore } from './store.js'
export { recall, vectorRecall } from './recall.js'
export { light, heavy } from './consolidate.js'
export { renderSceneHints, detectEmotion }
