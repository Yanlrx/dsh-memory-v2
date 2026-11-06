// test-revision.js —— 结论层的版本链回归。
// 验：结论只留一条最新版、旧版本进「历史」、召回拿的是最新版、其他集合不受影响。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'
import { recall } from '../lib/recall.js'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.revision-'))

try {
  const store = createStore({ rootDir: root })
  const base = {
    id: 'c1',
    text: '他怕扎托',
    kind: ['事件'],
    主体: '本人',
    说话人: '本人',
    原话: '',
    我的推断: '他怕扎托',
    来源: '我的判断',
    门牌: '判断 v1',
    event_time: '2026-10-20T10:00:00+08:00',
    last_confirmed: null,
    ttl: null,
    置信度: 0.6,
    证据: ['e1', 'e2'],
    出现次数: 1,
    被召回次数: 0,
    实体: ['扎托'],
    冲突: null,
    版本: 1,
    状态: '生效',
  }

  store.appendRecord('结论', base)

  // 改两次
  store.replaceRecord('结论', { ...base, text: '他怕的是青露', 置信度: 0.8, 证据: ['e1', 'e2', 'e3'], 版本: 2 })
  store.replaceRecord('结论', { ...base, text: '他怕青露，尤其在等南屿时', 置信度: 0.9, 证据: ['e1', 'e2', 'e3', 'e4'], 版本: 3 })

  const list = store.readCollection('结论')

  // ① 集合里只留最新版
  assert.equal(list.length, 1, '结论集合只该有一条（最新版）')
  assert.equal(list[0].版本, 3)
  assert.equal(list[0].text, '他怕青露，尤其在等南屿时')

  // ② 旧版本都在历史里，一条不少
  const history = list[0].历史 ?? []
  assert.equal(history.length, 2, '历史里该有两版')
  assert.equal(history[0].版本, 1)
  assert.equal(history[0].text, '他怕扎托')
  assert.equal(history[1].版本, 2)
  assert.equal(history[1].text, '他怕的是青露')
  assert.ok(history.every((item) => item.归档时间), '每一版都要有归档时间')
  assert.ok(history.every((item) => Array.isArray(item.证据)), '每一版都要留当时的证据')

  // ③ 召回拿到的是最新版
  const got = recall('青露', { store, now: new Date('2026-10-31T12:00:00+08:00') })
  const hit = got.find((item) => String(item.text).includes('青露'))
  assert.ok(hit, '最新版要能被召回')
  assert.equal(hit.版本, 3)
  assert.equal(hit.历史.length, 2, '召回结果里也能看到历史')

  // ④ 非结论集合不该冒出「历史」字段
  store.appendRecord('语义', {
    ...base,
    id: 's1',
    text: '一条普通事实',
    我的推断: '',
    门牌: '普通',
  })
  store.replaceRecord('语义', { ...base, id: 's1', text: '一条普通事实（改过）', 我的推断: '', 门牌: '普通', 版本: 2 })
  const semantic = store.readCollection('语义').find((item) => item.id === 's1')
  assert.equal(semantic.历史, undefined, '只有结论层才留版本链，别的集合不该多这个字段')

  // ⑤ 旧版快照也还在（双保险）
  const legacyDir = join(root, '旧版')
  assert.ok(fs.existsSync(legacyDir), '旧版目录要在')
  assert.ok(fs.readdirSync(legacyDir).length > 0, '旧版快照要真的写出来')

  console.log('结论版本链测试：通过（只留最新、历史留全、召回拿新版、别的集合不受影响）')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
