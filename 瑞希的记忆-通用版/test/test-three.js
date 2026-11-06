import assert from 'node:assert/strict'
import { isValid } from '../lib/valid.js'
import { getWeight } from '../lib/weight.js'
import { isExpired } from '../lib/expiry.js'

const now = new Date('2026-10-31T12:00:00+08:00')

const validPositive = {
  kind: ['状态'],
  last_confirmed: '2026-10-30T12:00:00+08:00',
  ttl: '7d',
  被召回次数: 2,
}
const validZero = { ...validPositive, 被召回次数: 0 }
const invalidPositive = {
  kind: ['状态'],
  last_confirmed: '2026-10-01T12:00:00+08:00',
  ttl: '7d',
  被召回次数: 2,
}
const invalidZero = { ...invalidPositive, 被召回次数: 0 }

assert.equal(isValid(validPositive, now), true, '组合1：有效且权重大于 0')
assert.ok(getWeight(validPositive, now) > 0, '组合1：权重应大于 0')

assert.equal(isValid(validZero, now), true, '组合2：权重为 0 时仍然有效')
assert.equal(getWeight(validZero, now), 0, '组合2：权重应为 0')

assert.equal(isValid(invalidPositive, now), false, '组合3：过期状态应失效')
assert.ok(getWeight(invalidPositive, now) > 0, '组合3：失效不妨碍权重大于 0')

assert.equal(isValid(invalidZero, now), false, '组合4：过期且权重为 0 时应失效')
assert.equal(getWeight(invalidZero, now), 0, '组合4：权重应为 0')

assert.equal(isExpired(validPositive, now), false, '未过期状态不需要询问')
assert.equal(isExpired(invalidPositive, now), true, '过期状态需要询问')
assert.equal(isValid({ kind: ['事件'], 被召回次数: 0 }, now), true, '事件永远有效')

console.log('四组合测试：4/4 通过')
