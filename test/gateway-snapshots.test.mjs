import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPlanOverview, SnapshotStore } from '../electron/gateway/snapshotStore.js'

const PLAN = `# Gateway rollout

## Goal

Connect selected UCLI sessions to Feishu without forwarding terminal output.

## Steps

### 1. Parse events

Update \`electron/gateway/runtime.js\` and electron/gateway/taskQueue.js.

### 2. Route replies

Use electron/gateway/runtime.js and test/gateway-runtime.test.mjs.

### 3. Verify

Run npm test.
`

test('plan overview is deterministic and contains bounded headings and unique paths', () => {
  const overview = buildPlanOverview(PLAN)
  assert.equal(overview.title, 'Gateway rollout')
  assert.equal(
    overview.goal,
    'Connect selected UCLI sessions to Feishu without forwarding terminal output.'
  )
  assert.deepEqual(overview.headings, [
    'Goal',
    'Steps',
    '1. Parse events',
    '2. Route replies',
    '3. Verify'
  ])
  assert.deepEqual(overview.filePaths, [
    'electron/gateway/runtime.js',
    'electron/gateway/taskQueue.js',
    'test/gateway-runtime.test.mjs'
  ])
  assert.equal(overview.headingCount, 6)
  assert.equal(overview.fileCount, 3)
  assert.equal(overview.characterCount, Array.from(PLAN.trim()).length)
})

test('plans without structure use a 300-code-point content preview', () => {
  const overview = buildPlanOverview('😀'.repeat(350))
  assert.equal(overview.title, '内容预览')
  assert.equal(Array.from(overview.preview).length, 300)
})

test('SnapshotStore keeps full text in memory and puts plan actions on the final chunk only', () => {
  const store = new SnapshotStore({ chunkSize: 60 })
  const plan = store.storePlan(PLAN)
  const result = store.storeResult('Result '.repeat(30))
  assert.match(plan.planSnapshotId, /^[0-9a-f-]{36}$/)
  assert.match(result.resultSnapshotId, /^[0-9a-f-]{36}$/)

  const planChunks = store.getPlanChunks(plan.planSnapshotId)
  assert.ok(planChunks.length > 1)
  assert.ok(planChunks.slice(0, -1).every((chunk) => chunk.actions.length === 0))
  assert.deepEqual(
    planChunks.at(-1).actions.map((action) => action.id),
    ['execute', 'reject', 'revise']
  )
  assert.ok(store.getResultChunks(result.resultSnapshotId)
    .every((chunk) => chunk.actions.length === 0))

  store.clear()
  assert.equal(store.getPlanChunks(plan.planSnapshotId), null)
  assert.equal(store.getResultChunks(result.resultSnapshotId), null)
})

test('snapshot extraction failures are desktop-only and expose no execute action', () => {
  const store = new SnapshotStore()
  const plan = store.storePlan(null)
  const result = store.storeResult(null)
  assert.equal(plan.message, '无法可靠提取完整方案，请在 UCLI 中处理')
  assert.deepEqual(plan.actions, [])
  assert.equal(result.message, '无法可靠提取完整结果，请在 UCLI 中查看')
  assert.deepEqual(result.actions, [])
})
