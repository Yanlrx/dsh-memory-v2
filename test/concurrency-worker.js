import { createStore } from '../lib/store.js'

const [root, prefix, rawCount] = process.argv.slice(2)
const count = Number(rawCount)
const store = createStore({ rootDir: root })
for (let index = 0; index < count; index++) {
  store.appendRecord('语义', {
    id: `${prefix}-${index}`, text: `${prefix}并发记录${index}`, kind: ['事件'],
    主体: '本人', 说话人: '本人', 来源: prefix, 门牌: `${prefix}-${index}`,
    event_time: new Date().toISOString(), last_confirmed: null, ttl: null,
    置信度: 1, 证据: [], 出现次数: 1, 被召回次数: 0,
    实体: [prefix], 冲突: null, 版本: 1, 状态: '生效',
  })
}
