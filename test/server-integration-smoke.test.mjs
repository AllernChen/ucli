import assert from 'node:assert/strict'
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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

test('runs the authorised Device Grant Link v1 smoke flow', { skip: !smokeEnabled }, async () => {
  // Do not read the link environment variable until this explicitly enabled callback starts.
  const origin = process.env.UCLI_SERVER_ORIGIN
  const linkSecret = process.env.UCLI_SERVER_LINK
  let root
  let db
  let manager
  let proxy
  let catalog
  let primaryError = null
  let verifiedDownloads = 0
  const credentialCiphertexts = new Map()

  try {
    assert.equal(typeof origin === 'string' && /^https?:\/\/[^/?#]+$/i.test(origin), true, 'smoke origin is required')
    assert.equal(typeof linkSecret === 'string' && linkSecret.length > 0, true, 'smoke link is required')
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

    const attempt = await manager.submitLink(`${origin}/connect#link=${linkSecret}`)
    assert.equal(attempt.preview.link.status, 'AVAILABLE', 'the test link must be available')
    assert.equal(attempt.preview.authorization.status, 'AVAILABLE', 'the test authorization must be available')
    // This is the explicit test confirmation gate; no Redeem occurs before both statuses are verified.
    await manager.confirm(attempt.attemptId)

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

    await manager.getAccessToken({ minValidityMs: Number.MAX_SAFE_INTEGER })
    const bootstrap = await manager.getBootstrap({ force: true })
    proxy = createLocalGatewayProxy({ connectionManager: manager })
    await proxy.start()
    const session = proxy.createSession({ sessionId: 'smoke-model-session', ...manager.getRuntimeConnectionIdentity() })
    const models = await fetch(`${session.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${session.bearer}` } })
    assert.equal(models.ok, true, 'gateway models request failed')
    assert.ok((await models.json()).data?.length >= 1, 'gateway returned no models')
    const stream = await fetch(`${session.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: bootstrap.models[0].id, input: 'ping', stream: true }),
      duplex: 'half'
    })
    assert.equal(stream.ok, true, 'gateway model stream failed')
    assert.ok((await stream.arrayBuffer()).byteLength > 0, 'gateway model stream was empty')

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
      return { verified: true }
    }
    catalog = createSkillsCatalogAdapter({
      connectionManager: manager,
      db,
      stagingRoot: join(root, 'server-skills'),
      sourceLoader: Object.freeze({}),
      skillsService: { installVerifiedServerArchive: verifyDownloadedArchive }
    })
    const versions = await catalog.sync()
    assert.ok(versions.length > 0, 'Skills catalog returned no versions for smoke verification')
    await catalog.install(versions[0].versionId, { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
    assert.equal(verifiedDownloads, 1, 'Skills download verification did not run')
  } catch (error) {
    primaryError = error
    throw error
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
    if (root) {
      try { await rm(root, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    }
    if (!primaryError && cleanupErrors.length) throw new Error('smoke cleanup failed')
  }
})
