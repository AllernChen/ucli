import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, join, resolve, relative, isAbsolute } from 'node:path'

import { parseSkillsCatalogPage } from './contracts.js'

const CONTROL_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
const MAX_STAGING_BYTES = 100 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/i

function adapterError(code, message = 'Server Skill operation failed') {
  return Object.assign(new Error(message), { code })
}

function strictUrl(value, origin, pathname, { cursor = null } = {}) {
  let url
  try { url = new URL(value) } catch { throw adapterError('SERVER_SKILL_URL_INVALID') }
  if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== pathname) {
    throw adapterError('SERVER_SKILL_URL_INVALID')
  }
  const expected = cursor == null ? '' : `cursor=${encodeURIComponent(cursor)}`
  if (url.search.replace(/^\?/, '') !== expected) throw adapterError('SERVER_SKILL_URL_INVALID')
  return url
}

function lifecycle(items) {
  if (!Array.isArray(items)) throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
  const values = new Map()
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.id !== 'string' || !item.id || typeof item.version !== 'string' || !item.version ||
      !['REVOKED', 'DEPRECATED'].includes(item.status) || !item.skill || typeof item.skill.slug !== 'string' || !item.skill.slug ||
      typeof item.skill.name !== 'string' || !item.skill.name) {
      throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
    }
    if (values.has(item.id)) throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
    values.set(item.id, item.status)
  }
  return values
}

function isWithin(root, path) {
  const difference = relative(root, path)
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(left) === normalize(right)
}

function identityOf(connectionManager) {
  const identity = connectionManager.getRuntimeConnectionIdentity?.()
  const state = connectionManager.getState?.() || {}
  const serverOrigin = state.serverOrigin
  const organizationId = state.organization?.id
  if (!identity || typeof identity.connectionId !== 'string' || !Number.isSafeInteger(identity.connectionRevision) ||
    typeof serverOrigin !== 'string' || typeof organizationId !== 'string' || !organizationId) return null
  return Object.freeze({ ...identity, serverOrigin, organizationId })
}

export function createSkillsCatalogAdapter({ connectionManager, db, fetchImpl = globalThis.fetch, stagingRoot, sourceLoader, skillsService }) {
  if (!connectionManager || !db || typeof fetchImpl !== 'function' || !stagingRoot || !sourceLoader || !skillsService) {
    throw new TypeError('Server Skills catalog dependencies are required')
  }
  const stagingParent = resolve(stagingRoot)
  const root = join(stagingParent, `.ucli-server-skills-${randomUUID()}`)
  const activeControllers = new Set()
  const ownedFiles = new Set()
  let closing = false
  let syncFlight = null
  const activeWork = new Set()
  const track = (promise) => {
    activeWork.add(promise)
    promise.finally(() => activeWork.delete(promise)).catch(() => {})
    return promise
  }
  let rootRealPath = null

  const ensurePrivateRoot = async () => {
    await mkdir(stagingParent, { recursive: true })
    const parent = await lstat(stagingParent)
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw adapterError('SERVER_SKILL_STAGING_INVALID')
    const parentReal = await realpath(stagingParent)
    await mkdir(root, { recursive: true })
    const stat = await lstat(root)
    const actual = await realpath(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(parentReal, actual)) throw adapterError('SERVER_SKILL_STAGING_INVALID')
    rootRealPath = actual
    return actual
  }
  const assertPrivateRoot = async () => {
    if (!rootRealPath) return ensurePrivateRoot()
    const stat = await lstat(root)
    const actual = await realpath(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(actual, rootRealPath)) throw adapterError('SERVER_SKILL_STAGING_INVALID')
    return actual
  }

  const assertCurrent = (identity) => {
    const next = identityOf(connectionManager)
    if (!next || next.connectionId !== identity.connectionId || next.connectionRevision !== identity.connectionRevision ||
      next.serverOrigin !== identity.serverOrigin || next.organizationId !== identity.organizationId) {
      throw adapterError('SERVER_SKILL_STALE')
    }
  }
  const assertOpen = () => {
    if (closing) throw adapterError('SERVER_SKILL_SHUTDOWN')
  }
  const guardFor = identity => () => { assertOpen(); assertCurrent(identity) }
  const request = async (url, identity, timeoutMs, { keepOpen = false } = {}) => {
    assertOpen(); assertCurrent(identity)
    const controller = new AbortController()
    activeControllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let release = null
    try {
      const token = await connectionManager.getAccessToken()
      assertOpen(); assertCurrent(identity)
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, application/zip' }
      })
      assertOpen(); assertCurrent(identity)
      if (response.status >= 300 && response.status < 400) throw adapterError('SERVER_SKILL_REDIRECT_REJECTED')
      if (!response.ok) throw adapterError('SERVER_SKILL_FETCH_FAILED')
      release = () => {
        clearTimeout(timeout)
        activeControllers.delete(controller)
      }
      return keepOpen ? { response, release } : response
    } catch (error) {
      if (error?.code?.startsWith('SERVER_SKILL_')) throw error
      if (controller.signal.aborted) throw adapterError(closing ? 'SERVER_SKILL_SHUTDOWN' : 'SERVER_SKILL_TIMEOUT')
      throw adapterError('SERVER_SKILL_FETCH_FAILED')
    } finally {
      if (!release) {
        clearTimeout(timeout)
        activeControllers.delete(controller)
      } else if (!keepOpen) {
        release()
      }
    }
  }
  const readJson = async (url, identity) => {
    const transfer = await request(url, identity, CONTROL_TIMEOUT_MS, { keepOpen: true })
    try {
      const value = await transfer.response.json()
      assertOpen(); assertCurrent(identity)
      return value
    } catch (error) {
      if (error?.code?.startsWith('SERVER_SKILL_')) throw error
      if (transfer.response.bodyUsed && closing) throw adapterError('SERVER_SKILL_SHUTDOWN')
      throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
    } finally {
      transfer.release()
    }
  }
  const clearOnline = async () => {
    if (!db.clearServerSkillVersions) return
    await db.transaction(() => db.clearServerSkillVersions())
    if (db.flush && await db.flush() === false) throw adapterError('SERVER_SKILL_PERSISTENCE_PENDING')
  }
  const catalogUrl = (bootstrap, identity, cursor = null) => {
    const base = strictUrl(bootstrap.skillsCatalogUrl, identity.serverOrigin, '/api/v1/skills/catalog')
    if (cursor == null) return base.toString()
    return strictUrl(`${base.origin}${base.pathname}?cursor=${encodeURIComponent(cursor)}`, identity.serverOrigin, base.pathname, { cursor }).toString()
  }
  const getBootstrap = async (identity) => {
    const bootstrap = await connectionManager.getBootstrap()
    assertCurrent(identity)
    if (!bootstrap || typeof bootstrap.skillsCatalogUrl !== 'string' || bootstrap.organization?.id !== identity.organizationId) {
      throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
    }
    return bootstrap
  }

  async function sync() {
    if (syncFlight) return syncFlight
    const work = (async () => {
      assertOpen()
      const identity = identityOf(connectionManager)
      if (!identity) { await clearOnline(); return [] }
      const bootstrap = await getBootstrap(identity)
      const versions = []
      const versionIds = new Set()
      const pageIds = new Set()
      let cursor = null
      let previousTime = -Infinity
      for (;;) {
        const value = await readJson(catalogUrl(bootstrap, identity, cursor), identity)
        const page = parseSkillsCatalogPage(value, { serverOrigin: identity.serverOrigin })
        const signature = JSON.stringify(page.map(item => [item.id, item.createdAt]))
        if (pageIds.has(signature)) throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
        pageIds.add(signature)
        for (const item of page) {
          const created = Date.parse(item.createdAt)
          const expectedPath = `/api/v1/skills/${encodeURIComponent(item.id)}/download`
          strictUrl(item.downloadUrl, identity.serverOrigin, expectedPath)
          if (!Number.isFinite(created) || created <= previousTime || versionIds.has(item.id)) {
            throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
          }
          previousTime = created
          versionIds.add(item.id)
          versions.push(item)
        }
        if (page.length < 100) break
        const nextCursor = page.at(-1)?.createdAt
        if (!nextCursor || nextCursor === cursor) throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
        cursor = nextCursor
      }
      let revocations
      try { revocations = lifecycle(await readJson(`${identity.serverOrigin}/api/v1/skills/revocations`, identity)) } catch (error) {
        if (error?.code) throw error
        throw adapterError('SERVER_SKILL_RESPONSE_INVALID')
      }
      assertCurrent(identity)
      const persisted = versions.map(item => ({
        versionId: item.id, serverOrigin: identity.serverOrigin, organizationId: identity.organizationId,
        slug: item.skill.slug, version: item.version, name: item.skill.name, description: item.skill.description,
        sha256: item.sha256, sizeBytes: item.sizeBytes, publishedAt: item.publishedAt, createdAt: item.createdAt,
        downloadUrl: item.downloadUrl, lifecycleStatus: revocations.get(item.id) || 'ACTIVE',
        connectionRevision: identity.connectionRevision
      }))
      const guard = guardFor(identity)
      guard()
      await db.transaction(() => { guard(); db.replaceServerSkillVersions({ connectionRevision: identity.connectionRevision, versions: persisted }); guard() })
      guard()
      if (db.flush && await db.flush() === false) throw adapterError('SERVER_SKILL_PERSISTENCE_PENDING')
      guard()
      return list()
    })()
    const flight = work.finally(() => { if (syncFlight === flight) syncFlight = null })
    syncFlight = flight
    return flight
  }

  function list() {
    const identity = identityOf(connectionManager)
    if (!identity || !db.listServerSkillVersions) return []
    return db.listServerSkillVersions().filter(item => item.serverOrigin === identity.serverOrigin &&
      item.organizationId === identity.organizationId && item.connectionRevision === identity.connectionRevision)
  }

  async function stagingUsage() {
    try {
      await assertPrivateRoot()
      const entries = await readdir(root, { withFileTypes: true })
      let bytes = 0
      for (const entry of entries) {
        if (!entry.isFile() || !ownedFiles.has(resolve(root, entry.name))) continue
        bytes += Number((await lstat(resolve(root, entry.name))).size)
      }
      return bytes
    } catch { return 0 }
  }
  async function removeStaged(path) {
    const resolved = resolve(path)
    if (!ownedFiles.has(resolved) || !isWithin(root, resolved) || basename(resolved) !== basename(path)) return
    ownedFiles.delete(resolved)
    try {
      await assertPrivateRoot()
      const stat = await lstat(resolved)
      if (stat.isFile() && !stat.isSymbolicLink()) await rm(resolved, { force: true })
    } catch { /* staged cleanup is best effort */ }
  }
  async function download(version, identity) {
    strictUrl(version.downloadUrl, identity.serverOrigin, `/api/v1/skills/${encodeURIComponent(version.versionId)}/download`)
    await ensurePrivateRoot()
    if ((await stagingUsage()) + version.sizeBytes > MAX_STAGING_BYTES || version.sizeBytes > MAX_DOWNLOAD_BYTES) {
      throw adapterError('SERVER_SKILL_QUOTA_EXCEEDED')
    }
    const path = resolve(root, `${randomUUID()}.zip`)
    if (!isWithin(root, path)) throw adapterError('SERVER_SKILL_STAGING_INVALID')
    ownedFiles.add(path)
    let handle
    let transfer = null
    try {
      await assertPrivateRoot()
      handle = await open(path, 'wx')
      transfer = await request(version.downloadUrl, identity, DOWNLOAD_TIMEOUT_MS, { keepOpen: true })
      const response = transfer.response
      const type = response.headers.get('content-type') || ''
      const contentLength = response.headers.get('content-length')
      const responseSha = (response.headers.get('x-ucli-sha256') || '').trim().toLowerCase()
      if (!/^application\/zip(?:;|$)/i.test(type) || !SHA256.test(responseSha) ||
        (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== version.sizeBytes))) {
        throw adapterError('SERVER_SKILL_DOWNLOAD_INVALID')
      }
      if (!response.body) throw adapterError('SERVER_SKILL_DOWNLOAD_INVALID')
      let size = 0
      const hash = createHash('sha256')
      for await (const chunk of response.body) {
        assertOpen(); assertCurrent(identity)
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > version.sizeBytes || size > MAX_DOWNLOAD_BYTES) throw adapterError('SERVER_SKILL_QUOTA_EXCEEDED')
        hash.update(bytes)
        await handle.write(bytes)
      }
      const actualSha = hash.digest('hex')
      assertCurrent(identity)
      if (size !== version.sizeBytes || actualSha !== version.sha256 || actualSha !== responseSha) {
        throw adapterError('SERVER_SKILL_INTEGRITY_INVALID')
      }
      const stat = await handle.stat()
      const named = await lstat(path)
      if (!stat.isFile() || named.isSymbolicLink() || stat.size !== size || named.size !== size ||
        stat.ino !== named.ino || stat.dev !== named.dev) throw adapterError('SERVER_SKILL_STAGING_INVALID')
      return { path, identity: { size: stat.size, ino: stat.ino, dev: stat.dev } }
    } catch (error) {
      await removeStaged(path)
      throw error
    } finally {
      transfer?.release()
      await handle?.close()
    }
  }
  function sourceForVersion(version, identity) {
    return {
      locator: `${identity.serverOrigin}/organizations/${encodeURIComponent(identity.organizationId)}/skills/${encodeURIComponent(version.slug)}`,
      versionId: version.versionId, serverOrigin: identity.serverOrigin, organizationId: identity.organizationId,
      slug: version.slug, version: version.version, sha256: version.sha256
    }
  }
  async function installOnce(versionId, targets) {
    assertOpen()
    const identity = identityOf(connectionManager)
    if (!identity) throw adapterError('SERVER_SKILL_STALE')
    const version = list().find(item => item.versionId === versionId)
    if (!version) throw adapterError('SERVER_SKILL_NOT_FOUND')
    if (version.lifecycleStatus === 'REVOKED') throw adapterError('SERVER_SKILL_REVOKED')
    const archive = await download(version, identity)
    try {
      const guard = guardFor(identity)
      guard()
      const result = await skillsService.installVerifiedServerArchive({
        archivePath: archive.path,
        archiveIdentity: archive.identity,
        source: sourceForVersion(version, identity),
        targets,
        guard
      })
      guard()
      return result
    } finally {
      await removeStaged(archive.path)
    }
  }
  function install(versionId, targets) { return track(installOnce(versionId, targets)) }
  async function updateOnce(versionId, targets) {
    assertOpen()
    const identity = identityOf(connectionManager)
    if (!identity) throw adapterError('SERVER_SKILL_STALE')
    const version = list().find(item => item.versionId === versionId)
    if (!version) throw adapterError('SERVER_SKILL_NOT_FOUND')
    if (version.lifecycleStatus === 'REVOKED') throw adapterError('SERVER_SKILL_REVOKED')
    const mappings = db.listServerSkillPackagesForSkill?.({
      serverOrigin: identity.serverOrigin, organizationId: identity.organizationId, slug: version.slug
    }) || []
    if (!mappings.length) return installOnce(versionId, targets)
    const archive = await download(version, identity)
    try {
      const guard = guardFor(identity)
      const results = []
      for (const mapping of mappings) {
        guard()
        try {
          results.push(await skillsService.updateVerifiedServerArchive({
            packageId: mapping.packageId, archivePath: archive.path, archiveIdentity: archive.identity,
            source: sourceForVersion(version, identity), targets, guard
          }))
        } catch (error) {
          if (error?.code !== 'SKILL_PACKAGE_NOT_FOUND') throw error
        }
      }
      if (!results.length) return await installOnce(versionId, targets)
      guard()
      return results.length === 1 ? results[0] : results
    } finally {
      await removeStaged(archive.path)
    }
  }
  function update(versionId, targets) { return track(updateOnce(versionId, targets)) }
  async function shutdown() {
    closing = true
    for (const controller of activeControllers) controller.abort()
    await Promise.allSettled([syncFlight, ...activeWork].filter(Boolean))
    for (const file of [...ownedFiles]) await removeStaged(file)
    try {
      await assertPrivateRoot()
      await rm(root, { recursive: true, force: true })
      rootRealPath = null
    } catch { /* never follow a substituted staging root during shutdown */ }
  }

  const unsubscribe = connectionManager.subscribe?.(() => {
    if (!identityOf(connectionManager)) void clearOnline().catch(() => {})
  })
  return { sync, list, install, update, shutdown: async () => { unsubscribe?.(); await shutdown() } }
}
