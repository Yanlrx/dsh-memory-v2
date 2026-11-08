// 2026-10-31：情景转义的专项回归。
// 规则：用户原话一个字都不改（那是证据）；只有我这半边的回复会被转义，
//       免得我的 ``` 和行首 # 把后面的分段裹进去。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const parent = dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(join(parent, '.scene-escape-'))

try {
  const store = createStore({ rootDir: root })
  const now = new Date()

  // 用户原话里带三反引号和行首井号——必须原样留着
  const userText = '三反引号 ``` 和\n## 这行是原话里的井号\n还有 ``` 结尾'
  // 我的回复里也带——必须被换掉
  const assistantText = '我这里有 ``` 代码块\n## 我这边的小标题\n结束'

  const state = store.appendTurn(userText, assistantText, now, () => {})
  assert.equal(state.轮数, 1, '第一轮计数')

  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const scene = fs.readFileSync(join(root, '情景', `${day}.md`), 'utf8')

  // ① 用户原话原样
  assert.ok(scene.includes(`你说：${userText}`), '用户原话必须原样保留，一个字都不许改')

  // ② 我的回复被转义
  //    用户原话里故意留了两个 ```，所以整份文件里应当正好只剩这两个
  assert.equal((scene.match(/```/g) ?? []).length, 2, '三反引号只剩用户原话里那两个')
  assert.ok(scene.includes("''' 代码块"), '我的三反引号换成三个单引号')
  assert.ok(scene.includes('＃＃ 我这边的小标题'), '我的行首井号换成全角')

  // ③ 整份文件里，「轮次标题」只该有一个（用户原话里的 ## 行不算，它不是 HH:mm 格式）
  const lines = scene.split('\n')
  const turnHeaders = lines.filter((line) => /^## \[scene:[0-9a-f-]+\] \d{2}:\d{2}$/.test(line))
  assert.equal(turnHeaders.length, 1, '轮次标题只有一个')
  // 我的小标题已经被换掉，所以行首半角 # 只剩「轮次标题」和「用户原话里那行」两处
  const halfWidthHashLines = lines.filter((line) => /^#/.test(line))
  assert.equal(halfWidthHashLines.length, 2, '行首半角 # 只剩轮次标题 + 用户原话那行')

  // ④ 偏移索引仍然对得上：按索引切片能原样取回这一段
  const consolidated = store.consolidateScenes(1, now, () => {})
  assert.equal(consolidated.text, scene, '切片结果应当等于整段原文（单轮时）')
  assert.ok(consolidated.text.includes('你说：' + userText), '切片里用户原话也在')

  console.log('情景转义专项测试：通过（用户原样、我方转义、只有一个分段标题、切片对齐）')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
