// update.js —— 记忆的「更新」机制。它不删东西，只决定一条记忆该被怎么改写、强化、还是降级。
//
// 为什么单独一个文件：权重（weight.js）只回答「该不该优先想起来」，
// 更新回答的是「这条该不该改、改成什么」——两件事，混在一起就又会变成一个计时器算三样。
//
// 依据（人类怎么更新对别人的印象）：
//   ① 再巩固：记忆被提取后会进入可修改状态，需要重新巩固才能存回去。
//      所以「想起一次」不是读取，是改写的机会。
//   ② 预测误差：不是每次想起都改，是**新信息跟预期对不上**才会 destabilize。
//      所以只有出现反证或冲突才动内容。
//   ③ 不对称：从坏改好比从好改坏难得多（revision bias）。
//      所以负面结论要翻，需要更多证据。
//   ④ 干扰：新的同类信息会压住旧的，遗忘主要是干扰不是时间。
//      所以同一实体的条目太多时，老的降级（排后面），但一条都不删。
//
// 这个文件不 import 别的模块，输入输出都是纯数据，方便单独测。

export const ACTIONS = {
  NOOP: 'noop',
  TOUCH: 'touch',
  REINFORCE: 'reinforce',
  REVISE: 'revise',
  DEMOTE: 'demote',
}

const MAX_SIBLINGS_PER_ENTITY = 5
const NEGATIVE_FLIP_THRESHOLD = 3
const POSITIVE_FLIP_THRESHOLD = 1

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function entitiesOf(record) {
  return Array.isArray(record?.实体) ? record.实体 : []
}

// 这条记录对「某件事」是正面还是负面。没有明确标记时按中性算。
function polarityOf(record) {
  const raw = String(record?.倾向 ?? '').trim()
  if (raw === '正面' || raw === '负面') return raw
  return '中性'
}

/**
 * 判断这条记忆该怎么更新。
 *
 * @param {object} record   现有记忆
 * @param {object} input
 * @param {object} [input.evidence]   新证据 { text, 相反: boolean, 来源 }
 * @param {Date}   [input.now]
 * @param {Array}  [input.siblings]   同实体的其他记录（用来判断干扰）
 * @returns {object} { action, reason, patch }
 */
export function planUpdate(record, input = {}) {
  const now = new Date(input.now ?? Date.now())
  const evidence = input.evidence ?? null
  const siblings = Array.isArray(input.siblings) ? input.siblings : []

  // ① 先看有没有反证。没有反证就不动内容——只更新"最近一次被想起"。
  if (!evidence) {
    return { action: ACTIONS.TOUCH, reason: '没有新证据，只更新最近一次被想起的时间', patch: { last_recalled: now.toISOString() } }
  }

  if (evidence.相反) {
    const polarity = polarityOf(record)
    // ② 不对称：负面要翻，需要更多证据
    const needed = polarity === '负面' ? NEGATIVE_FLIP_THRESHOLD : POSITIVE_FLIP_THRESHOLD
    const seen = Number(record?.['反证次数'] ?? 0) + 1

    if (seen >= needed) {
      // 够数了 → 改写。内容不在这里动，交给结论层的版本链去写新版本。
      return {
        action: ACTIONS.REVISE,
        reason: `反证第 ${seen} 条，达到翻转门槛 ${needed}（原倾向 ${polarity}）`,
        patch: {
          '反证次数': seen,
          倾向: polarity === '负面' ? '正面' : '负面',
          置信度: 0.5,
          last_recalled: now.toISOString(),
        },
      }
    }

    // 不够数 → 只降置信度，不改结论（弱反例不该翻盘）
    return {
      action: ACTIONS.REINFORCE,
      reason: `反证第 ${seen} 条，还没到门槛 ${needed}，只降置信度`,
      patch: {
        '反证次数': seen,
        置信度: clamp01(Number(record?.置信度 ?? 0.5) - 0.15),
        last_recalled: now.toISOString(),
      },
    }
  }

  // ③ 同向证据 → 强化
  return {
    action: ACTIONS.REINFORCE,
    reason: '同向证据，出现次数 +1，置信度上调',
    patch: {
      出现次数: Number(record?.出现次数 ?? 1) + 1,
      置信度: clamp01(Number(record?.置信度 ?? 0.5) + 0.1),
      last_confirmed: now.toISOString().slice(0, 10),
      last_recalled: now.toISOString(),
    },
  }
}

/**
 * 同实体条目太多时，把最旧的那几条降级（不是删）。
 * 依据：干扰理论——遗忘主要是新信息压住旧信息。
 *
 * @param {Array} records 同实体的全部记录
 * @returns {Array} [{ id, action, reason }]
 */
export function planSiblingPressure(records = []) {
  const byEntity = new Map()
  for (const record of records) {
    for (const entity of entitiesOf(record)) {
      if (!byEntity.has(entity)) byEntity.set(entity, [])
      byEntity.get(entity).push(record)
    }
  }

  const demotions = []
  for (const [entity, group] of byEntity) {
    if (group.length <= MAX_SIBLINGS_PER_ENTITY) continue
    const overflow = group.length - MAX_SIBLINGS_PER_ENTITY
    const ordered = [...group].sort((left, right) => {
      const leftAt = new Date(left.last_recalled ?? left.last_confirmed ?? left.event_time ?? 0).getTime() || 0
      const rightAt = new Date(right.last_recalled ?? right.last_confirmed ?? right.event_time ?? 0).getTime() || 0
      return leftAt - rightAt
    })
    for (const record of ordered.slice(0, overflow)) {
      demotions.push({
        id: record.id,
        action: ACTIONS.DEMOTE,
        reason: `实体「${entity}」下有 ${group.length} 条，超过 ${MAX_SIBLINGS_PER_ENTITY}，这条最旧，降级但保留`,
      })
    }
  }
  return demotions
}

/**
 * 把 planUpdate 的结论落到记录上（返回新对象，不改原对象）。
 */
export function applyUpdate(record, plan, now = new Date()) {
  if (!plan || plan.action === ACTIONS.NOOP) return { ...record }
  const patch = plan.patch ?? {}
  const next = { ...record, ...patch, 版本: Number(record?.版本 ?? 1) + (plan.action === ACTIONS.REVISE ? 1 : 0) }
  if (plan.action === ACTIONS.DEMOTE) {
    next.已降级 = true
    next.降级原因 = plan.reason
    next.降级时间 = new Date(now).toISOString()
  }
  return next
}
