import assert from 'node:assert/strict'
import { recall } from '../lib/recall.js'

const now = new Date('2026-10-31T12:00:00+08:00')
const makeRecord = (id, text, daysAgo, extra = {}) => ({
  id,
  text,
  kind: ['事件'],
  event_time: new Date(now.getTime() - daysAgo * 86400000).toISOString(),
  来源: `test-${id}`,
  状态: '生效',
  实体: [],
  冲突: null,
  ...extra,
})

const records = [
  makeRecord('coffee-like', '用户喜欢咖啡', 1, { 实体: ['用户', '咖啡'], 冲突: ['coffee-dislike'] }),
  makeRecord('coffee-dislike', '用户不喜欢咖啡', 20, { 实体: ['用户', '咖啡'], 冲突: ['coffee-like'] }),
  makeRecord('coffee-shop', '常去车站旁边的咖啡店', 2, { 实体: ['咖啡', '车站'] }),
  makeRecord('tea', '用户喜欢绿茶', 3, { 实体: ['用户', '绿茶'] }),
  makeRecord('game', '用户偶尔下国际象棋', 4, { 实体: ['用户', '国际象棋'] }),
  makeRecord('cat', '用户养了一只橘猫', 5, { 实体: ['用户', '橘猫'] }),
  makeRecord('work', '用户从事园艺设计', 6, { 实体: ['用户', '工作'] }),
  makeRecord('food', '用户喜欢酸甜口味', 7, { 实体: ['用户', '饮食'] }),
  makeRecord('music', '用户听过一首新歌', 8, { 实体: ['用户', '音乐'] }),
  makeRecord('travel', '用户去过上海', 9, { 实体: ['用户', '上海'] }),
]

const result = recall('他到底喜不喜欢咖啡？', { records, now })
const ids = result.map((record) => record.id)

assert.ok(result.length <= 4, '默认召回不得超过 4 条')
assert.equal(ids.includes('coffee-like'), true, '应召回正向记录')
assert.equal(ids.includes('coffee-dislike'), true, '应强制带上反证')
assert.equal(Math.abs(ids.indexOf('coffee-like') - ids.indexOf('coffee-dislike')), 1, '冲突双方应成对相邻')
assert.deepEqual(recall('量子香蕉火箭', { records, now }), [], '没有关键词或实体信号时必须返回空')

console.log('召回测试：通过（≤4、冲突成对、反证已带上）')

