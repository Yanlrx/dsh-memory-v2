// 2026-10-31：仅存可见文本，优先 inbox 原话，缺栏仍存档并限次诊断；四组合测试随本轮七项回归运行。
import { randomUUID, timingSafeEqual } from 'node:crypto'
// 2026-10-31：移除输入和输出 schema 的 required，保留 execute 校验及 diag；四组合测试随六项回归运行。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.js'
import { recall } from './recall.js'
import { planUpdate, applyUpdate } from './update.js'
import { loadHostDeps } from './hostdeps.mjs'

export const name = 'memory-v2'
export const inject = ['systemPrompt', 'agents', 'timer', 'tools', 'webServer']

const COLLECTIONS = ['语义', '结论', '画像', '临时']

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
  // 2026-10-31：分两栏。
  //   偏好 → 「他是什么样的人」（原话优先，判断跟在后面）
  //   策略 → 「我该怎么应对他」（只放做法，不放推断）
  // 分开是因为混在一起会让画像变成大杂烩，读的时候分不清哪句是事实、哪句是我该怎么改。
  const preferenceLines = []
  const strategyLines = []
  for (const record of records) {
    const kinds = Array.isArray(record.kind) ? record.kind : []
    if (kinds.includes('策略')) {
      if (record.text) strategyLines.push(`- ${record.text}`)
      continue
    }
    const original = String(record.原话 ?? record.text ?? '').replace(/^[「『“"]|[」』”"]$/g, '')
    if (!original) continue
    preferenceLines.push(`[你说的] ${original}`)
    if (record.我的推断) {
      preferenceLines.push(`[我读出来的] ${record.我的推断} ← 原话「${original}」｜语境 ${record.来源}`)
    }
    if (preferenceLines.join('\n').length >= 360) break
  }
  const parts = []
  if (preferenceLines.length) parts.push(preferenceLines.join('\n').slice(0, 360))
  if (strategyLines.length) parts.push('[我该怎么应对]\n' + strategyLines.slice(0, 8).join('\n'))
  return parts.join('\n')
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
// 按它回情景库找那个时间的段，截 300 字、最多 3 段、同一段不重复。找不到就少给，不硬凑。
// 2026-11-02 克制：shown 是「本会话浮出时间表」（day+hhmm → 时间戳），冷却期内不再端。
function renderSceneHints(records, store, { maxSegments = 3, maxChars = 300, shown, cooldownMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  if (!Array.isArray(records) || records.length === 0 || typeof store?.sceneSegment !== 'function') return ''
  const seen = new Set()
  const parts = []
  for (const record of records) {
    if (parts.length >= maxSegments) break
    const match = String(record?.来源 ?? '').match(/(\d{4}-\d{2}-\d{2})[^\d]*?(\d{1,2}:\d{2})/)
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

function makeWriteTool(store, clock, defineTool) {
  return defineTool({
    name: 'memory_write',
    description: '写入一条经明确确认的记忆，一条只写一件事。',
    parameters: {
      text: { type: 'string', description: '记忆正文，1~100 字。' },
      collection: { type: 'string', description: '语义/结论/画像/临时，默认语义。' },
      kinds: { type: 'array', items: { type: 'string' }, description: '事件/状态/偏好等类型。' },
      entities: { type: 'array', items: { type: 'string' }, description: '最多 5 个实体。' },
      source: { type: 'string', description: '来源时间或会话位置。' },
      doorplate: { type: 'string', description: '可回找的会话门牌。' },
      ttl: { type: 'string', description: '状态的有效期，如 7d。' },
      conflict: { type: 'array', items: { type: 'string' }, description: '与本条冲突的记忆 id。' },
      supersede: { type: 'string', description: '可选。要更新的旧记录 id——填了就是改那条，不是新写一条。' },
      opposite: { type: 'boolean', description: '配合 supersede：这条新证据是不是反证。' },
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
    }),
    async execute(args = {}) {
      const text = String(args.text ?? '').trim()
      if (text.length < 1 || text.length > 100) return { ok: false, message: 'text 必须为 1~100 字' }
      let collection = COLLECTIONS.includes(args.collection) ? args.collection : '语义'
      const kinds = Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds.map(String) : ['事件']
      // 2026-10-31：策略写不进去，先看运行时到底收到了什么（只在 kinds 里有策略时打，别刷屏）
      if (kinds.includes('策略')) diag('memory_write 策略入参: kinds=' + JSON.stringify(args.kinds) + ' ttl=' + JSON.stringify(args.ttl) + ' collection=' + collection)
      if (kinds.includes('状态') && !args.ttl) return { ok: false, message: '状态记忆必须有 ttl' }
      const timestamp = new Date(clock()).toISOString()

      // 2026-10-31：接上更新机制。
      // 传了 supersede 就是「改旧的那条」，不传就是「新写一条」——不做自动猜测，
      // 因为猜错了会把两条不相干的事合成一条，比不更新更糟。
      if (args.supersede) {
        const targetId = String(args.supersede)
        let target = null
        for (const name of COLLECTIONS) {
          const found = store.readCollection(name).find((item) => String(item.id) === targetId)
          if (found) {
            if (args.collection && args.collection !== name) return { ok: false, message: 'collection 与旧记录所在集合不符' }
            target = found; collection = name; break
          }
        }
        if (!target) return { ok: false, message: `找不到要更新的记录：${targetId}` }

        const plan = planUpdate(target, {
          now: clock(),
          evidence: { text, 相反: Boolean(args.opposite), 来源: args.source ?? timestamp },
        })
        const next = applyUpdate(target, plan, clock())
        // 更新只动「怎么记这条」，不动它的正文——正文要在改写的语义下才变，
        // 而正文变化属于结论层版本链的事，不在这里顺手改。
        const revisedText = plan.action === 'revise' ? text : target.text
        store.replaceRecord(collection, { ...next, text: revisedText, 原话: plan.action === 'revise' ? text : target.原话 })
        // 更新也留一条候选痕，跟新写保持一样的审计口径
        let updateCandidate = ''
        try {
          const candidate = {
            id: randomUUID(),
            类型: '更新',
            text: revisedText,
            来源: String(args.source ?? timestamp),
            置信度: next.置信度 ?? target.置信度,
            created_at: new Date(clock()).toISOString(),
            状态: '已转正',
            落库id: target.id,
            落库类别: collection,
            动作: plan.action,
            原因: plan.reason,
          }
          store.appendCandidate(candidate)
          updateCandidate = candidate.id
        } catch (error) { diag('候选留痕失败: ' + error?.message) }
        return { ok: true, id: target.id, collection, action: plan.action, reason: plan.reason, candidateId: updateCandidate }
      }

      const record = {
        id: randomUUID(), text, kind: kinds, 主体: '本人', 说话人: '本人', 原话: text, 我的推断: '',
        来源: String(args.source ?? timestamp), 门牌: String(args.doorplate ?? `memory_write + ${timestamp}`),
        event_time: kinds.includes('事件') ? timestamp : null,
        // 2026-10-31：策略跟偏好一样需要 last_confirmed（持续有效、没有到期日）。
        // 这里漏过一次，结果策略写不进去、报「策略必须有 last_confirmed」。
        last_confirmed: kinds.includes('状态') || kinds.includes('偏好') || kinds.includes('策略') ? timestamp : null,
        ttl: kinds.includes('状态') ? String(args.ttl) : null,
        置信度: 1, 证据: [], 出现次数: 1, 被召回次数: 0,
        实体: [...new Set((args.entities ?? []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 5),
        冲突: Array.isArray(args.conflict) && args.conflict.length > 0 ? args.conflict.map(String) : null,
        版本: 1, 状态: '生效',
      }
      store.appendRecord(collection, record)
      // 2026-10-31：接上候选队列。写库的同时往候选里留一条（标「已转正」），
      // 这样候选就等于一份可查的审计日志——我抽了什么、什么时候抽的、来源是哪句，
      // 事后你能翻。不搞「先挂候选等你点头」，那样每记一条都要打断你一次。
      let candidateId = ''
      try {
        const candidate = {
          id: randomUUID(),
          类型: '事实',
          text: record.text,
          来源: record.来源,
          置信度: record.置信度,
          created_at: new Date(clock()).toISOString(),
          状态: '已转正',
          落库id: record.id,
          落库类别: collection,
          实体: record.实体,
        }
        store.appendCandidate(candidate)
        candidateId = candidate.id
      } catch (error) { diag('候选留痕失败: ' + error?.message) }
      return { ok: true, id: record.id, collection, candidateId }
    },
  })
}

function makeRecallTool(store, clock, defineTool) {
  return defineTool({
    name: 'memory_recall',
    description: '按当前问题查找最相关的记忆，默认最多 4 条，并强制带上冲突反证。',
    parameters: {
      query: { type: 'string', description: '要查的问题或关键词。' },
      complex: { type: 'boolean', description: '复杂问题可扩到 8 条。' },
    },
    output: outputSchema({
      records: { type: 'array', items: { type: 'object', additionalProperties: true } },
      // 2026-10-31：多返回一个「这轮记了几条被召回次数」，必须在这里声明——
      // output schema 是 additionalProperties:false，不声明就是非法输出。
      bumped: { type: 'integer' },
    }),
    async execute(args = {}) {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, message: 'query 不许为空' }
      const records = recall(query, { store, complex: Boolean(args.complex), now: clock() })
      // 召回一次记一次：被召回次数是权重唯一的输入，不记它，权重永远是 0。
      // 只在我主动调工具时记；每轮自动注入那条路不写盘（一晚上要写一百多次，太吵）。
      let bumped = 0
      try { bumped = store.bumpRecall(records.map((item) => item.id)) } catch (error) { diag('bumpRecall 失败: ' + error?.message) }
      return { ok: true, records, bumped }
    },
  })
}

const { defineTool } = await loadHostDeps()

// 2026-10-31：钩子只存档和计数，原文由调用者自行巩固；三函数未改，七项回归验证。
function makeConsolidateTool(store, clock, defineTool) {
  return defineTool({
    name: 'memory_consolidate',
    description: '从最早未读情景继续返回原文，最多 8000 字。自行阅读抽取事实；仅推进已返回部分，长段下次继续，rounds 是完整返回的轮数。',
    parameters: { rounds: { type: 'integer', description: '最多读取多少轮，默认全部积压；跨日保留，单轮超过 8000 字会分次返回。' } },
    output: outputSchema({ date: { type: 'string' }, rounds: { type: 'integer' }, text: { type: 'string' } }),
    async execute(args = {}) {
      diag('memory_consolidate 调用')
      try {
        const result = store.consolidateScenes(args.rounds, clock(), diag)
        diag('memory_consolidate 完成')
        return result
      } catch (error) {
        diag('memory_consolidate 失败: ' + error?.message)
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })
}

const DIAG_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory-v2-diag.log').replace(/\\/g, '/')
function diag(msg) {
  try { appendFileSync(DIAG_PATH, new Date().toISOString() + '  ' + msg + '\n') } catch (e) { /* 诊断不许把插件搞挂 */ }
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

export function apply(ctx) {
  diag('apply 开始 | ctx 字段: ' + Object.keys(ctx || {}).join(','))
  diag('开始 createStore')
  const store = createStore()
  diag('store 建好')

  // 通用版：所有会话共用一套记忆（单库），不按人分库。
  const clock = () => new Date()
  const disposers = []
  const mounted = new Map()
  const keep = (disposer) => { if (typeof disposer === 'function') disposers.push(disposer); return disposer }

  // 2026-11-02：全量捕获。挂在事件流上，把每一条 user/assistant 原话攒进 pending，
  // turn-stopping 时整批落进情景库——不再只抓最后两条。runtime context 注入块不算「你说」。
  const pending = new Map() // sid -> [{ who, text }]，每条会话最多 200 条防爆
  const compactNotes = new Map() // sid -> { tokens, from, to, at, told }（上下文被压的记录）
  try {
    keep(ctx.on('session/event', (session, event) => {
      try {
        const sid = sessionIdOf(session)
        if (!allowed(sid)) { pending.delete(sid); compactNotes.delete(sid); return }
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
          diag(`压缩 ${String(sid).slice(0, 16)}：${event.type} 掉 ${d.shadowedTokenCount || '?'} token`)
          return
        }
        if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return
        const text = textOfEvent(event)
        if (!text) return
        if (event.type === 'user/message' && text.startsWith('Current runtime context')) return
        const list = pending.get(sid) || []
        if (list.length >= 200) return
        list.push({ who: event.type === 'user/message' ? '你' : '我', text })
        pending.set(sid, list)
      } catch (e) { diag('事件捕获失败: ' + (e && e.message)) }
    }))
  } catch (e) { diag('挂不上 session/event 捕获: ' + (e && e.message)) }

  // 仅在获准会话的局部 context 注册，避免全局工具绕过排除名单。

  // 单人共享库：默认停用，明确列入白名单或显式全开后才挂载；排除永远优先。
  function readScope() {
    try {
      const path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-memory-v2-config.json')
      if (!existsSync(path)) return { allow: [], deny: [], all: false }
      const config = JSON.parse(readFileSync(path, 'utf8'))
      const pick = (key) => (Array.isArray(config?.[key]) ? config[key].map(String).filter(Boolean) : [])
      return { allow: pick('会话白名单'), deny: pick('排除会话'), all: config.启用全部会话 === true, token: config.候选接口令牌 }
    } catch (error) { diag('读会话名单失败: ' + error?.message); return { allow: [], deny: [], all: false } }
  }

  function allowed(sid) {
    const scope = readScope()
    return Boolean(sid) && !scope.deny.includes(sid) && (scope.allow.length ? scope.allow.includes(sid) : scope.all)
  }

  function sessionIdOf(session) {
    for (const key of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
      const value = session?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  function mount(agent) {
    const sid = sessionIdOf(agent?.session)
    if (!allowed(sid)) return () => {}
    const scope = readScope()
    if (scope.deny.includes(sid)) {
      diag('跳过：在排除名单里 ' + (sid || '（拿不到 id）'))
      return () => {}
    }
    if (scope.allow.length > 0 && !scope.allow.includes(sid)) {
      diag('跳过：不在白名单里 ' + (sid || '（拿不到 id）'))
      return () => {}
    }
    let lastText = ''
    let userShapeLogged = false
    const local = []
    // 2026-10-31：这一间的三个记忆工具绑自己那本库
    try {
      const tools = agent?.ctx?.tools
      if (typeof tools?.register === 'function') {
        const scopedTool = (tool) => ({ ...tool, execute: (...args) => allowed(sid) ? tool.execute(...args) : { ok: false, message: '本会话未启用记忆' } })
        const off1 = tools.register(scopedTool(makeWriteTool(store, clock, defineTool)))
        if (typeof off1 === 'function') local.push(off1)
        const off2 = tools.register(scopedTool(makeRecallTool(store, clock, defineTool)))
        if (typeof off2 === 'function') local.push(off2)
        const off3 = tools.register(scopedTool(makeConsolidateTool(store, clock, defineTool)))
        if (typeof off3 === 'function') local.push(off3)
        const off4 = tools.register(scopedTool(makeTraceTool(store, clock, defineTool)))
        if (typeof off4 === 'function') local.push(off4)
      }
    } catch (error) { diag('会话专属工具注册失败: ' + (error?.message || error)) }
    const inboxOff = agent.ctx.on('agent/inbox/inserted', (payload) => {
      if (!allowed(sid)) return
      const message = payload?.message ?? payload
      // 2026-10-31：inbox 里不只有 ta 说的话，DSH 每轮注入的上下文块也走这条路。
      // source 是对象（不是字符串），所以先序列化；真实结构靠日志确认，不猜。
      const rawSource = message?.source ?? payload?.source
      const role = String(message?.role ?? payload?.role ?? '')
      // 真机确认过的结构：source = {"kind":"user","rpcId":"...","clientTimeZone":"Asia/Shanghai"}
      // 所以判据就是 kind：有 kind 且不是 user 的，不是 ta 说的话，跳过。
      const sourceKind = rawSource && typeof rawSource === 'object' ? String(rawSource.kind ?? '') : ''
      diag('inbox 收到: kind=' + (sourceKind || '无') + ' | role=' + (role || '无'))
      if (sourceKind && sourceKind !== 'user') {
        diag('inbox 跳过：kind=' + sourceKind + ' 不是 user')
        return
      }
      const text = textOfMessage(message)
      if (text) lastText = text
    })
    if (typeof inboxOff === 'function') local.push(inboxOff)
    const stoppingOff = agent.ctx.on('agent/turn-stopping', () => {
      if (!allowed(sid)) { pending.delete(sid); return }
      try {
        diag('turn-stopping 存档开始')
        const sid = sessionIdOf(agent.session)
        const list = pending.get(sid) || []
        pending.set(sid, [])
        // 2026-11-02：优先用事件流攒到的全量原话；没抓到才退回旧逻辑（最后两条）。
        if (list.length > 0) {
          store.appendSceneBlock(list, clock(), diag)
          diag('turn-stopping 全量存档完成: ' + list.length + ' 条')
          return
        }
        let events = []
        try { events = agent.session.snapshotEvents() ?? [] }
        catch (error) { diag('turn-stopping 快照读取失败: ' + error?.message) }
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
        store.appendTurn(userText || '（未抓到）', assistantText || '（未抓到）', clock(), diag)
        diag('turn-stopping 存档完成')
      } catch (error) { diag('turn-stopping 存档失败: ' + error?.message) }
    })
    if (typeof stoppingOff === 'function') local.push(stoppingOff)
    diag('turn-stopping 钩子注册 OK')
    // 2026-11-02：身份锚——开会话时从画像库算一次，整场冻结（前缀缓存友好）。
    // 画像中途更新不影响本场；下一场开会话自动重算。
    let anchorText = ''
    try {
      const profile = renderProfile(store.readCollection('画像'))
      if (profile) anchorText = '【我是谁 · 本场冻结】\n' + profile
    } catch (e) { diag('身份锚算不出来: ' + (e && e.message)) }
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
        if (!allowed(sid)) return ''
        const query = lastText || lastUserTextOf(agent.session)
        let 记忆注入 = ''
        if (query) {
          const hitRecords = recall(query, { store, now: clock() })
          const recalled = renderRecall(hitRecords)
          // 2026-11-02：命中摘要之外，把对应时间的原文段一起带出来（三段×三百字），去重+冷却。
          const sceneHints = renderSceneHints(hitRecords, store, { shown, cooldownMs: 30 * 60 * 1000, now: Date.now() })
          记忆注入 = [recalled, sceneHints].filter(Boolean).join('\n')
          // 2026-11-02：情绪线索——他说了累/困/烦这类词，额外按情绪召回上次原因。
          const emotion = detectEmotion(query)
          if (emotion) {
            try {
              const emoRecords = recall(`${emotion.kind} 上次原因 ${query}`, { store, now: clock() }).slice(0, 2)
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
          diag('压缩提醒注入: ' + String(sid).slice(0, 16) + ' ' + size)
          return [压缩提醒, 记忆注入].filter(Boolean).join('\n')
        }
        try {
          const state = store.readConsolidationState(clock())
          // 2026-10-31：原来的门限是 >=10 才提，等于前 9 轮都能装作没看见。
          // 改成「有没巩固的就每轮都提」——让它每次回话都挂在眼前，躲不过去。
          if (state.轮数 > 0) {
            const pressure = state.轮数 >= 10 ? '（积压了）' : ''
            diag(`context 巩固提醒注入: ${state.轮数} 轮`)
            return [记忆注入, `[记忆] ${state.轮数} 轮还没巩固${pressure}。先调 memory_consolidate。`].filter(Boolean).join('\n')
          }
          diag('context 巩固提醒跳过: 0 轮')
        } catch (error) { diag('context 巩固提醒失败: ' + error?.message) }
        return 记忆注入
      },
    }))
    return () => { pending.delete(sid); compactNotes.delete(sid); for (const off of local) if (typeof off === 'function') off() }
  }

  // 通用版：单库，tick 只管「会话出现就挂、会话没了就卸」，不再按人重挂。
  function tick() {
    try {
      const agents = ctx.agents.list() ?? []
      const alive = new Set(agents)
      for (const agent of agents) {
        const sid = sessionIdOf(agent?.session)
        if (!allowed(sid)) {
          mounted.get(agent)?.(); mounted.delete(agent); pending.delete(sid); compactNotes.delete(sid)
          continue
        }
        if (!mounted.has(agent)) {
          mounted.set(agent, mount(agent))
        }
      }
      for (const [agent, off] of mounted) {
        if (alive.has(agent)) continue
        off()
        mounted.delete(agent)
      }
    } catch (e) { diag('tick 失败: ' + (e && e.message)) }
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

  // 2026-10-31：候选队列现在同时也是一份审计日志（每次写入/更新都留一条痕）。
  // 开这个口子方便随时翻「我到底抽了什么、什么时候抽的、来源是哪句」。
  keep(ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/memory-v2/candidates',
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, message: '只允许 GET' }))
        return
      }
      const token = readScope().token
      const provided = String(req.headers?.authorization ?? '')
      const expected = typeof token === 'string' && token.length >= 32 ? `Bearer ${token}` : ''
      if (!expected || Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, message: '候选接口未授权' }))
        return
      }
      const candidates = store.readCandidates()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ 条数: candidates.length, 候选: candidates }))
    },
  })))

  tick()
  if (typeof ctx.interval === 'function') keep(ctx.interval(tick, 500))

  return () => {
    for (const off of mounted.values()) off()
    mounted.clear()
    pending.clear()
    compactNotes.clear()
    for (const off of disposers.reverse()) off()
  }
}

export { createStore } from './store.js'
export { recall, vectorRecall } from './recall.js'
export { light, heavy } from './consolidate.js'
export { renderSceneHints, detectEmotion }
