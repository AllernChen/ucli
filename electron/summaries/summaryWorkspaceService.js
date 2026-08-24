import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { assertSafeSummaryChild, resolveSummaryChild } from './summaryStoragePaths.js'

const DEFAULT_MAX_WORKSPACE_BYTES = 128 * 1024 * 1024
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ARTIFACT_ROOTS = new Set(['input', 'output', 'work'])
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/
const SAFE_STAGE = /^[a-z][a-z0-9-]{0,63}$/

function workspaceError(code) {
  return Object.assign(new Error(code), { code })
}

function timestamp(now) {
  return new Date(now()).toISOString()
}

function workspacePath(root, reportId) {
  return resolveSummaryChild(root, 'workspaces', reportId)
}

function artifactPath(workspace, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || path.isAbsolute(relativePath)) {
    throw workspaceError('SUMMARY_STORAGE_PATH_UNSAFE')
  }
  const segments = relativePath.split(/[\\/]+/)
  if (!ARTIFACT_ROOTS.has(segments[0]) || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw workspaceError('SUMMARY_STORAGE_PATH_UNSAFE')
  }
  return assertSafeSummaryChild(workspace, path.resolve(workspace, ...segments))
}

function storedArtifactPath(workspace, target) {
  return path.relative(workspace, target).split(path.sep).join('/')
}

async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function readManifest(workspace) {
  return JSON.parse(await readFile(path.join(workspace, 'manifest.json'), 'utf8'))
}

async function writeManifest(workspace, manifest) {
  await atomicWrite(
    path.join(workspace, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

function safeFailureCode(value, fallback) {
  const candidate = typeof value === 'string' ? value : value?.code
  return SAFE_ERROR_CODE.test(String(candidate || '')) ? candidate : fallback
}

function compactProgress(patch) {
  if (!patch || typeof patch !== 'object') return undefined
  const progress = {}
  for (const key of ['completed', 'total']) {
    if (Number.isSafeInteger(patch[key]) && patch[key] >= 0) progress[key] = patch[key]
  }
  return Object.keys(progress).length > 0 ? progress : undefined
}

export function createSummaryWorkspaceService({
  root,
  now = Date.now,
  maxWorkspaceBytes = DEFAULT_MAX_WORKSPACE_BYTES,
  failedRetentionMs = DEFAULT_FAILED_RETENTION_MS
} = {}) {
  if (!Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 1) {
    throw workspaceError('SUMMARY_WORKSPACE_LIMIT')
  }
  if (!Number.isSafeInteger(failedRetentionMs) || failedRetentionMs < 0) {
    throw workspaceError('SUMMARY_WORKSPACE_RETENTION_INVALID')
  }

  async function create(reportId) {
    const workspace = workspacePath(root, reportId)
    await mkdir(path.dirname(workspace), { recursive: true, mode: 0o700 })
    await mkdir(workspace, { mode: 0o700 })
    await Promise.all([
      mkdir(path.join(workspace, 'input'), { mode: 0o700 }),
      mkdir(path.join(workspace, 'output'), { mode: 0o700 }),
      mkdir(path.join(workspace, 'work'), { mode: 0o700 })
    ])
    const createdAt = timestamp(now)
    const manifest = {
      version: 1,
      reportId,
      status: 'running',
      stage: 'collecting',
      createdAt,
      updatedAt: createdAt,
      expiresAt: null,
      bytes: 0,
      artifacts: []
    }
    await writeManifest(workspace, manifest)
    return {
      id: reportId,
      path: workspace,
      workDirectory: path.join(workspace, 'work'),
      manifest
    }
  }

  async function writeArtifact(reportId, relativePath, content) {
    const workspace = workspacePath(root, reportId)
    const target = artifactPath(workspace, relativePath)
    const artifact = storedArtifactPath(workspace, target)
    const manifest = await readManifest(workspace)
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    const previous = manifest.artifacts.find(entry => entry.path === artifact)?.bytes || 0
    const nextBytes = manifest.bytes - previous + data.byteLength
    if (nextBytes > maxWorkspaceBytes) {
      throw workspaceError('SUMMARY_WORKSPACE_LIMIT')
    }

    await atomicWrite(target, data)
    manifest.bytes = nextBytes
    manifest.artifacts = [
      ...manifest.artifacts.filter(entry => entry.path !== artifact),
      { path: artifact, bytes: data.byteLength }
    ]
    manifest.updatedAt = timestamp(now)
    await writeManifest(workspace, manifest)
    return target
  }

  function resolveArtifact(reportId, relativePath) {
    if (relativePath !== 'output/report.md') {
      throw workspaceError('SUMMARY_STORAGE_PATH_UNSAFE')
    }
    return artifactPath(workspacePath(root, reportId), relativePath)
  }

  async function markStage(reportId, stage, patch) {
    if (!SAFE_STAGE.test(String(stage || ''))) {
      throw workspaceError('SUMMARY_WORKSPACE_STAGE_INVALID')
    }
    const workspace = workspacePath(root, reportId)
    const manifest = await readManifest(workspace)
    manifest.stage = stage
    const progress = compactProgress(patch)
    if (progress) manifest.progress = progress
    manifest.updatedAt = timestamp(now)
    await writeManifest(workspace, manifest)
    return manifest
  }

  async function complete(reportId, outputs = {}) {
    const workspace = workspacePath(root, reportId)
    if (typeof outputs.markdown === 'string') {
      await writeArtifact(reportId, 'output/summary.md', outputs.markdown)
    }
    await rm(artifactPath(workspace, 'input'), { recursive: true, force: true })
    await rm(artifactPath(workspace, 'work'), { recursive: true, force: true })

    const manifest = await readManifest(workspace)
    manifest.status = 'completed'
    manifest.stage = 'completed'
    manifest.expiresAt = null
    manifest.artifacts = manifest.artifacts.filter(entry => entry.path.startsWith('output/'))
    manifest.bytes = manifest.artifacts.reduce((total, entry) => total + entry.bytes, 0)
    manifest.updatedAt = timestamp(now)
    delete manifest.errorCode
    await writeManifest(workspace, manifest)
    return manifest
  }

  async function fail(reportId, code) {
    const workspace = workspacePath(root, reportId)
    const manifest = await readManifest(workspace)
    const failedAt = now()
    manifest.status = 'failed'
    manifest.errorCode = safeFailureCode(code, 'SUMMARY_WORKSPACE_FAILED')
    manifest.updatedAt = new Date(failedAt).toISOString()
    manifest.expiresAt = new Date(failedAt + failedRetentionMs).toISOString()
    await writeManifest(workspace, manifest)
    return manifest
  }

  async function remove(reportId) {
    const workspace = workspacePath(root, reportId)
    assertSafeSummaryChild(root, workspace)
    await rm(workspace, { recursive: true, force: true })
  }

  async function listWorkspaceIds() {
    const directory = path.join(root, 'workspaces')
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error?.code === 'ENOENT') return []
      throw error
    })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  }

  async function recover() {
    const result = { interrupted: 0, removed: 0 }
    const currentTime = now()
    for (const reportId of await listWorkspaceIds()) {
      let workspace
      try {
        workspace = workspacePath(root, reportId)
      } catch {
        continue
      }
      const manifest = await readManifest(workspace).catch(() => null)
      if (!manifest) continue
      if (manifest.status === 'running') {
        manifest.status = 'interrupted'
        manifest.errorCode = 'SUMMARY_WORKSPACE_INTERRUPTED'
        manifest.updatedAt = new Date(currentTime).toISOString()
        manifest.expiresAt = new Date(currentTime + failedRetentionMs).toISOString()
        await writeManifest(workspace, manifest)
        result.interrupted += 1
      } else if (
        ['failed', 'interrupted'].includes(manifest.status) &&
        typeof manifest.expiresAt === 'string' &&
        Date.parse(manifest.expiresAt) <= currentTime
      ) {
        await remove(reportId)
        result.removed += 1
      }
    }
    return result
  }

  async function usage({ includeFailedWorkspaces = false } = {}) {
    let bytes = 0
    let workspaces = 0
    let failedWorkspaces = 0
    for (const reportId of await listWorkspaceIds()) {
      try {
        const manifest = await readManifest(workspacePath(root, reportId))
        bytes += Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0 ? manifest.bytes : 0
        workspaces += 1
        if (['failed', 'interrupted'].includes(manifest.status)) failedWorkspaces += 1
      } catch {
        // Ignore untrusted or incomplete directory entries.
      }
    }
    return includeFailedWorkspaces
      ? { bytes, workspaces, failedWorkspaces }
      : { bytes, workspaces }
  }

  async function clearFailed() {
    let removed = 0
    for (const reportId of await listWorkspaceIds()) {
      try {
        const workspace = workspacePath(root, reportId)
        const manifest = await readManifest(workspace)
        if (!['failed', 'interrupted'].includes(manifest?.status)) continue
        await remove(reportId)
        removed += 1
      } catch {
        // Malformed, unsafe, or transient entries are retained.
      }
    }
    return { removed }
  }

  async function clearDerived({ isProtected = () => false } = {}) {
    if (typeof isProtected !== 'function') {
      throw workspaceError('SUMMARY_WORKSPACE_PROTECTION_CHECK_INVALID')
    }
    let removed = 0
    let bytes = 0
    for (const reportId of await listWorkspaceIds()) {
      try {
        const manifest = await readManifest(workspacePath(root, reportId))
        if (!['completed', 'failed', 'interrupted'].includes(manifest?.status)) continue
        if (await isProtected(reportId) !== false) continue
        const retainedBytes = Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0
          ? manifest.bytes
          : 0
        await remove(reportId)
        removed += 1
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + retainedBytes)
      } catch {
        // Protection lookup, corrupt state, unsafe entries, and I/O failures retain data.
      }
    }
    return { removed, bytes }
  }

  async function pruneExpired() {
    let removed = 0
    let bytes = 0
    const currentTime = now()
    for (const reportId of await listWorkspaceIds()) {
      try {
        const manifest = await readManifest(workspacePath(root, reportId))
        const expiresAt = Date.parse(manifest?.expiresAt)
        if (!['failed', 'interrupted'].includes(manifest?.status) ||
          typeof manifest.expiresAt !== 'string' || !Number.isFinite(expiresAt) ||
          expiresAt > currentTime) continue
        const retainedBytes = Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0 ? manifest.bytes : 0
        await remove(reportId)
        removed += 1
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + retainedBytes)
      } catch {
        // Unknown, corrupt, unsafe, or transient entries are retained.
      }
    }
    return { removed, bytes }
  }

  async function pruneOrphans({ isRetained, isProtected = () => false } = {}) {
    if (typeof isRetained !== 'function' || typeof isProtected !== 'function') {
      throw workspaceError('SUMMARY_WORKSPACE_RETENTION_CHECK_INVALID')
    }
    let checked = 0
    let removed = 0
    let bytes = 0
    for (const reportId of await listWorkspaceIds()) {
      try {
        const manifest = await readManifest(workspacePath(root, reportId))
        if (manifest?.status !== 'completed') continue
        checked += 1

        // Only explicit negative answers authorize deletion. Callback failures and
        // ambiguous values retain the derived workspace for a later maintenance run.
        if (await isProtected(reportId) !== false) continue
        if (await isRetained(reportId) !== false) continue

        const retainedBytes = Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0
          ? manifest.bytes
          : 0
        await remove(reportId)
        removed += 1
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + retainedBytes)
      } catch {
        // Corrupt state, lookup failures, and transient I/O errors fail closed.
      }
    }
    return { checked, removed, bytes }
  }

  async function pruneCompleted({ maxBytes, isProtected = () => false } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || typeof isProtected !== 'function') {
      throw Object.assign(new Error('Invalid workspace budget'), { code: 'SUMMARY_WORKSPACE_QUOTA_INVALID' })
    }
    const entries = []
    let bytes = 0
    for (const reportId of await listWorkspaceIds()) {
      try {
        const manifest = await readManifest(workspacePath(root, reportId))
        const entryBytes = Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0 ? manifest.bytes : 0
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + entryBytes)
        if (manifest.status === 'completed' && !isProtected(reportId)) {
          const updatedAt = Date.parse(manifest.updatedAt)
          if (Number.isFinite(updatedAt)) entries.push({ reportId, bytes: entryBytes, updatedAt })
        }
      } catch {
        // Corrupt, unknown, unsafe, and transient workspaces are retained.
      }
    }
    entries.sort((left, right) => left.updatedAt - right.updatedAt ||
      left.reportId.localeCompare(right.reportId))
    let removed = 0
    for (const entry of entries) {
      if (bytes <= maxBytes) break
      try {
        await remove(entry.reportId)
        bytes = Math.max(0, bytes - entry.bytes)
        removed += 1
      } catch {
        // A failed item cannot block later safe candidates.
      }
    }
    return { removed, bytes }
  }

  return {
    create, writeArtifact, resolveArtifact, markStage, complete, fail, recover, remove, usage,
    clearFailed, clearDerived, pruneExpired, pruneOrphans, pruneCompleted
  }
}
