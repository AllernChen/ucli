import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCompletionCard,
  buildDecisionCard,
  buildInterruptCard,
  buildNoticeCard,
  buildPlanDetailCard,
  buildPlanOverviewCard,
  buildQueueCard,
  buildRootCard
} from '../electron/gateway/channels/feishuCards.js'

function buttonValues(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) buttonValues(item, result)
  } else if (value && typeof value === 'object') {
    if (value.tag === 'button') {
      assert.equal(Object.hasOwn(value, 'value'), false)
      assert.equal(value.behaviors?.length, 1)
      assert.equal(value.behaviors[0].type, 'callback')
      result.push(value.behaviors[0].value)
    }
    for (const child of Object.values(value)) buttonValues(child, result)
  }
  return result
}

test('all Feishu Gateway cards use schema 2.0 and opaque-only button values', () => {
  const actions = [
    { id: 'execute', label: '执行方案', token: 'opaque-token-1' },
    { id: 'reject', label: '拒绝', token: 'opaque-token-2' }
  ]
  const cards = [
    buildRootCard({
      displayName: 'Gateway session',
      adapterLabel: 'Codex',
      shortSessionId: 'a1b2c3d4',
      stateLabel: '等待确认',
      queueCount: 2,
      interruptToken: 'opaque-interrupt',
      sessionId: 'session-secret',
      nativeSessionId: 'native-secret'
    }),
    buildDecisionCard({
      title: '执行命令？',
      summary: 'npm test',
      actions,
      decisionId: 'decision-secret'
    }),
    buildPlanOverviewCard({
      overview: {
        title: 'Gateway rollout',
        goal: 'Connect Feishu.',
        headings: ['Steps'],
        filePaths: ['electron/gateway/runtime.js'],
        headingCount: 2,
        fileCount: 1,
        characterCount: 100
      },
      viewToken: 'opaque-view'
    }),
    buildPlanDetailCard({
      title: 'Gateway rollout',
      markdown: '# Detail',
      index: 2,
      total: 2,
      actions
    }),
    buildCompletionCard({
      title: '任务完成',
      summary: 'All tests passed.',
      resultToken: 'opaque-result'
    }),
    buildQueueCard({ position: 3, sessionLabel: 'Gateway session' }),
    buildNoticeCard({ message: 'Queue full.' }),
    buildInterruptCard({
      cancelledTaskLabel: '当前任务已中断',
      continueToken: 'opaque-continue',
      clearToken: 'opaque-clear'
    })
  ]

  for (const card of cards) assert.equal(card.schema, '2.0')
  const values = cards.flatMap((card) => buttonValues(card))
  assert.ok(values.length >= 7)
  for (const value of values) {
    assert.deepEqual(Object.keys(value).sort(), ['integration', 'token'])
    assert.equal(value.integration, 'ucli-gateway')
    assert.match(value.token, /^opaque-/)
  }
  const encoded = JSON.stringify(cards)
  assert.equal(encoded.includes('session-secret'), false)
  assert.equal(encoded.includes('native-secret'), false)
  assert.equal(encoded.includes('decision-secret'), false)
})

test('only the final plan detail card can contain decision actions', () => {
  const action = { id: 'execute', label: '执行方案', token: 'opaque-execute' }
  const first = buildPlanDetailCard({
    title: 'Plan',
    markdown: 'Part one',
    index: 1,
    total: 2,
    actions: [action]
  })
  const last = buildPlanDetailCard({
    title: 'Plan',
    markdown: 'Part two',
    index: 2,
    total: 2,
    actions: [action]
  })

  assert.deepEqual(buttonValues(first), [])
  assert.equal(buttonValues(last).length, 1)
})
