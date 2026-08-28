import assert from 'node:assert/strict'
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PUBLIC_MODEL_PROTOCOLS,
  assertGatewayModelProtocolConsistency,
  gatewayResponseMetadata,
  parseGatewayModelsResponse,
  parseGatewayRouteFailure,
  selectModelForProtocol
} from '../electron/serverConnection/contracts.js'
import { modelStreamRequest, smokeFailure, smokeSuccessEvidence } from './helpers/serverIntegrationSmoke.mjs'

const smokeEnabled = process.env.UCLI_SERVER_SMOKE === '1'

async function assertSecretAbsent(root, secret) {
  const scan = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.isFile()) assert.equal((await readFile(path)).includes(Buffer.from(secret)), false, 'temporary smoke material contains the link secret')
    }
  }
  await scan(root)
}

test('runs the authorised Device Grant Link v1 smoke flow', { skip: !smokeEnabled }, async t => {
  // Do not read the link environment variable until this explicitly enabled callback starts.
  const origin = process.env.UCLI_SERVER_ORIGIN
  const selectedProtocol = process.env.UCLI_SERVER_SMOKE_PROTOCOL
  let linkSecret
  let root
  let db
  let manager
  let proxy
  let catalog
  let primaryError = null
  let failedStage = 'protocol-validation'
  let failureDiagnostic = gatewayResponseMetadata()
  let verifiedDownloads = 0
  const credentialCiphertexts = new Map()
  const evidence = {
    failedStage: null,
    selectedModelId: null,
    selectedProtocol,
    bootstrapModelCount: 0,
    invalidContextSizeCount: 0,
    authorizationExpiresAt: null,
    serverTimePresent: false,
    streamStatus: 'not-received',
    streamReceivedNonEmptyData: false,
    skillsCatalog: false,
    skillDownloadHash: false,
    tempDatabaseRemoved: false,
    environmentVariablesRemoved: false,
    smokeDirectoriesRemoved: false
  }

  try {
    assert.ok(PUBLIC_MODEL_PROTOCOLS.includes(selectedProtocol), 'an explicit public smoke protocol is required')
    failedStage = 'link-validation'
    linkSecret = process.env.UCLI_SERVER_LINK
    assert.equal(typeof origin === 'string' && /^https?:\/\/[^/?#]+$/i.test(origin), true, 'smoke origin is required')
    assert.equal(typeof linkSecret === 'string' && linkSecret.length > 0, true, 'smoke link is required')
    failedStage = 'temporary-root'
    root = await mkdtemp(join(tmpdir(), 'ucli-server-smoke-'))

    const [
      { openDb },
      { ServerCredentialStore },
      { RegistrationAttemptStore },
      { ConnectionManager },
      { createDeviceGrantClient },
      { createLocalGatewayProxy },
      { createSkillsCatalogAdapter }
    ] = await Promise.all([
      import('../electron/persistence/db.js'),
      import('../electron/serverConnection/credentialStore.js'),
      import('../electron/serverConnection/registrationAttempts.js'),
      import('../electron/serverConnection/connectionManager.js'),
      import('../electron/serverConnection/deviceGrantClient.js'),
      import('../electron/serverConnection/localGatewayProxy.js'),
      import('../electron/serverConnection/skillsCatalogAdapter.js')
    ])
    db = await openDb(join(root, 'ucli.db'))
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString(value) {
        const key = `smoke-${credentialCiphertexts.size + 1}`
        credentialCiphertexts.set(key, value)
        return Buffer.from(key)
      },
      decryptString(value) { return credentialCiphertexts.get(Buffer.from(value).toString('utf8')) }
    }
    const credentials = new ServerCredentialStore({ db, safeStorage })
    const client = createDeviceGrantClient()
    manager = new ConnectionManager({
      attempts: new RegistrationAttemptStore(),
      client,
      credentials,
      platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      deviceName: 'UCLI 0.12 smoke device'
    })

    failedStage = 'preview'
    const attempt = await manager.submitLink(`${origin}/connect#link=${linkSecret}`)
    assert.equal(attempt.preview.link.status, 'AVAILABLE', 'the test link must be available')
    assert.equal(attempt.preview.authorization.status, 'AVAILABLE', 'the test authorization must be available')
    // This is the explicit test confirmation gate; no Redeem occurs before both statuses are verified.
    failedStage = 'redeem-first'
    await manager.confirm(attempt.attemptId)

    failedStage = 'redeem-idempotent'
    const installation = await credentials.getOrCreateInstallation({ deviceName: 'UCLI 0.12 smoke device' })
    const retry = await client.redeem({
      serverOrigin: origin,
      linkSecret,
      device: {
        installationId: installation.installationId,
        name: installation.deviceName,
        platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
        clientVersion: '0.12.0'
      }
    })
    const updated = await credentials.replaceRefreshToken({
      connectionId: manager.current.id,
      refreshToken: retry.refreshToken,
      authorization: retry.authorization
    })
    manager.current = updated
    manager.installAccessToken(retry.accessToken, retry.expiresIn)

    failedStage = 'refresh-forced'
    await manager.getAccessToken({ minValidityMs: Number.MAX_SAFE_INTEGER })
    failedStage = 'bootstrap'
    const bootstrap = await manager.getBootstrap({ force: true })
    evidence.bootstrapModelCount = bootstrap.models.length
    evidence.invalidContextSizeCount = bootstrap.models.filter(model => !Number.isSafeInteger(model.contextSize) || model.contextSize <= 0).length
    evidence.authorizationExpiresAt = bootstrap.authorization.expiresAt
    evidence.serverTimePresent = typeof bootstrap.authorization.serverTime === 'string'
    failedStage = 'local-proxy'
    proxy = createLocalGatewayProxy({ connectionManager: manager })
    await proxy.start()
    const session = proxy.createSession({ sessionId: 'smoke-model-session', ...manager.getRuntimeConnectionIdentity() })
    failedStage = 'gateway-models'
    const modelsResponse = await fetch(`${session.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${session.bearer}` }
    })
    failureDiagnostic = gatewayResponseMetadata(modelsResponse)
    assert.equal(modelsResponse.ok, true, 'gateway models request failed')
    const gatewayModels = parseGatewayModelsResponse(await modelsResponse.json()).data
    const selectedModel = selectModelForProtocol(bootstrap.models, selectedProtocol)
    assert.ok(selectedModel, 'no compatible server model')
    assertGatewayModelProtocolConsistency({
      bootstrapModels: bootstrap.models,
      gatewayModels,
      modelId: selectedModel.id,
      protocol: selectedProtocol
    })
    evidence.selectedModelId = selectedModel.id
    const request = modelStreamRequest(selectedProtocol, selectedModel.id)
    failedStage = 'model-stream'
    const stream = await fetch(`${session.baseUrl}${request.path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.bearer}`, 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      duplex: 'half'
    })
    let diagnostic = gatewayResponseMetadata(stream)
    failureDiagnostic = diagnostic
    evidence.streamStatus = stream.status
    if (!stream.ok) {
      let body = null
      try { body = await stream.json() } catch {}
      if (stream.status === 503) {
        try {
          diagnostic = parseGatewayRouteFailure({ status: stream.status, headers: stream.headers, body })
        } catch (error) {
          diagnostic = error?.diagnostic || diagnostic
        }
      }
      failureDiagnostic = diagnostic
      throw Object.assign(new Error('Gateway model stream failed'), {
        code: 'SMOKE_MODEL_STREAM_FAILED',
        diagnostic
      })
    }
    const streamBytes = (await stream.arrayBuffer()).byteLength
    assert.ok(streamBytes > 0, 'gateway model stream was empty')
    evidence.streamReceivedNonEmptyData = true

    // The smoke verifies the live catalog/download/hash boundary only. This
    // seam receives the adapter's verified archive but deliberately performs
    // no Skills installation or mutation.
    const verifyDownloadedArchive = async ({ archivePath, archiveIdentity, source, targets, guard }) => {
      guard()
      const [archive, stat] = await Promise.all([readFile(archivePath), lstat(archivePath)])
      assert.equal(stat.isFile(), true, 'adapter did not provide a regular archive')
      assert.equal(stat.size, archiveIdentity.size, 'adapter archive identity size mismatch')
      assert.equal(stat.ino, archiveIdentity.ino, 'adapter archive identity inode mismatch')
      assert.equal(stat.dev, archiveIdentity.dev, 'adapter archive identity device mismatch')
      assert.equal(createHash('sha256').update(archive).digest('hex'), source.sha256, 'adapter archive hash mismatch')
      assert.deepEqual(targets, { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
      verifiedDownloads += 1
      evidence.skillDownloadHash = true
      return { verified: true }
    }
    failedStage = 'skills-catalog'
    catalog = createSkillsCatalogAdapter({
      connectionManager: manager,
      db,
      stagingRoot: join(root, 'server-skills'),
      sourceLoader: Object.freeze({}),
      skillsService: { installVerifiedServerArchive: verifyDownloadedArchive }
    })
    const versions = await catalog.sync()
    assert.ok(versions.length > 0, 'Skills catalog returned no versions for smoke verification')
    evidence.skillsCatalog = true
    failedStage = 'skills-download'
    await catalog.install(versions[0].versionId, { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
    assert.equal(verifiedDownloads, 1, 'Skills download verification did not run')
  } catch (error) {
    evidence.failedStage = failedStage
    primaryError = smokeFailure({ primaryError: { failedStage }, diagnostic: failureDiagnostic })
    throw primaryError
  } finally {
    const cleanupErrors = []
    for (const cleanup of [
      () => catalog?.shutdown(),
      () => proxy?.shutdown(),
      () => manager?.disconnect(),
      () => manager?.shutdown()
    ]) {
      try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    credentialCiphertexts.clear()
    if (root && linkSecret) {
      try { await assertSecretAbsent(root, linkSecret) } catch (error) { cleanupErrors.push(error) }
    }
    try { db?.close() } catch (error) { cleanupErrors.push(error) }
    delete process.env.UCLI_SERVER_LINK
    evidence.environmentVariablesRemoved = true
    if (root) {
      try {
        await rm(root, { recursive: true, force: true })
        evidence.tempDatabaseRemoved = true
        evidence.smokeDirectoriesRemoved = true
      } catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length) {
      throw smokeFailure({ primaryError, cleanupErrors, diagnostic: failureDiagnostic })
    }
    if (!primaryError && cleanupErrors.length === 0) {
      t.diagnostic(JSON.stringify(smokeSuccessEvidence({
        evidence,
        diagnostic: failureDiagnostic,
        cleanupComplete: true
      })))
    }
  }
})
