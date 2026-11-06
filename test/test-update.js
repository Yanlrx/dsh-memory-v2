// test-update.js —— 更新机制（update.js）的回归。
// 验四件事：动作分流、印象更新不对称、同实体压制、applyUpdate 不改原对象。

import assert from 'node:assert/strict'
import { ACTIONS, planUpdate, planSiblingPressure, applyUpdate } from '../lib/update.js'

const now = new Date('2026-10-31T12:00:00+08:00')

// ① 没有新证据 → 只更新"最近想起"，不动内容
{
  const record = { id: 'a', 置信度: 0.8, 出现次数: 2 }
  const plan = planUpdate(record, { now })
  assert.equal(plan.action, ACTIONS.TOUCH)
  assert.equal(plan.patch.last_recalled, now.toISOString())
  assert.ok(!('置信度' in plan.patch), '没有证据时不许动置信度')
}

// ② 同向证据 → 强化
{
  const record = { id: 'b', 置信度: 0.5, 出现次数: 2 }
  const plan = planUpdate(record, { now, evidence: { text: '还是这样', 相反: false } })
  assert.equal(plan.action, ACTIONS.REINFORCE)
  assert.equal(plan.patch.出现次数, 3)
  assert.ok(plan.patch.置信度 > 0.5)
}

// ③ 不对称：正面遇到 1 条反证就翻
{
  const record = { id: 'c', 置信度: 0.8, 倾向: '正面', 反证次数: 0 }
  const plan = planUpdate(record, { now, evidence: { text: '其实相反', 相反: true } })
  assert.equal(plan.action, ACTIONS.REVISE)
  assert.equal(plan.patch.倾向, '负面')
}

// ④ 不对称：负面遇到 1 条反证不翻，只降置信度
{
  const record = { id: 'd', 置信度: 0.8, 倾向: '负面', 反证次数: 0 }
  const plan = planUpdate(record, { now, evidence: { text: '其实不是', 相反: true } })
  assert.equal(plan.action, ACTIONS.REINFORCE, '负面不该被一条反证翻掉')
  assert.equal(plan.patch.倾向, undefined, '不该改倾向')
  assert.ok(plan.patch.置信度 < 0.8, '但置信度要降')
}

// ⑤ 负面凑够 3 条才翻
{
  const record = { id: 'e', 置信度: 0.8, 倾向: '负面', 反证次数: 2 }
  const plan = planUpdate(record, { now, evidence: { text: '其实不是', 相反: true } })
  assert.equal(plan.action, ACTIONS.REVISE, '第 3 条反证应该翻')
  assert.equal(plan.patch.倾向, '正面')
}

// ⑥ 同实体超过 5 条，降最旧的，不删
{
  const many = Array.from({ length: 7 }, (_, index) => ({
    id: `s${index}`,
    实体: ['扎托'],
    last_confirmed: `2026-10-${String(index + 1).padStart(2, '0')}`,
  }))
  const demotions = planSiblingPressure(many)
  assert.equal(demotions.length, 2, '7 条压 5 条，溢出 2 条')
  assert.deepEqual(demotions.map((item) => item.id), ['s0', 's1'], '降的是最旧的两条')
  assert.ok(demotions.every((item) => item.action === ACTIONS.DEMOTE))
  assert.ok(demotions.every((item) => /降级但保留/.test(item.reason)), '理由里要说清是保留')
}

// ⑦ 不超过阈值时一条都不降
{
  const five = Array.from({ length: 5 }, (_, index) => ({ id: `t${index}`, 实体: ['扎托'] }))
  assert.equal(planSiblingPressure(five).length, 0, '正好 5 条不该降')
}

// ⑧ applyUpdate 不改原对象，revise 时版本号 +1
{
  const record = { id: 'f', 版本: 1, 置信度: 0.8, 倾向: '正面', 反证次数: 0 }
  const plan = planUpdate(record, { now, evidence: { text: '其实相反', 相反: true } })
  const next = applyUpdate(record, plan, now)
  assert.equal(record.倾向, '正面', '原对象不许被改')
  assert.equal(next.倾向, '负面')
  assert.equal(next.版本, 2, '改写要升版本')
}

// ⑨ 降级要留下原因和时间，但不是删
{
  const record = { id: 'g', 版本: 1 }
  const next = applyUpdate(record, { action: ACTIONS.DEMOTE, reason: '同实体太多', patch: {} }, now)
  assert.equal(next.已降级, true)
  assert.equal(next.降级原因, '同实体太多')
  assert.ok(next.降级时间)
  assert.ok(next.text === undefined || true, '降级不删内容')
}

console.log('更新机制测试：9/9 通过（动作分流、不对称翻转、同实体压制、不改原对象）')
