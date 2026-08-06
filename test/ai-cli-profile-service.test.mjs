import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as codexProfileFiles from '../electron/aiCliProfiles/codexProfileFile.js'
import { ProfileSecretStore } from '../electron/aiCliProfiles/profileSecretStore.js'
import { createProfileService } from '../electron/aiCliProfiles/profileService.js'
import { openDb } from '../electron/persistence/db.js'

const IDS = [
  '550e8400-e29b-41d4-a716-446655440000',
  '660e8400-e29b-41d4-a716-446655440000',
  '770e8400-e29b-41d4-a716-446655440000',
  '880e8400-e29b-41d4-a716-446655440000'
]

function safeStorage({ available = true, decryptFails = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString(value) {
      if (decryptFails) throw new Error('OS keychain details')
      return value.toString('utf8').replace(/^encrypted:/, '')
    }
  }
}

function managedDraft(overrides = {}) {
  return {
    adapterId: 'codex',
    name: 'Company Gateway',
    kind: 'managed',
    baseUrl: 'https://gateway.example.com/v1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    contextWindow: 400000,
    secret: 'top-secret-1234',
    ...overrides
  }
}

async function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-profile-service-'))
  const codexHomeA = join(root, 'codex-a')
  const codexHomeB = join(root, 'codex-b')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(codexHomeA)
  mkdirSync(codexHomeB)
  const db = await openDb(join(root, 'ucli.db'))
  const secretStore = new ProfileSecretStore({
    db,
    safeStorage: options.safeStorage || safeStorage(),
    now: () => 100
  })
  let home = codexHomeA
  let idIndex = 0
  const service = createProfileService({
    db,
    secretStore,
    resolveCodexHome: () => home,
    readCodexRuntime: () => options.runtime || {
      currentProvider: 'work_gateway',
      availableProviders: ['openai', 'work_gateway'],
      providerCatalog: [
        { id: 'openai', displayName: 'OpenAI' },
        { id: 'work_gateway', displayName: 'Work Gateway' }
      ]
    },
    fileOps: options.fileOps || codexProfileFiles,
    uuid: () => IDS[idIndex++],
    now: () => 100 + idIndex,
    flush: options.flush || (() => db.flush())
  })
  return {
    root,
    codexHomeA,
    codexHomeB,
    db,
    secretStore,
    service,
    setCodexHome(value) { home = value },
    close() {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('createProfile rolls back database and secret rows when file projection fails', async () => {
  const context = await harness({
    fileOps: {
      ...codexProfileFiles,
      writeCodexProfileFileAtomic() {
        throw Object.assign(new Error('disk failure details'), { code: 'PROFILE_FILE_WRITE_FAILED' })
      }
    }
  })
  try {
    await assert.rejects(
      () => context.service.createProfile(managedDraft()),
      { code: 'PROFILE_FILE_WRITE_FAILED' }
    )
    assert.deepEqual(context.db.listAiCliProfiles(), [])
    assert.equal(context.db.getAiCliProfileSecretRecord(IDS[0]), null)
  } finally {
    context.close()
  }
})

test('createProfile reports persistence pending after a successful file write and failed flush', async () => {
  const context = await harness({ flush: () => false })
  try {
    await assert.rejects(
      () => context.service.createProfile(managedDraft()),
      { code: 'PROFILE_PERSISTENCE_PENDING' }
    )
    const stored = context.db.getAiCliProfile(IDS[0])
    assert.equal(stored.name, 'Company Gateway')
    assert.equal(existsSync(codexProfileFiles.resolveCodexProfilePath(
      context.codexHomeA,
      stored.nativeProfileName
    )), true)
  } finally {
    context.close()
  }
})

test('profile update snapshots non-sensitive config and rollback preserves the secret', async () => {
  const context = await harness()
  try {
    const created = await context.service.createProfile(managedDraft())
    await context.service.updateProfile(created.id, {
      name: 'Updated Gateway',
      model: 'gpt-5.5'
    })

    const [revision] = context.service.listRevisions(created.id)
    assert.equal(revision.config.model, 'gpt-5.4')
    assert.equal(JSON.stringify(revision).includes('top-secret'), false)
    assert.equal(JSON.stringify(revision).includes('ciphertext'), false)

    const rolledBack = await context.service.rollbackProfile(created.id, revision.id)
    assert.equal(rolledBack.name, 'Company Gateway')
    assert.equal(rolledBack.model, 'gpt-5.4')
    assert.equal(context.secretStore.getSecret(created.id), 'top-secret-1234')
    assert.equal(context.service.listRevisions(created.id).length, 2)
  } finally {
    context.close()
  }
})

test('reconcile reports missing, drifted, provider and secret states', async () => {
  const context = await harness()
  try {
    const managed = await context.service.createProfile(managedDraft())
    const storedManaged = context.db.getAiCliProfile(managed.id)
    const managedPath = codexProfileFiles.resolveCodexProfilePath(
      context.codexHomeA,
      storedManaged.nativeProfileName
    )
    unlinkSync(managedPath)
    assert.equal((await context.service.reconcileCodexProfiles()).profiles
      .find((profile) => profile.id === managed.id).status, 'missing_file')

    await context.service.repairProfile(managed.id)
    writeFileSync(managedPath, `${readFileSync(managedPath, 'utf8')}# external edit\n`)
    assert.equal((await context.service.reconcileCodexProfiles()).profiles
      .find((profile) => profile.id === managed.id).status, 'drifted')

    const reference = await context.service.createProfile({
      adapterId: 'codex',
      name: 'Existing Provider',
      kind: 'reference',
      providerId: 'work_gateway'
    })
    const storedReference = context.db.getAiCliProfile(reference.id)
    const missingProviderContext = await harness({
      runtime: {
        currentProvider: 'openai',
        availableProviders: ['openai'],
        providerCatalog: [{ id: 'openai', displayName: 'OpenAI' }]
      }
    })
    try {
      missingProviderContext.db.insertAiCliProfile({
        ...storedReference
      })
      const sourcePath = codexProfileFiles.resolveCodexProfilePath(context.codexHomeA, storedReference.nativeProfileName)
      const targetPath = codexProfileFiles.resolveCodexProfilePath(
        missingProviderContext.codexHomeA,
        storedReference.nativeProfileName
      )
      writeFileSync(targetPath, readFileSync(sourcePath))
      assert.equal((await missingProviderContext.service.reconcileCodexProfiles()).profiles[0].status, 'missing_provider')
    } finally {
      missingProviderContext.close()
    }
  } finally {
    context.close()
  }

  const secretContext = await harness({ safeStorage: safeStorage({ decryptFails: true }) })
  try {
    secretContext.db.insertAiCliProfile({
      id: IDS[0],
      adapterId: 'codex',
      name: 'Secret Failure',
      kind: 'managed',
      nativeProfileName: codexProfileFiles.codexNativeProfileName(IDS[0]),
      providerId: 'ucli_550e8400e29b',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gpt-5.4',
      reasoningEffort: null,
      contextWindow: null,
      config: { wireApi: 'responses' },
      hasSecretHint: true,
      fileSha256: null,
      createdAt: 1,
      updatedAt: 1
    })
    secretContext.secretStore.setSecret(IDS[0], 'top-secret')
    await secretContext.service.repairProfile(IDS[0])
    assert.equal((await secretContext.service.reconcileCodexProfiles()).profiles[0].status, 'secret_unavailable')
  } finally {
    secretContext.close()
  }
})

test('reconcile recovers orphaned UCLI files and notices a configuration directory switch', async () => {
  const context = await harness()
  try {
    const orphan = managedDraft({ id: IDS[1], secret: undefined })
    const orphanProfile = {
      ...orphan,
      id: IDS[1],
      nativeProfileName: codexProfileFiles.codexNativeProfileName(IDS[1]),
      providerId: 'ucli_660e8400e29b'
    }
    codexProfileFiles.writeCodexProfileFileAtomic({
      codexHome: context.codexHomeA,
      profile: orphanProfile,
      expectedSha256: null
    })

    const report = await context.service.reconcileCodexProfiles()
    assert.deepEqual(report.recovered, [IDS[1]])
    assert.equal(context.db.getAiCliProfile(IDS[1]).config.recovered, true)
    assert.equal(report.profiles.find((profile) => profile.id === IDS[1]).status, 'secret_unavailable')

    context.setCodexHome(context.codexHomeB)
    assert.equal((await context.service.reconcileCodexProfiles()).profiles
      .find((profile) => profile.id === IDS[1]).status, 'missing_file')
  } finally {
    context.close()
  }
})

test('reconcile reports duplicate native names without choosing a winner', async () => {
  const service = createProfileService({
    db: {
      listAiCliProfiles: () => [
        { id: 'profile-a', adapterId: 'codex', nativeProfileName: 'ucli-duplicate' },
        { id: 'profile-b', adapterId: 'codex', nativeProfileName: 'ucli-duplicate' }
      ]
    },
    secretStore: {},
    resolveCodexHome: () => 'C:\\codex',
    readCodexRuntime: () => ({ availableProviders: ['openai'] }),
    fileOps: {},
    listFiles: () => []
  })

  const report = await service.reconcileCodexProfiles()
  assert.deepEqual(report.warnings, [{
    code: 'DUPLICATE_NATIVE_PROFILE_NAME',
    nativeProfileName: 'ucli-duplicate',
    profileIds: ['profile-a', 'profile-b']
  }])
})

test('reconcile refuses an orphan whose recovered config fails adapter validation', async () => {
  const context = await harness()
  try {
    const profileId = IDS[2]
    const nativeProfileName = codexProfileFiles.codexNativeProfileName(profileId)
    const path = codexProfileFiles.resolveCodexProfilePath(context.codexHomeA, nativeProfileName)
    writeFileSync(path, [
      `# ucli-profile-id: ${profileId}`,
      'model = "gpt-5 & calc.exe"',
      'model_provider = "../unsafe"',
      ''
    ].join('\n'))

    const report = await context.service.reconcileCodexProfiles()
    assert.equal(context.db.getAiCliProfile(profileId), null)
    assert.deepEqual(report.warnings, [{
      code: 'ORPHAN_PROFILE_INVALID',
      profileId
    }])
  } finally {
    context.close()
  }
})
