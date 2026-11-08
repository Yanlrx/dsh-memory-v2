import assert from 'node:assert/strict'
import { recall } from '../lib/recall.js'

const now = new Date('2026-11-07T12:00:00+08:00')
const base = {
  状态: '生效', kind: ['事件'], event_time: '2026-11-07T10:00:00+08:00',
  被召回次数: 0, 实体: [], 冲突: null,
}

const punct = recall('天气!!!如何', { now, records: [{ ...base, id: 'punct', text: '无关记录', 实体: ['!!!'] }] })
assert.deepEqual(punct, [], '纯标点实体不得让无关记录直接相关')

const records = [
  { ...base, id: 'left', text: '示例结论为正面', 冲突: ['right'] },
  { ...base, id: 'right', text: '示例结论为负面', 冲突: ['left'] },
  { ...base, id: 'other', text: '另一条记录' },
]
const semantic = recall('没有字面命中', { now, records, vectorIds: ['left'], limit: 2 })
assert.deepEqual(semantic.map((item) => item.id), ['left', 'right'], '语义直接命中也必须带上冲突对方')

const ranked = recall('仍然没有字面命中', {
  now,
  records: [
    { ...base, id: 'lower', text: '第一条合成记录' },
    { ...base, id: 'higher', text: '第二条合成记录' },
  ],
  vectorScores: new Map([['lower', 0.6], ['higher', 0.9]]),
  limit: 2,
})
assert.deepEqual(ranked.map((item) => item.id), ['higher', 'lower'], '语义相似度必须参与命中项排序')

const weakOverlap = recall('今天工作怎么样', {
  now,
  records: [{ ...base, id: 'dinner', text: '今天晚饭吃饺子' }],
})
assert.deepEqual(weakOverlap, [], '只有一个常见二字词重合时不得召回无关记录')

console.log('召回强化测试：标点实体隔离、语义冲突成对、相似度排序与最低门槛通过')
