import assert from 'node:assert/strict'
import test from 'node:test'

import { createSkillStateCoordinator } from '../electron/skills/stateCoordinator.js'

const request = {
  packageId: 'package-1',
  scopeType: 'project',
  scopeKey: 'project-1',
  changes: [{ adapterId: 'codex', desiredState: 'disabled' }]
}

function migrationPlan(overrides = {}) {
  return {
    revision: 'a'.repeat(64),
    classification: 'migration_required',
    reasonCode: null,
    impacts: [],
    steps: [
      { type: 'ensure_direct', adapterId: 'opencode' },
      { type: 'disable_direct', adapterId: 'codex' },
      { type: 'set_desired', adapterId: 'codex', desiredState: 'disabled' }
    ],
    ...overrides
  }
}

function fakeOperations({ plan = migrationPlan(), failAt = null } = {}) {
  const calls = []
  const state = { created: [], disabled: [], recovery: null }
  let currentPlan = plan
  const fail = (point) => {
    if (failAt === point) throw new Error(`injected ${point} failure`)
  }
  return {
    calls,
    state,
    loadSnapshot(value) {
      calls.push(['snapshot', value.packageId])
      return { package: { id: value.packageId } }
    },
    plan(snapshot, changes) {
      calls.push(['plan', snapshot.package.id, changes.map((change) => change.adapterId).join(',')])
      return currentPlan
    },
    async ensureDirect({ adapterId }) {
      calls.push(['ensureDirect', adapterId])
      fail('ensure')
      state.created.push(adapterId)
      return { adapterId, created: true, sha256: 'package-sha', installationId: `new-${adapterId}` }
    },
    async verifyDirect({ adapterId, expectedSha256 }) {
      calls.push(['verifyDirect', adapterId, expectedSha256])
      fail('verify')
      return { sha256: expectedSha256 }
    },
    async disableDirect({ adapterId }) {
      calls.push(['disableDirect', adapterId])
      fail('disable')
      state.disabled.push(adapterId)
      return { adapterId, installationId: `old-${adapterId}` }
    },
    async commitDesired({ changes }) {
      for (const { adapterId, desiredState } of changes) calls.push(['commitDesired', adapterId, desiredState])
      fail('commit')
    },
    async flush() {
      calls.push(['flush'])
      fail('flush')
    },
    async rescan({ packageId }) {
      calls.push(['rescan', packageId])
      fail('rescan')
      return { affectedInstallationIds: ['new-opencode', 'old-codex'], affectedSessions: ['session-1'] }
    },
    async restoreDirect({ adapterId }) {
      calls.push(['restoreDirect', adapterId])
      state.disabled = state.disabled.filter((item) => item !== adapterId)
    },
    async removeCreatedDirect({ adapterId, expectedSha256 }) {
      calls.push(['removeCreatedDirect', adapterId, expectedSha256])
      state.created = state.created.filter((item) => item !== adapterId)
    },
    async revertActivatedDirect({ adapterId }) {
      calls.push(['revertActivatedDirect', adapterId])
      state.activated = false
    },
    async markRecovery({ packageId }) {
      calls.push(['markRecovery', packageId])
      state.recovery = packageId
    },
    async packageView(packageId) {
      return { id: packageId }
    },
    setPlan(next) {
      currentPlan = next
    }
  }
}

test('reverts a re-enabled direct projection when desired-state commit fails', async () => {
  const operations = fakeOperations({ failAt: 'commit' })
  operations.state.activated = true
  operations.ensureDirect = async ({ adapterId }) => {
    operations.calls.push(['ensureDirect', adapterId])
    return { adapterId, created: false, activated: true, sha256: 'package-sha', installationId: `old-${adapterId}` }
  }

  await assert.rejects(
    createSkillStateCoordinator(operations).apply({ ...request, expectedRevision: 'a'.repeat(64) }),
    /injected commit failure/
  )
  assert.equal(operations.state.activated, false)
  assert.ok(operations.calls.some(([name]) => name === 'revertActivatedDirect'))
})

test('applies migration steps in filesystem-safe order before committing desired state', async () => {
  const operations = fakeOperations()
  const coordinator = createSkillStateCoordinator(operations)

  const result = await coordinator.apply({ ...request, expectedRevision: 'a'.repeat(64) })

  assert.deepEqual(operations.calls.slice(2), [
    ['ensureDirect', 'opencode'],
    ['verifyDirect', 'opencode', 'package-sha'],
    ['disableDirect', 'codex'],
    ['commitDesired', 'codex', 'disabled'],
    ['flush'],
    ['rescan', 'package-1']
  ])
  assert.deepEqual(result, {
    package: { id: 'package-1' },
    plan: migrationPlan(),
    affectedInstallationIds: ['new-opencode', 'old-codex'],
    affectedSessions: ['session-1']
  })
})

test('rejects stale and blocked plans before filesystem mutation', async () => {
  const stale = fakeOperations()
  await assert.rejects(
    createSkillStateCoordinator(stale).apply({ ...request, expectedRevision: 'b'.repeat(64) }),
    { code: 'SKILL_PROJECTION_PLAN_STALE' }
  )
  assert.equal(stale.calls.some(([name]) => name === 'ensureDirect'), false)

  const blocked = fakeOperations({ plan: migrationPlan({ classification: 'blocked', reasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED', steps: [] }) })
  await assert.rejects(
    createSkillStateCoordinator(blocked).apply({ ...request, expectedRevision: 'a'.repeat(64) }),
    { code: 'SKILL_CLI_ISOLATION_UNSUPPORTED' }
  )
  assert.equal(blocked.calls.some(([name]) => name === 'ensureDirect'), false)
})

for (const failAt of ['verify', 'disable', 'commit']) {
  test(`rolls back newly-created projections and retains existing projections when ${failAt} fails before commit`, async () => {
    const operations = fakeOperations({ failAt })

    await assert.rejects(
      createSkillStateCoordinator(operations).apply({ ...request, expectedRevision: 'a'.repeat(64) }),
      /injected/
    )

    assert.deepEqual(operations.state.created, [])
    assert.deepEqual(operations.state.disabled, [])
    assert.deepEqual(operations.calls.at(-1), ['removeCreatedDirect', 'opencode', 'package-sha'])
  })
}

test('marks recovery after an uncertain committed flush and blocks subsequent destructive apply', async () => {
  const operations = fakeOperations({ failAt: 'flush' })
  const coordinator = createSkillStateCoordinator(operations)

  await assert.rejects(
    coordinator.apply({ ...request, expectedRevision: 'a'.repeat(64) }),
    { code: 'SKILL_PROJECTION_RECOVERY_REQUIRED' }
  )
  assert.equal(operations.state.recovery, 'package-1')
  assert.equal(operations.calls.some(([name]) => name === 'removeCreatedDirect'), false)

  operations.setPlan(migrationPlan({ classification: 'blocked', reasonCode: 'SKILL_PROJECTION_RECOVERY_REQUIRED', steps: [] }))
  await assert.rejects(
    coordinator.apply({ ...request, expectedRevision: 'a'.repeat(64) }),
    { code: 'SKILL_PROJECTION_RECOVERY_REQUIRED' }
  )
})
