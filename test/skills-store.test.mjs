import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

let installCalls = []
let progressSnapshots = []
let stateLoads = 0
let failRefresh = false
let batchResponse
let statePreviewResponse
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
      return { ...statePreviewResponse, receivedRequest: request }
    },
    async applyCliStateChange(request) {
      if (request.expectedRevision === 'stale'.repeat(13).slice(0, 64)) {
        throw Object.assign(new Error('Skill projection plan is stale'), {
          code: 'SKILL_PROJECTION_PLAN_STALE', recoveryAction: 'unsafe-action', recoveryPath: 'F:\\secret'
        })
      }
      return { package: { id: request.packageId } }
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
