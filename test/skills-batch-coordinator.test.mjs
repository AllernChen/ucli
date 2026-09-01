import assert from 'node:assert/strict'
import test from 'node:test'

import { createSkillsBatchCoordinator } from '../electron/skills/batchCoordinator.js'

const revision = 'a'.repeat(64)

function packageView(id, { organization = null } = {}) {
  return {
    id,
    resolvedRevision: revision,
    contentSha256: revision,
    sourceIdentity: organization && {
      originKind: 'organization',
      serverOrigin: 'https://skills.example.test',
      organizationId: organization,
      catalogVersionId: `${id}-version`
    },
    installations: [{
      id: `${id}-codex`, targetAdapterId: 'codex', scopeType: 'user', scopeKey: '*',
      enabled: true, status: 'ready'
    }]
  }
}

function services({ packages = [packageView('a'), packageView('b')], fail = null } = {}) {
  const calls = []
  return {
    calls,
    async getState() { return { packages } },
    async previewCliStateChange(request) {
      calls.push(['preview', request.packageId])
      return { revision: `${request.packageId}`.padEnd(64, '0'), classification: 'direct', impacts: [{ adapterId: 'codex' }] }
    },
    async applyCliStateChange(request) {
      calls.push(['apply-state', request.packageId])
      if (fail === request.packageId) throw Object.assign(new Error('drifted'), { code: 'SKILL_DRIFTED' })
      return { affectedInstallationIds: [`${request.packageId}-codex`] }
    },
    async update(packageId) { calls.push(['update', packageId]); return { id: packageId } },
    async removeInstallation(installationId) { calls.push(['remove-projection', installationId]); return true },
    async removePackage(packageId) { calls.push(['remove-package', packageId]); return true }
  }
}

function request(action, items = [{ kind: 'package', id: 'a' }, { kind: 'package', id: 'b' }]) {
  return {
    action,
    items,
    targets: { scopeType: 'user', scopeKey: '*', adapterId: 'codex', desiredState: 'disabled' }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

test('batch coordinator rejects incompatible item kinds before any operation', async () => {
  const skillService = services()
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })

  await assert.rejects(
    coordinator.preview(request('install_organization', [{ kind: 'package', id: 'a' }])),
    { code: 'SKILL_BATCH_CONTEXT_INVALID' }
  )
  assert.deepEqual(skillService.calls, [])
})

test('batch coordinator executes package operations in stable order and preserves ordinary partial failures', async () => {
  const skillService = services({ fail: 'b' })
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
  const initial = request('set_cli_state', [{ kind: 'package', id: 'b' }, { kind: 'package', id: 'a' }])
  const preview = await coordinator.preview(initial)

  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result, {
    succeeded: [{
      item: { kind: 'package', id: 'a' }, packageId: 'a', action: 'set_cli_state', affectedAdapterIds: ['codex'], affectedSessionIds: []
    }],
    failed: [{ item: { kind: 'package', id: 'b' }, code: 'SKILL_DRIFTED', retryable: false }],
    skipped: [],
    recoveryRequired: [],
    aborted: null
  })
  assert.deepEqual(skillService.calls, [
    ['preview', 'a'], ['preview', 'b'], ['preview', 'a'], ['apply-state', 'a'], ['preview', 'b'], ['apply-state', 'b']
  ])
})

test('batch coordinator aborts remaining items when persistence becomes uncertain', async () => {
  const skillService = services()
  skillService.update = async packageId => {
    skillService.calls.push(['update', packageId])
    if (packageId === 'a') throw Object.assign(new Error('pending'), { code: 'SKILL_PERSISTENCE_PENDING' })
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
  const initial = request('update_packages')
  const preview = await coordinator.preview(initial)

  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result, {
    succeeded: [],
    failed: [{ item: { kind: 'package', id: 'a' }, code: 'SKILL_PERSISTENCE_PENDING', retryable: false }],
    skipped: [],
    recoveryRequired: [],
    aborted: { code: 'SKILL_PERSISTENCE_PENDING', remainingItems: [{ kind: 'package', id: 'b' }] }
  })
  assert.deepEqual(skillService.calls, [['update', 'a']])
})

test('batch coordinator aborts and records recovery-required package operations', async () => {
  const skillService = services()
  skillService.removePackage = async packageId => {
    skillService.calls.push(['remove-package', packageId])
    throw Object.assign(new Error('recovery'), { code: 'SKILL_PROJECTION_RECOVERY_REQUIRED', recoveryAction: 'retry_apply_codex' })
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
  const initial = request('remove_packages')
  const preview = await coordinator.preview(initial)

  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result, {
    succeeded: [], failed: [], skipped: [],
    recoveryRequired: [{
      item: { kind: 'package', id: 'a' }, packageId: 'a', recoveryAction: 'retry_apply_codex'
    }],
    aborted: { code: 'SKILL_PROJECTION_RECOVERY_REQUIRED', remainingItems: [{ kind: 'package', id: 'b' }] }
  })
})

test('batch coordinator records a stale item and continues independently revalidated later items', async () => {
  const packages = [packageView('a'), packageView('b'), packageView('c')]
  const skillService = services({ packages })
  const firstApplied = deferred()
  const releaseFirst = deferred()
  skillService.applyCliStateChange = async ({ packageId }) => {
    skillService.calls.push(['apply-state', packageId])
    if (packageId === 'a') {
      firstApplied.resolve()
      await releaseFirst.promise
    }
    return { affectedInstallationIds: [`${packageId}-codex`] }
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
  const initial = request('set_cli_state', [
    { kind: 'package', id: 'a' }, { kind: 'package', id: 'b' }, { kind: 'package', id: 'c' }
  ])
  const preview = await coordinator.preview(initial)
  const applying = coordinator.apply({ ...initial, expectedRevision: preview.revision })
  await firstApplied.promise
  packages[1] = { ...packages[1], contentSha256: 'b'.repeat(64) }
  releaseFirst.resolve()

  assert.deepEqual(await applying, {
    succeeded: [
      { item: { kind: 'package', id: 'a' }, packageId: 'a', action: 'set_cli_state', affectedAdapterIds: ['codex'], affectedSessionIds: [] },
      { item: { kind: 'package', id: 'c' }, packageId: 'c', action: 'set_cli_state', affectedAdapterIds: ['codex'], affectedSessionIds: [] }
    ],
    failed: [{ item: { kind: 'package', id: 'b' }, code: 'SKILL_PROJECTION_PLAN_STALE', retryable: false }],
    skipped: [], recoveryRequired: [], aborted: null
  })
  assert.equal(skillService.calls.some(call => call[0] === 'apply-state' && call[1] === 'b'), false)
  assert.equal(skillService.calls.some(call => call[0] === 'apply-state' && call[1] === 'c'), true)
})

test('batch coordinator treats interleaved false removals as skipped rather than succeeded', async () => {
  for (const [action, operation, reasonCode] of [
    ['remove_projections', 'removeInstallation', 'SKILL_PROJECTION_NOT_FOUND'],
    ['remove_packages', 'removePackage', 'SKILL_PACKAGE_NOT_FOUND']
  ]) {
    const skillService = services({ packages: [packageView('a')] })
    skillService[operation] = async () => false
    const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
    const initial = request(action, [{ kind: 'package', id: 'a' }])
    const preview = await coordinator.preview(initial)
    const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })
    assert.deepEqual(result, {
      succeeded: [], failed: [],
      skipped: [{ item: { kind: 'package', id: 'a' }, reasonCode }],
      recoveryRequired: [], aborted: null
    })
  }
})

test('batch coordinator closes admission and drains a deferred catalog operation before shutdown resolves', async () => {
  const installing = deferred()
  const installStarted = deferred()
  const catalog = {
    list: () => [
      { versionId: 'a', serverOrigin: 'https://skills.example.test', organizationId: 'org-1', lifecycleStatus: 'ACTIVE' },
      { versionId: 'b', serverOrigin: 'https://skills.example.test', organizationId: 'org-1', lifecycleStatus: 'ACTIVE' }
    ],
    async install(versionId) {
      installStarted.resolve(versionId)
      return installing.promise
    }
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: services(), organizationCatalog: catalog })
  const initial = {
    action: 'install_organization',
    items: [{ kind: 'organization_version', id: 'a' }, { kind: 'organization_version', id: 'b' }],
    targets: { scopeType: 'user', scopeKey: '*', targetAdapterIds: ['codex'] }
  }
  const preview = await coordinator.preview(initial)
  const applying = coordinator.apply({ ...initial, expectedRevision: preview.revision })
  await installStarted.promise
  let stopped = false
  const stopping = coordinator.shutdown().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  installing.resolve({ id: 'package-a' })

  assert.deepEqual(await applying, {
    succeeded: [{
      item: { kind: 'organization_version', id: 'a' }, packageId: 'package-a', action: 'install_organization', affectedAdapterIds: ['codex'], affectedSessionIds: []
    }],
    failed: [], skipped: [], recoveryRequired: [],
    aborted: { code: 'SKILL_BATCH_SHUTDOWN', remainingItems: [{ kind: 'organization_version', id: 'b' }] }
  })
  await stopping
  await assert.rejects(coordinator.preview(initial), { code: 'SKILL_BATCH_SHUTDOWN' })
})

test('batch coordinator captures safe affected session ids before a destructive package mutation', async () => {
  const skillService = services({ packages: [packageView('a')] })
  skillService.getAffectedSessions = async (installationIds) => {
    skillService.calls.push(['sessions', ...installationIds])
    return [{ id: 'session-a' }, { id: 'session-a' }, { id: 'not-a-session' }]
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
  const initial = request('remove_packages', [{ kind: 'package', id: 'a' }])
  const preview = await coordinator.preview(initial)

  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result.succeeded, [{
    item: { kind: 'package', id: 'a' }, packageId: 'a', action: 'remove_packages',
    affectedAdapterIds: ['codex'], affectedSessionIds: ['not-a-session', 'session-a']
  }])
  assert.deepEqual(skillService.calls, [['sessions', 'a-codex'], ['remove-package', 'a']])
})

test('batch coordinator captures sessions before state migration and an installed organization update', async () => {
  const migrationService = services({ packages: [packageView('a')] })
  migrationService.getAffectedSessions = async (installationIds) => {
    migrationService.calls.push(['sessions', ...installationIds])
    return [{ id: 'migration-session' }]
  }
  const migration = createSkillsBatchCoordinator({ skillsService: migrationService, organizationCatalog: { list: () => [] } })
  const stateRequest = request('set_cli_state', [{ kind: 'package', id: 'a' }])
  const statePreview = await migration.preview(stateRequest)
  const stateResult = await migration.apply({ ...stateRequest, expectedRevision: statePreview.revision })
  assert.deepEqual(stateResult.succeeded[0].affectedSessionIds, ['migration-session'])
  assert.ok(migrationService.calls.findIndex((call) => call[0] === 'sessions') < migrationService.calls.findIndex((call) => call[0] === 'apply-state'))

  const organizationService = services({ packages: [packageView('a', { organization: 'org-1' })] })
  organizationService.getAffectedSessions = async (installationIds) => {
    organizationService.calls.push(['sessions', ...installationIds])
    return [{ id: 'organization-session' }]
  }
  const catalog = {
    list: () => [{ versionId: 'a-version', serverOrigin: 'https://skills.example.test', organizationId: 'org-1', lifecycleStatus: 'ACTIVE' }],
    async update(versionId) { organizationService.calls.push(['update-organization', versionId]); return { id: 'a' } }
  }
  const organization = createSkillsBatchCoordinator({ skillsService: organizationService, organizationCatalog: catalog })
  const organizationRequest = {
    action: 'update_organization', items: [{ kind: 'organization_version', id: 'a-version' }],
    targets: { scopeType: 'user', scopeKey: '*', targetAdapterIds: ['codex'] }
  }
  const organizationPreview = await organization.preview(organizationRequest)
  const organizationResult = await organization.apply({ ...organizationRequest, expectedRevision: organizationPreview.revision })
  assert.deepEqual(organizationResult.succeeded[0].affectedSessionIds, ['organization-session'])
  assert.ok(organizationService.calls.findIndex((call) => call[0] === 'sessions') < organizationService.calls.findIndex((call) => call[0] === 'update-organization'))
})

test('batch coordinator resolves the exact projection session rather than every package installation', async () => {
  const pkg = packageView('a')
  pkg.installations.push({ id: 'a-claude', targetAdapterId: 'claude', scopeType: 'user', scopeKey: '*', enabled: true, status: 'ready' })
  const skillService = services({ packages: [pkg] })
  skillService.getAffectedSessions = async (installationIds) => {
    skillService.calls.push(['sessions', ...installationIds])
    return installationIds.map((id) => ({ id: `session-${id}` }))
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
  const initial = request('remove_projections', [{ kind: 'package', id: 'a' }])
  const preview = await coordinator.preview(initial)
  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result.succeeded[0].affectedSessionIds, ['session-a-codex'])
  assert.deepEqual(skillService.calls, [['sessions', 'a-codex'], ['remove-projection', 'a-codex']])
})

test('batch coordinator scopes state-change session lookup to planned adapters', async () => {
  const pkg = packageView('a')
  pkg.installations.push(
    { id: 'a-claude', targetAdapterId: 'claude', scopeType: 'user', scopeKey: '*', enabled: true, status: 'ready' },
    { id: 'a-project', targetAdapterId: 'codex', scopeType: 'project', scopeKey: 'F:\\project', enabled: true, status: 'ready' }
  )
  const skillService = services({ packages: [pkg] })
  skillService.previewCliStateChange = async () => ({ revision: 'a'.repeat(64), classification: 'migration_required', impacts: [{ adapterId: 'claude' }] })
  skillService.getAffectedSessions = async (installationIds) => {
    skillService.calls.push(['sessions', ...installationIds])
    return installationIds.map((id) => ({ id: `session-${id}` }))
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: { list: () => [] } })
  const initial = request('set_cli_state', [{ kind: 'package', id: 'a' }])
  const preview = await coordinator.preview(initial)
  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result.succeeded[0].affectedSessionIds, ['session-a-claude', 'session-a-codex'])
  assert.deepEqual(skillService.calls.filter((call) => call[0] === 'sessions'), [['sessions', 'a-claude', 'a-codex']])
})

test('batch coordinator gets new organization-install sessions from returned projections after success', async () => {
  const calls = []
  const skillService = services({ packages: [] })
  skillService.getAffectedSessions = async (installationIds) => {
    calls.push(['sessions', ...installationIds])
    return installationIds.map((id) => ({ id: `session-${id}` }))
  }
  const catalog = {
    list: () => [{ versionId: 'new-version', serverOrigin: 'https://skills.example.test', organizationId: 'org-1', lifecycleStatus: 'ACTIVE' }],
    async install() {
      calls.push(['install'])
      return { id: 'new-package', installations: [{ id: 'new-codex', targetAdapterId: 'codex', scopeType: 'user', scopeKey: '*' }] }
    }
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: catalog })
  const initial = { action: 'install_organization', items: [{ kind: 'organization_version', id: 'new-version' }], targets: { scopeType: 'user', scopeKey: '*', targetAdapterIds: ['codex'] } }
  const preview = await coordinator.preview(initial)
  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result.succeeded[0].affectedSessionIds, ['session-new-codex'])
  assert.deepEqual(calls, [['install'], ['sessions', 'new-codex']])
})

test('batch coordinator associates an organization update by persisted slug when catalog version changes', async () => {
  const pkg = packageView('a', { organization: 'org-1' })
  pkg.sourceIdentity.catalogVersionId = 'old-version'
  pkg.server = { slug: 'release-notes' }
  const skillService = services({ packages: [pkg] })
  skillService.getAffectedSessions = async (installationIds) => installationIds.map((id) => ({ id: `session-${id}` }))
  const catalog = {
    list: () => [{ versionId: 'new-version', serverOrigin: 'https://skills.example.test', organizationId: 'org-1', slug: 'release-notes', lifecycleStatus: 'ACTIVE' }],
    async update() { return { id: 'a', installations: pkg.installations } }
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: catalog })
  const initial = { action: 'update_organization', items: [{ kind: 'organization_version', id: 'new-version' }], targets: { scopeType: 'user', scopeKey: '*', targetAdapterIds: ['codex'] } }
  const preview = await coordinator.preview(initial)
  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result.succeeded[0].affectedSessionIds, ['session-a-codex'])
})

test('batch coordinator captures every same-slug organization package session before updating', async () => {
  const first = packageView('first', { organization: 'org-1' })
  const second = packageView('second', { organization: 'org-1' })
  first.sourceIdentity.catalogVersionId = 'old-first-version'
  second.sourceIdentity.catalogVersionId = 'old-second-version'
  first.server = { slug: 'release-notes' }
  second.server = { slug: 'release-notes' }
  first.installations.push({ id: 'first-project', targetAdapterId: 'codex', scopeType: 'project', scopeKey: 'F:\\project', enabled: true, status: 'ready' })
  second.installations.push({ id: 'second-claude', targetAdapterId: 'claude', scopeType: 'user', scopeKey: '*', enabled: true, status: 'ready' })
  const skillService = services({ packages: [first, second] })
  skillService.getAffectedSessions = async (installationIds) => {
    skillService.calls.push(['sessions', ...installationIds])
    return installationIds.map((id) => ({ id: `session-${id}` }))
  }
  const catalog = {
    list: () => [{ versionId: 'new-version', serverOrigin: 'https://skills.example.test', organizationId: 'org-1', slug: 'release-notes', lifecycleStatus: 'ACTIVE' }],
    async update(versionId) { skillService.calls.push(['update-organization', versionId]); return { id: 'first' } }
  }
  const coordinator = createSkillsBatchCoordinator({ skillsService: skillService, organizationCatalog: catalog })
  const initial = { action: 'update_organization', items: [{ kind: 'organization_version', id: 'new-version' }], targets: { scopeType: 'user', scopeKey: '*', targetAdapterIds: ['codex'] } }
  const preview = await coordinator.preview(initial)
  const result = await coordinator.apply({ ...initial, expectedRevision: preview.revision })

  assert.deepEqual(result.succeeded[0].affectedSessionIds, ['session-first-codex', 'session-second-codex'])
  assert.deepEqual(skillService.calls, [
    ['sessions', 'first-codex', 'second-codex'],
    ['update-organization', 'new-version']
  ])
})
