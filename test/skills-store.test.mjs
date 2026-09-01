import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

let installCalls = []
let progressSnapshots = []
let stateLoads = 0
let failRefresh = false
let batchResponse
let statePreviewResponse
let previewCliStateChange
let applyCliStateChange
let resolveCliStateRecovery
let previewSkillsBatchAction
let applySkillsBatchAction
let store

globalThis.window = {
  ucli: {
    async installSkills(requests) {
      installCalls.push(requests)
      progressSnapshots.push({ ...store.batchProgress })
      return batchResponse
    },
    async getSkillsState() {
      stateLoads += 1
      if (failRefresh) throw Object.assign(new Error('Refresh failed'), { code: 'SKILL_REFRESH_FAILED' })
      return {
        adapters: [], projects: [], packages: [], discovered: [],
        summary: { managedPackages: 0, activeInstallations: 0, updates: 0, conflicts: 0 },
        lastCheckedAt: null
      }
    },
    async previewCliStateChange(request) {
      return previewCliStateChange(request)
    },
    async applyCliStateChange(request) {
      return applyCliStateChange(request)
    },
    async resolveCliStateRecovery(packageId) {
      return resolveCliStateRecovery(packageId)
    },
    async previewSkillsBatchAction(request) {
      return previewSkillsBatchAction(request)
    },
    async applySkillsBatchAction(request) {
      return applySkillsBatchAction(request)
    },
    async removePackage(packageId) {
      return packageId === 'package-1'
    }
  }
}

const { useSkillsStore } = await import('../src/stores/skills.js')

function requests() {
  return ['skills/first', 'skills/failing', 'skills/last'].map((subdir) => ({
    source: { type: 'git', url: 'https://github.com/example/skills', subdir },
    targetAdapterIds: ['codex'], scopeType: 'user', projectPath: ''
  }))
}

function resetStore() {
  installCalls = []
  progressSnapshots = []
  stateLoads = 0
  failRefresh = false
  statePreviewResponse = {
    revision: 'a'.repeat(64), classification: 'migration_required', impacts: ['codex']
  }
  previewCliStateChange = async (request) => ({ ...statePreviewResponse, receivedRequest: request })
  applyCliStateChange = async (request) => {
    if (request.expectedRevision === 'stale'.repeat(13).slice(0, 64)) {
      throw Object.assign(new Error('Skill projection plan is stale'), {
        code: 'SKILL_PROJECTION_PLAN_STALE', recoveryAction: 'unsafe-action', recoveryPath: 'F:\\secret'
      })
    }
    return { package: { id: request.packageId } }
  }
  resolveCliStateRecovery = async (packageId) => ({ package: { id: packageId } })
  previewSkillsBatchAction = async request => ({ revision: 'a'.repeat(64), items: request.items })
  applySkillsBatchAction = async () => ({ succeeded: [], failed: [], skipped: [], recoveryRequired: [], aborted: null })
  setActivePinia(createPinia())
  store = useSkillsStore()
}

test('Skills store sends one batch mutation and refreshes state once', async () => {
  resetStore()
  const batchRequests = requests()
  batchResponse = {
    installed: [
      { request: batchRequests[0], result: { id: 'package-first' } },
      { request: batchRequests[2], result: { id: 'package-last' } }
    ],
    failed: [{
      request: batchRequests[1],
      error: { code: 'SKILL_TARGET_CONFLICT', message: 'Target conflict' }
    }]
  }

  const result = await store.installMany(batchRequests)

  assert.equal(installCalls.length, 1)
  assert.deepEqual(installCalls[0].map((item) => item.source.subdir), [
    'skills/first', 'skills/failing', 'skills/last'
  ])
  assert.deepEqual(progressSnapshots, [{ total: 3 }])
  assert.deepEqual(result, batchResponse)
  assert.equal(stateLoads, 1)
  assert.equal(store.batchProgress, null)
  assert.equal(store.saving, false)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

test('Skills store ignores a late CLI state preview after a newer package request', async () => {
  resetStore()
  const first = deferred()
  const second = deferred()
  let calls = 0
  previewCliStateChange = () => (++calls === 1 ? first.promise : second.promise)
  const requestA = { packageId: 'package-a', scopeType: 'user', scopeKey: '*', changes: [] }
  const requestB = { packageId: 'package-b', scopeType: 'user', scopeKey: '*', changes: [] }

  const pendingA = store.previewCliStateChange(requestA)
  const pendingB = store.previewCliStateChange(requestB)
  second.resolve({ revision: 'b'.repeat(64), classification: 'direct' })
  await pendingB
  first.resolve({ revision: 'a'.repeat(64), classification: 'direct' })
  await pendingA

  assert.deepEqual(store.statePreview, { revision: 'b'.repeat(64), classification: 'direct' })
  assert.deepEqual(store.statePreviewIdentity, {
    packageId: 'package-b', scopeType: 'user', scopeKey: '*'
  })
})

test('Skills store clears and fences a pending project preview when the project scope changes', async () => {
  resetStore()
  const pending = deferred()
  previewCliStateChange = () => pending.promise
  const request = {
    packageId: 'package-1', scopeType: 'project', scopeKey: 'F:\\demo', changes: []
  }

  const preview = store.previewCliStateChange(request)
  await store.load('F:\\other-project')
  pending.resolve({ revision: 'a'.repeat(64), classification: 'direct' })
  await preview

  assert.equal(store.statePreview, null)
  assert.equal(store.statePreviewIdentity, null)
})

test('Skills store ignores an error from a superseded CLI state preview', async () => {
  resetStore()
  const first = deferred()
  const second = deferred()
  let calls = 0
  previewCliStateChange = () => (++calls === 1 ? first.promise : second.promise)
  const requestA = { packageId: 'package-a', scopeType: 'user', scopeKey: '*', changes: [] }
  const requestB = { packageId: 'package-b', scopeType: 'user', scopeKey: '*', changes: [] }

  const pendingA = store.previewCliStateChange(requestA)
  const pendingB = store.previewCliStateChange(requestB)
  second.resolve({ revision: 'b'.repeat(64), classification: 'direct' })
  await pendingB
  first.reject(Object.assign(new Error('old preview failed'), { code: 'SKILL_OPERATION_FAILED' }))
  await assert.rejects(pendingA, { code: 'SKILL_OPERATION_FAILED' })

  assert.deepEqual(store.statePreview, { revision: 'b'.repeat(64), classification: 'direct' })
  assert.equal(store.error, null)
})

test('a successful pending CLI state apply cannot clear a newer preview', async () => {
  resetStore()
  const applying = deferred()
  applyCliStateChange = () => applying.promise
  const requestA = { packageId: 'package-a', scopeType: 'user', scopeKey: '*', changes: [] }
  const requestB = { packageId: 'package-b', scopeType: 'user', scopeKey: '*', changes: [] }
  await store.previewCliStateChange(requestA)

  const pendingApply = store.applyCliStateChange({ ...requestA, expectedRevision: 'a'.repeat(64) })
  await store.previewCliStateChange(requestB)
  applying.resolve({ package: { id: 'package-a' } })
  await pendingApply

  assert.deepEqual(store.statePreview, {
    ...statePreviewResponse, receivedRequest: requestB
  })
  assert.equal(store.error, null)
})

test('a failed pending CLI state apply cannot overwrite a newer preview error state', async () => {
  resetStore()
  const applying = deferred()
  applyCliStateChange = () => applying.promise
  const requestA = { packageId: 'package-a', scopeType: 'user', scopeKey: '*', changes: [] }
  const requestB = { packageId: 'package-b', scopeType: 'user', scopeKey: '*', changes: [] }
  await store.previewCliStateChange(requestA)

  const pendingApply = store.applyCliStateChange({ ...requestA, expectedRevision: 'a'.repeat(64) })
  await store.previewCliStateChange(requestB)
  applying.reject(Object.assign(new Error('old apply failed'), { code: 'SKILL_OPERATION_FAILED' }))
  await assert.rejects(pendingApply, { code: 'SKILL_OPERATION_FAILED' })

  assert.deepEqual(store.statePreview, {
    ...statePreviewResponse, receivedRequest: requestB
  })
  assert.equal(store.error, null)
})

test('Skills store retains a CLI state preview and applies it with separate saving state', async () => {
  resetStore()
  const request = {
    packageId: 'package-1', scopeType: 'user', scopeKey: '*',
    changes: [{ adapterId: 'codex', desiredState: 'disabled' }]
  }

  const preview = await store.previewCliStateChange(request)
  assert.equal(preview.revision, 'a'.repeat(64))
  assert.equal(store.statePreview.receivedRequest.packageId, 'package-1')
  assert.equal(store.stateSaving, false)
  assert.equal(store.saving, false)

  const result = await store.applyCliStateChange({ ...request, expectedRevision: preview.revision })
  assert.deepEqual(result, { package: { id: 'package-1' } })
  assert.equal(stateLoads, 1)
  assert.equal(store.stateSaving, false)
  assert.equal(store.saving, false)
})

test('Skills store resolves guarded CLI-state recovery once and refreshes state', async () => {
  resetStore()
  const pending = deferred()
  resolveCliStateRecovery = () => pending.promise
  const recovery = store.resolveCliStateRecovery('package-1')

  assert.equal(store.recoverySaving, true)
  assert.equal(store.stateSaving, false)
  pending.resolve({ package: { id: 'package-1' } })
  assert.deepEqual(await recovery, { package: { id: 'package-1' } })
  assert.equal(stateLoads, 1)
  assert.equal(store.recoverySaving, false)
})

test('Skills store preserves a successful recovery when its follow-up refresh fails', async () => {
  resetStore()
  failRefresh = true
  store.statePreview = { revision: 'a'.repeat(64) }
  store.statePreviewIdentity = { packageId: 'package-1', scopeType: 'user', scopeKey: '' }

  const result = await store.resolveCliStateRecovery('package-1')

  assert.deepEqual(result, {
    package: { id: 'package-1' },
    refreshError: { code: 'SKILL_REFRESH_FAILED', message: 'Refresh failed' }
  })
  assert.equal(stateLoads, 1)
  assert.equal(store.statePreview, null)
  assert.deepEqual(store.error, { code: 'SKILL_REFRESH_FAILED', message: 'Refresh failed' })
  assert.equal(store.recoverySaving, false)
})

test('Skills store preserves a preview after a stale plan and exposes no unsafe recovery details', async () => {
  resetStore()
  const request = {
    packageId: 'package-1', scopeType: 'user', scopeKey: '*',
    changes: [{ adapterId: 'codex', desiredState: 'disabled' }]
  }
  const preview = await store.previewCliStateChange(request)
  const staleRevision = 'stale'.repeat(13).slice(0, 64)

  await assert.rejects(
    store.applyCliStateChange({ ...request, expectedRevision: staleRevision }),
    { code: 'SKILL_PROJECTION_PLAN_STALE' }
  )
  assert.deepEqual(store.statePreview, preview)
  assert.deepEqual(store.error, {
    code: 'SKILL_PROJECTION_PLAN_STALE', message: 'Skill projection plan is stale'
  })
  assert.equal(Object.hasOwn(store.error, 'recoveryAction'), false)
  assert.equal(Object.hasOwn(store.error, 'recoveryPath'), false)
  assert.equal(store.stateSaving, false)
})

test('Skills store removes a managed package and refreshes local state', async () => {
  resetStore()
  assert.equal(await store.removePackage('package-1'), true)
  assert.equal(stateLoads, 1)
})

test('Skills store keeps a batch preview and retains failed plus remaining items for retry', async () => {
  resetStore()
  const request = {
    action: 'update_packages',
    items: [{ kind: 'package', id: 'a' }, { kind: 'package', id: 'b' }, { kind: 'package', id: 'c' }, { kind: 'package', id: 'd' }],
    targets: { scopeType: 'user', scopeKey: '*' }
  }
  applySkillsBatchAction = async () => ({
    succeeded: [{ item: request.items[0], packageId: 'a', action: 'update_packages', affectedAdapterIds: [] }],
    failed: [{ item: request.items[1], code: 'SKILL_OPERATION_FAILED', retryable: true }],
    skipped: [{ item: request.items[2], reasonCode: 'SKILL_BATCH_NOOP' }], recoveryRequired: [],
    aborted: { code: 'SKILL_PERSISTENCE_PENDING', remainingItems: [request.items[3]] }
  })

  const preview = await store.previewBatchAction(request)
  assert.equal(store.batchPreview.revision, preview.revision)
  const result = await store.applyBatchAction({ ...request, expectedRevision: preview.revision })

  assert.deepEqual(result.failed.map(entry => entry.item), [request.items[1]])
  assert.equal(store.batchSaving, false)
  assert.deepEqual(store.batchResult, result)
  assert.deepEqual(store.batchSelection, [request.items[1], request.items[2], request.items[3]])
  assert.deepEqual(store.batchRetryableSelection, [request.items[1]])
  await store.retryFailedBatch()
  assert.equal(store.batchSaving, false)
})

test('Skills store preserves mutation results when the final refresh fails', async () => {
  resetStore()
  const batchRequests = requests()
  failRefresh = true
  batchResponse = {
    installed: [{ request: batchRequests[0], result: { id: 'package-first' } }],
    failed: [{
      request: batchRequests[1],
      error: { code: 'SKILL_TARGET_CONFLICT', message: 'Target conflict' }
    }]
  }

  const result = await store.installMany(batchRequests)

  assert.deepEqual(result.installed, batchResponse.installed)
  assert.deepEqual(result.failed, batchResponse.failed)
  assert.deepEqual(result.refreshError, {
    code: 'SKILL_REFRESH_FAILED', message: 'Refresh failed'
  })
  assert.equal(stateLoads, 1)
  assert.equal(store.batchProgress, null)
  assert.equal(store.saving, false)
})

test('Skills store refreshes after a persistence-pending partial batch result', async () => {
  resetStore()
  const batchRequests = requests()
  batchResponse = {
    installed: [{ request: batchRequests[0], result: { id: 'package-first' } }],
    failed: [],
    aborted: {
      request: batchRequests[1],
      error: { code: 'SKILL_PERSISTENCE_PENDING', message: 'Skill changes are pending persistence' },
      skippedRequests: [batchRequests[2]]
    }
  }

  const result = await store.installMany(batchRequests)

  assert.equal(result.aborted.request.source.subdir, 'skills/failing')
  assert.equal(stateLoads, 1)
  assert.equal(store.batchProgress, null)
  assert.equal(store.saving, false)
})
