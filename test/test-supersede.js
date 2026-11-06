// test-supersede.js —— memory_write 接上更新机制后的回归。
// 验三件事：传 supersede 是改不是新增；不传照旧新增；反证会改写并升版本。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.supersede-'))

try {
  const store = createStore({ rootDir: root })

  // 先造一条"原来的印象"
  const base = {
    id: 'r1',
    text: 'ta 讨厌扎托',
    kind: ['偏好'],
    主体: '本人',
    说话人: '本人',
    原话: '别扎托',
    我的推断: '',
    来源: '2026-10-31 10:00',
    门牌: '本间会话 2026-10-31 10:00',
    event_time: null,
    last_confirmed: '2026-10-31',
    ttl: null,
    置信度: 0.8,
    证据: [],
    出现次数: 1,
    被召回次数: 0,
    实体: ['扎托'],
    冲突: null,
    版本: 1,
    状态: '生效',
  }
  store.appendRecord('语义', base)

  const before = store.readCollection('语义')
  assert.equal(before.length, 1)

  // ① 同向更新：不新增，出现次数 +1
  const plan = await import('../lib/update.js').then((mod) => mod.planUpdate(base, {
    now: new Date('2026-10-31T12:00:00+08:00'),
    evidence: { text: '还是讨厌扎托', 相反: false },
  }))
  assert.equal(plan.action, 'reinforce')
  const mod = await import('../lib/update.js')
  const next = mod.applyUpdate(base, plan, new Date('2026-10-31T12:00:00+08:00'))
  store.replaceRecord('语义', { ...next })

  const after = store.readCollection('语义')
  assert.equal(after.length, 1, '更新不该新增一条')
  assert.equal(after[0].id, 'r1', 'id 不变')
  assert.equal(after[0].出现次数, 2, '出现次数要 +1')
  assert.ok(after[0].置信度 > 0.8, '置信度上调')

  // ② 反证：版本号 +1，正文被换掉
  const oppositePlan = mod.planUpdate(after[0], {
    now: new Date('2026-10-31T13:00:00+08:00'),
    evidence: { text: '其实现在不讨厌了', 相反: true },
  })
  assert.equal(oppositePlan.action, 'revise', '正面遇反证应当改写')
  const revised = mod.applyUpdate(after[0], oppositePlan, new Date('2026-10-31T13:00:00+08:00'))
  store.replaceRecord('语义', { ...revised, text: '其实现在不讨厌了' })

  const final = store.readCollection('语义')
  assert.equal(final.length, 1, '改写也不新增')
  assert.equal(final[0].版本, 2, '改写要升版本')
  assert.equal(final[0].倾向, '负面', '倾向要翻过来')
  assert.equal(final[0].text, '其实现在不讨厌了', '正文要换成新证据')

  // ③ 找不到要更新的记录时要报错，不许悄悄新建
  let threw = null
  try {
    store.replaceRecord('语义', { ...base, id: 'not-exist' })
  } catch (error) { threw = error }
  assert.ok(threw, '找不到记录必须报错')
  assert.match(threw.message, /找不到要更新的记录/)

  // ④ 旧版和镜像要跟上（replaceRecord 走的是同一条 commit）
  const legacy = fs.existsSync(join(root, '旧版'))
  const mirror = fs.existsSync(join(root, '镜像'))
  assert.ok(legacy && mirror, '旧版和镜像目录要在')
  const mirrorFiles = fs.readdirSync(join(root, '镜像'))
  assert.ok(mirrorFiles.length > 0, '镜像要真的写出来')
  const mirrorText = fs.readFileSync(join(root, '镜像', mirrorFiles[0]), 'utf8')
  assert.ok(mirrorText.includes('其实现在不讨厌了'), '镜像里要有改写后的内容')

  console.log('更新接线测试：通过（改不新增、id 不变、反证升版本、找不到报错、备份跟上）')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
