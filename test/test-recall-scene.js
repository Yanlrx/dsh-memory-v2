import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { recall } from '../lib/recall.js'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-memory-v2-scene-recall-'))
const sceneDir = join(temporaryRoot, '情景')
mkdirSync(sceneDir, { recursive: true })
const now = new Date('2026-11-12T15:00:00+08:00')

const makeRecord = (id, text) => ({
  id,
  text,
  kind: ['事件'],
  event_time: new Date(now.getTime() - 5 * 86400000).toISOString(),
  来源: `test-${id}`,
  状态: '生效',
  实体: [],
  冲突: null,
})

// 与查询无关的条目：directlyRelevant 为空，触发情景兜底
const records = [makeRecord('coffee', '用户喜欢咖啡'), makeRecord('work', '用户从事广告投放')]

// 当天文件：第 4 行命中「健身房」，前后各 2 行应一起进片段
const todayLines = [
  '## [scene:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee] 10:00',
  '你说：早上去跑步了',
  '我说：不错，坚持住',
  '你说：下午还要去明城国际中心店的健身房',
  '我说：好的，注意补水',
  '## [scene:aaaaaaaa-bbbb-cccc-dddd-ffffffffffff] 11:00',
  '你说：中午吃了个汉堡',
  '我说：嗯',
]
writeFileSync(join(sceneDir, '2026-11-12.md'), todayLines.join('\n') + '\n', 'utf8')
// 前一天文件：当天搜不到「耳机」时回退到这里
writeFileSync(join(sceneDir, '2026-11-11.md'), '你说：昨天买了个新耳机\n我说：喜欢吗\n', 'utf8')

try {
  // 1. 条目查不到时，按词搜回当天情景原文；片段带前后各 2 行
  const hits = recall('健身房', { records, now, 情景目录: sceneDir })
  assert.ok(Array.isArray(hits) && hits.length >= 1, '应搜到情景原文')
  const first = hits[0]
  assert.equal(first.id, 'scene:2026-11-12.md:4', 'id 应为 scene:文件名:命中行号')
  assert.match(first.text, /早上去跑步了/, '片段应带命中行前 2 行')
  assert.match(first.text, /下午还要去明城国际中心店的健身房/, '片段应含命中行')
  assert.match(first.text, /注意补水/, '片段应带命中行后 2 行')
  assert.equal(first.来源, '情景原文 2026-11-12.md 第4行附近', '来源应注明文件与行号')
  assert.equal(first.状态, '生效')
  assert.equal(first.记忆类别, '情景原文')
  assert.equal(first.相关度, 1)
  assert.equal(first.权重, 1)
  assert.equal(first.可能过时, false)
  assert.ok(Array.isArray(first.召回依据.关键词命中) && first.召回依据.关键词命中.includes('健身房'), '召回依据应带命中词')
  assert.equal(first.召回依据.时间近因, 1)
  assert.equal(first.召回依据.实体邻接, 0)

  // 2. 当天没有命中时回退前一天
  const prev = recall('耳机', { records, now, 情景目录: sceneDir })
  assert.equal(prev.length, 1, '当天无命中应回退前一天')
  assert.match(prev[0].text, /昨天买了个新耳机/)
  assert.equal(prev[0].id, 'scene:2026-11-11.md:1')

  // 3. 最多 3 段
  const manyLines = []
  for (let index = 0; index < 6; index++) {
    manyLines.push(`你说：第${index}次提到跑步机`)
    manyLines.push('我说：好', '我说：好', '我说：好', '我说：好')
  }
  writeFileSync(join(sceneDir, '2026-11-12.md'), manyLines.join('\n') + '\n', 'utf8')
  const many = recall('跑步机', { records, now, 情景目录: sceneDir })
  assert.equal(many.length, 3, '最多只返回 3 个片段')

  // 4. 单段截断 300 字
  const longLine = '你说：' + '跑步'.repeat(200)
  writeFileSync(join(sceneDir, '2026-11-12.md'), ['你说：前一行', '我说：中一行', longLine, '我说：后一行', '你说：收尾'].join('\n') + '\n', 'utf8')
  const long = recall('跑步', { records, now, 情景目录: sceneDir })
  assert.equal(long.length, 1)
  assert.ok(Array.from(long[0].text).length <= 300, '单段截断 300 字')
  assert.match(long[0].text, /^你说：前一行/, '截断前应保留前文')

  // 5. 两天都没有命中 → 返回 []
  writeFileSync(join(sceneDir, '2026-11-12.md'), '你说：今天天气不错\n我说：是的\n', 'utf8')
  writeFileSync(join(sceneDir, '2026-11-11.md'), '你说：昨天也在下雨\n我说：嗯\n', 'utf8')
  assert.deepEqual(recall('量子香蕉', { records, now, 情景目录: sceneDir }), [], '两天都没命中时返回空数组')

  // 6. 条目直接命中时不走兜底（主路径行为不变）
  const direct = recall('咖啡', { records, now, 情景目录: sceneDir })
  assert.equal(direct.length, 1)
  assert.equal(direct[0].id, 'coffee')
  assert.notEqual(direct[0].记忆类别, '情景原文')

  // 7. 阶梯分层：三天前的内容近 2 天层查不到，近 7 天层查到
  writeFileSync(join(sceneDir, '2026-11-12.md'), '你说：今天天气不错\n我说：是的\n', 'utf8')
  writeFileSync(join(sceneDir, '2026-11-11.md'), '你说：昨天也在下雨\n我说：嗯\n', 'utf8')
  writeFileSync(join(sceneDir, '2026-11-09.md'), '你说：三天前去游泳了\n我说：水凉吗\n', 'utf8')
  const swim = recall('游泳', { records, now, 情景目录: sceneDir })
  assert.equal(swim.length, 1, '近 7 天层应命中三天前的内容')
  assert.equal(swim[0].id, 'scene:2026-11-09.md:1', '命中的应是三天前的文件，不是当天/昨天')

  // 8. 阶梯分层：20 天前的内容近 7 天层查不到，近 30 天层查到
  writeFileSync(join(sceneDir, '2026-10-23.md'), '你说：二十天前去登山了\n我说：登顶了吗\n', 'utf8')
  const hike = recall('登山', { records, now, 情景目录: sceneDir })
  assert.equal(hike.length, 1, '近 30 天层应命中 20 天前的内容')
  assert.equal(hike[0].id, 'scene:2026-10-23.md:1')

  // 9. 阶梯分层：40 天前的内容近 30 天层查不到，近 180 天层查到
  writeFileSync(join(sceneDir, '2026-10-03.md'), '你说：四十天前去露营了\n我说：好玩吗\n', 'utf8')
  const camp = recall('露营', { records, now, 情景目录: sceneDir })
  assert.equal(camp.length, 1, '近 180 天层应命中 40 天前的内容')
  assert.equal(camp[0].id, 'scene:2026-10-03.md:1')

  // 10. 「上周」时间线索：优先查 7~13 天前的窗口，而不是默认阶梯第一层的当天
  writeFileSync(join(sceneDir, '2026-11-12.md'), '你说：今天去了健身房\n我说：好\n', 'utf8')
  writeFileSync(join(sceneDir, '2026-11-02.md'), '你说：上周说要去健身房看看\n我说：走\n', 'utf8')
  const week = recall('上周说的健身', { records, now, 情景目录: sceneDir })
  assert.equal(week.length, 1)
  assert.equal(week[0].id, 'scene:2026-11-02.md:1', '「上周」应定位到 7~13 天前的窗口，而不是当天')

  // 11. 解析不了的时间词（国庆）不炸、走默认阶梯
  writeFileSync(join(sceneDir, '2026-11-12.md'), '你说：今天天气不错\n我说：是的\n', 'utf8')
  const national = recall('国庆那次提到的游泳', { records, now, 情景目录: sceneDir })
  assert.equal(national.length, 1, '解析失败的时间词应走默认阶梯')
  assert.equal(national[0].id, 'scene:2026-11-09.md:1', '默认阶梯近 7 天层命中三天前的游泳记录')

  // 12. 「昨天」时间线索：今天和昨天都含关键词时，center 优先返回昨天
  writeFileSync(join(sceneDir, '2026-11-12.md'), '你说：今天七点醒了\n我说：好\n', 'utf8')
  writeFileSync(join(sceneDir, '2026-11-11.md'), '你说：昨天三点醒了\n我说：早点睡\n', 'utf8')
  const woke = recall('昨天 醒了', { records, now, 情景目录: sceneDir })
  assert.equal(woke.length, 1)
  assert.equal(woke[0].id, 'scene:2026-11-11.md:1', '「昨天」应优先返回昨天的文件，而不是窗口里更近的今天')

  // 13. 片段清洗系统注入块：先清洗再截断，注入块不占 300 字配额
  const injectedLines = [
    '## [scene:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee] 10:00',
    '你说：Current runtime context 注入内容一',
    '注入内容二',
    '我说：早上好',
    '你说：下午去健身房了',
    '我说：好的',
  ]
  writeFileSync(join(sceneDir, '2026-11-12.md'), injectedLines.join('\n') + '\n', 'utf8')
  const cleaned = recall('早上好', { records, now, 情景目录: sceneDir })
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0].id, 'scene:2026-11-12.md:4')
  assert.equal(cleaned[0].text.includes('runtime context'), false, '片段不得含注入块原文')
  assert.ok(cleaned[0].text.includes('（系统注入，已省略）'), '注入块应替换为省略标记')
  assert.ok(cleaned[0].text.includes('早上好'), '注入块结束后的关键词行应保留')
  assert.ok(Array.from(cleaned[0].text).length <= 300, '清洗后截断仍 ≤300 字')

  console.log('情景原文兜底测试：通过（词搜原文、带前后文、回退前一天、最多3段、截断300字、无命中空数组、主路径不受影响、近2/7/30/180天阶梯、上周窗口、解析失败走阶梯、昨天center优先、注入块清洗）')
} finally {
  const resolved = resolve(temporaryRoot)
  const allowedPrefix = resolve(tmpdir(), 'dsh-memory-v2-scene-recall-')
  if (resolved.startsWith(allowedPrefix)) rmSync(resolved, { recursive: true, force: true })
}
