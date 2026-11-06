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
  makeRecord('drink-like', '用户喜欢扎托', 1, { 实体: ['用户', '扎托'], 冲突: ['drink-dislike'] }),
  makeRecord('drink-dislike', '用户不喜欢扎托', 20, { 实体: ['用户', '扎托'], 冲突: ['drink-like'] }),
  makeRecord('drink-shop', '常去街角的扎托店', 2, { 实体: ['扎托', '店铺'] }),
  makeRecord('brew', '用户喜欢青露', 3, { 实体: ['用户', '青露'] }),
  makeRecord('game', '用户常玩星海远征', 4, { 实体: ['用户', '星海远征'] }),
  makeRecord('cat', '用户养了一只猫', 5, { 实体: ['用户', '默认'] }),
  makeRecord('work', '用户从事星云测绘', 6, { 实体: ['用户', '工作'] }),
  makeRecord('food', '用户喜欢某种口味', 7, { 实体: ['用户', '饮食'] }),
  makeRecord('music', '用户听过一首新歌', 8, { 实体: ['用户', '音乐'] }),
  makeRecord('travel', '用户去过南屿', 9, { 实体: ['用户', '南屿'] }),
]

const result = recall('他到底喜不喜欢扎托？', { records, now })
const ids = result.map((record) => record.id)

assert.ok(result.length <= 4, '默认召回不得超过 4 条')
assert.equal(ids.includes('drink-like'), true, '应召回正向记录')
assert.equal(ids.includes('drink-dislike'), true, '应强制带上反证')
assert.equal(Math.abs(ids.indexOf('drink-like') - ids.indexOf('drink-dislike')), 1, '冲突双方应成对相邻')

console.log('召回测试：通过（≤4、冲突成对、反证已带上）')

