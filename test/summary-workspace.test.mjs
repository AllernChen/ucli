import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { createSummaryWorkspaceService } from '../electron/summaries/summaryWorkspaceService.js'

const DAY_MS = 24 * 60 * 60 * 1000

async function withWorkspace(t, options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ucli-summary-workspace-test-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const root = join(temporaryRoot, 'summary')
  return {
    root,
    temporaryRoot,
    service: createSummaryWorkspaceService({ root, ...options })
  }
}

async function readManifest(workspacePath) {
  return JSON.parse(await readFile(join(workspacePath, 'manifest.json'), 'utf8'))
}

async function findTemporaryFiles(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await findTemporaryFiles(candidate))
    else if (entry.name.includes('.tmp-')) found.push(candidate)
  }
  return found
}

test('creates a compact running manifest without leaking local paths', async t => {
  const { root, service } = await withWorkspace(t, {
    now: () => Date.parse('2026-08-12T01:02:03.000Z')
  })

  const workspace = await service.create('report-1')

  assert.equal(workspace.path, join(root, 'workspaces', 'report-1'))
  assert.equal(workspace.workDirectory, join(root, 'workspaces', 'report-1', 'work'))
  assert.deepEqual(workspace.manifest, {
    version: 1,
    reportId: 'report-1',
    status: 'running',
    stage: 'collecting',
    createdAt: '2026-08-12T01:02:03.000Z',
    updatedAt: '2026-08-12T01:02:03.000Z',
    expiresAt: null,
    bytes: 0,
    artifacts: []
  })
  const serialized = JSON.stringify(await readManifest(workspace.path))
  assert.equal(serialized.includes(temporaryPathFragment(root)), false)
})

test('atomically replaces artifacts without leaving temporary files', async t => {
  const { service } = await withWorkspace(t)
  const workspace = await service.create('report-atomic')

  await service.writeArtifact('report-atomic', 'input/project.md', 'old')
  await service.writeArtifact('report-atomic', 'input/project.md', 'replacement')

  assert.equal(
    await readFile(join(workspace.path, 'input', 'project.md'), 'utf8'),
    'replacement'
  )
  assert.deepEqual(await findTemporaryFiles(workspace.path), [])
  assert.equal((await readManifest(workspace.path)).bytes, 11)
})

test('rejects an artifact before it crosses the injected workspace limit', async t => {
  const { service } = await withWorkspace(t, { maxWorkspaceBytes: 12 })
  const workspace = await service.create('report-limited')
  await service.writeArtifact('report-limited', 'input/first.txt', '12345678')

  await assert.rejects(
    service.writeArtifact('report-limited', 'input/second.txt', '12345'),
    error => error?.code === 'SUMMARY_WORKSPACE_LIMIT'
  )

  assert.equal(existsSync(join(workspace.path, 'input', 'second.txt')), false)
  assert.equal((await readManifest(workspace.path)).bytes, 8)
})

test('completion compacts inputs and work while retaining output and manifest', async t => {
  const { service } = await withWorkspace(t)
  const workspace = await service.create('report-complete')
  await service.writeArtifact('report-complete', 'input/project-a.md', 'redacted evidence')
  await service.writeArtifact('report-complete', 'work/map-prompt.txt', 'bounded prompt')
  await service.markStage('report-complete', 'mapping', { completed: 1, total: 2 })

  await service.complete('report-complete', { markdown: '# Report' })

  assert.equal(existsSync(join(workspace.path, 'input')), false)
  assert.equal(existsSync(join(workspace.path, 'work')), false)
  assert.equal(await readFile(join(workspace.path, 'output', 'summary.md'), 'utf8'), '# Report')
  const manifest = await readManifest(workspace.path)
  assert.equal(manifest.status, 'completed')
  assert.equal(manifest.stage, 'completed')
  assert.deepEqual(manifest.progress, { completed: 1, total: 2 })
  assert.equal(manifest.bytes, 8)
  assert.deepEqual(manifest.artifacts, [{ path: 'output/summary.md', bytes: 8 }])
})

test('failure retains bounded inputs for seven days without persisting secrets', async t => {
  let currentTime = Date.parse('2026-08-12T00:00:00.000Z')
  const { service } = await withWorkspace(t, {
    now: () => currentTime,
    failedRetentionMs: 7 * DAY_MS
  })
  const workspace = await service.create('report-failed')
  await service.writeArtifact('report-failed', 'input/evidence.md', 'safe evidence')

  await service.fail(
    'report-failed',
    Object.assign(new Error('token=super-secret at C:\\private\\project'), {
      code: 'SUMMARY_RUNNER_EXIT'
    })
  )

  const manifest = await readManifest(workspace.path)
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.errorCode, 'SUMMARY_RUNNER_EXIT')
  assert.equal(manifest.expiresAt, '2026-08-19T00:00:00.000Z')
  const serialized = JSON.stringify(manifest)
  assert.equal(serialized.includes('super-secret'), false)
  assert.equal(serialized.includes('private'), false)
  assert.equal(existsSync(join(workspace.path, 'input', 'evidence.md')), true)
})

test('recovery interrupts running work and removes expired failed workspaces', async t => {
  let currentTime = Date.parse('2026-08-01T00:00:00.000Z')
  const { service } = await withWorkspace(t, {
    now: () => currentTime,
    failedRetentionMs: 7 * DAY_MS
  })
  const running = await service.create('report-running')
  const expired = await service.create('report-expired')
  await service.fail('report-expired', 'SUMMARY_RUNNER_EXIT')

  currentTime = Date.parse('2026-08-09T00:00:00.000Z')
  const result = await service.recover()

  const recovered = await readManifest(running.path)
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.errorCode, 'SUMMARY_WORKSPACE_INTERRUPTED')
  assert.equal(recovered.expiresAt, '2026-08-16T00:00:00.000Z')
  assert.equal(existsSync(expired.path), false)
  assert.deepEqual(result, { interrupted: 1, removed: 1 })
})

test('safe removal rejects traversal and never deletes a sibling directory', async t => {
  const { root, temporaryRoot, service } = await withWorkspace(t)
  const sibling = join(temporaryRoot, `${basename(root)}-escape`)
  await mkdir(sibling, { recursive: true })
  await writeFile(join(sibling, 'keep.txt'), 'keep')

  await assert.rejects(
    service.remove('../summary-escape'),
    error => error?.code === 'SUMMARY_STORAGE_PATH_UNSAFE'
  )

  assert.equal(await readFile(join(sibling, 'keep.txt'), 'utf8'), 'keep')
})

test('usage reports retained artifact bytes and workspace count', async t => {
  const { service } = await withWorkspace(t)
  await service.create('report-usage-1')
  await service.writeArtifact('report-usage-1', 'input/a.txt', '1234')
  await service.create('report-usage-2')
  await service.writeArtifact('report-usage-2', 'output/b.txt', '12')

  assert.deepEqual(await service.usage(), { bytes: 6, workspaces: 2 })
  await service.fail('report-usage-1', 'SUMMARY_RUNNER_EXIT')
  assert.deepEqual(await service.usage({ includeFailedWorkspaces: true }), {
    bytes: 6, workspaces: 2, failedWorkspaces: 1
  })
})

test('clearFailed removes only failed and interrupted workspaces and skips malformed manifests', async t => {
  const { root, service } = await withWorkspace(t)
  const failed = await service.create('report-failed-clear')
  await service.fail('report-failed-clear', 'SUMMARY_RUNNER_EXIT')
  const interrupted = await service.create('report-interrupted-clear')
  await service.recover()
  const completed = await service.create('report-completed-keep')
  await service.complete('report-completed-keep', { markdown: 'keep' })
  const running = await service.create('report-running-keep')
  const malformed = await service.create('report-malformed-keep')
  await writeFile(join(malformed.path, 'manifest.json'), '{broken')
  const unknown = await service.create('report-unknown-keep')
  const unknownManifest = await readManifest(unknown.path)
  await writeFile(join(unknown.path, 'manifest.json'), JSON.stringify({ ...unknownManifest, status: 'other' }))

  assert.deepEqual(await service.clearFailed(), { removed: 2 })
  assert.equal(existsSync(failed.path), false)
  assert.equal(existsSync(interrupted.path), false)
  for (const workspace of [completed, running, malformed, unknown]) {
    assert.equal(existsSync(workspace.path), true)
  }
  assert.equal(existsSync(join(root, 'workspaces')), true)
})

test('clearDerived removes inactive derived workspaces and protects running and active reports', async t => {
  const { service } = await withWorkspace(t)
  const completed = await service.create('report-completed-clear')
  await service.complete(completed.id, { markdown: '1234' })
  const failed = await service.create('report-failed-derived-clear')
  await service.writeArtifact(failed.id, 'input/evidence.txt', '12')
  await service.fail(failed.id, 'SUMMARY_FAILED')
  const interrupted = await service.create('report-interrupted-derived-clear')
  await service.writeArtifact(interrupted.id, 'input/evidence.txt', '123')
  await service.recover()
  const running = await service.create('report-running-derived-keep')
  const active = await service.create('report-active-derived-keep')
  await service.complete(active.id, { markdown: 'keep' })

  assert.deepEqual(await service.clearDerived({
    isProtected: reportId => reportId === active.id
  }), { removed: 3, bytes: 9 })
  for (const workspace of [completed, failed, interrupted]) {
    assert.equal(existsSync(workspace.path), false)
  }
  for (const workspace of [running, active]) {
    assert.equal(existsSync(workspace.path), true)
  }
})

test('pruneExpired removes only expired failed workspaces and reports bounded bytes', async t => {
  let currentTime = Date.parse('2026-08-12T00:00:00.000Z')
  const { service } = await withWorkspace(t, { now: () => currentTime, failedRetentionMs: 1000 })
  const expired = await service.create('report-expired-prune')
  await service.writeArtifact(expired.id, 'input/evidence.json', '12345')
  await service.fail(expired.id, 'SUMMARY_FAILED')
  const current = await service.create('report-current-prune')
  await service.fail(current.id, 'SUMMARY_FAILED')
  const running = await service.create('report-running-safe')
  const completed = await service.create('report-completed-safe')
  await service.complete(completed.id, { markdown: 'done' })
  const invalidExpiry = await service.create('report-invalid-expiry-safe')
  await service.fail(invalidExpiry.id, 'SUMMARY_FAILED')
  const invalidManifest = await readManifest(invalidExpiry.path)
  await writeFile(join(invalidExpiry.path, 'manifest.json'), JSON.stringify({
    ...invalidManifest,
    expiresAt: 'not-a-date'
  }))

  currentTime += 1001
  const result = await service.pruneExpired()
  assert.deepEqual(result, { removed: 2, bytes: 5 })
  assert.equal(existsSync(expired.path), false)
  assert.equal(existsSync(current.path), false)
  assert.equal(existsSync(running.path), true)
  assert.equal(existsSync(completed.path), true)
  assert.equal(existsSync(invalidExpiry.path), true)
})

test('pruneCompleted uses stable LRU until the shared budget and protects active workspaces', async t => {
  let currentTime = Date.parse('2026-08-12T00:00:00.000Z')
  const { service } = await withWorkspace(t, { now: () => currentTime })
  const oldest = await service.create('report-completed-a')
  await service.complete(oldest.id, { markdown: '1234' })
  const protectedWorkspace = await service.create('report-completed-b')
  await service.complete(protectedWorkspace.id, { markdown: '1234' })
  currentTime += 1
  const newest = await service.create('report-completed-c')
  await service.complete(newest.id, { markdown: '1234' })
  const running = await service.create('report-running-budget')
  await service.writeArtifact(running.id, 'input/evidence.txt', '12')
  const failed = await service.create('report-failed-budget')
  await service.writeArtifact(failed.id, 'input/evidence.txt', '12')
  await service.fail(failed.id, 'SUMMARY_FAILED')
  const corruptCompleted = await service.create('report-completed-corrupt')
  await service.complete(corruptCompleted.id, { markdown: '1234' })
  const corruptManifest = await readManifest(corruptCompleted.path)
  await writeFile(join(corruptCompleted.path, 'manifest.json'), JSON.stringify({
    ...corruptManifest,
    updatedAt: 'not-a-date'
  }))

  assert.deepEqual(await service.pruneCompleted({
    maxBytes: 10,
    isProtected: reportId => reportId === protectedWorkspace.id
  }), { removed: 2, bytes: 12 })
  assert.equal(existsSync(oldest.path), false)
  assert.equal(existsSync(newest.path), false)
  for (const workspace of [protectedWorkspace, running, failed, corruptCompleted]) {
    assert.equal(existsSync(workspace.path), true)
  }
})

test('pruneOrphans removes only completed workspaces explicitly absent from retained reports', async t => {
  const { service } = await withWorkspace(t)
  const orphan = await service.create('report-orphan')
  await service.complete(orphan.id, { markdown: 'orphan' })
  const retained = await service.create('report-retained')
  await service.complete(retained.id, { markdown: 'retained' })
  const active = await service.create('report-active')
  await service.complete(active.id, { markdown: 'active' })
  const lookupFailed = await service.create('report-lookup-failed')
  await service.complete(lookupFailed.id, { markdown: 'lookup failed' })
  const invalidLookup = await service.create('report-invalid-lookup')
  await service.complete(invalidLookup.id, { markdown: 'invalid lookup' })
  const protectionFailed = await service.create('report-protection-failed')
  await service.complete(protectionFailed.id, { markdown: 'protection failed' })
  const invalidProtection = await service.create('report-invalid-protection')
  await service.complete(invalidProtection.id, { markdown: 'invalid protection' })
  const running = await service.create('report-running-orphan-check')

  const retainedChecks = []
  const result = await service.pruneOrphans({
    isProtected: reportId => {
      if (reportId === active.id) return true
      if (reportId === protectionFailed.id) throw new Error('job service unavailable')
      if (reportId === invalidProtection.id) return undefined
      return false
    },
    isRetained: async reportId => {
      retainedChecks.push(reportId)
      if (reportId === retained.id) return true
      if (reportId === lookupFailed.id) throw new Error('database unavailable')
      if (reportId === invalidLookup.id) return undefined
      return false
    }
  })

  assert.deepEqual(result, { checked: 7, removed: 1, bytes: 6 })
  assert.equal(existsSync(orphan.path), false)
  for (const workspace of [
    retained, active, lookupFailed, invalidLookup, protectionFailed, invalidProtection, running
  ]) {
    assert.equal(existsSync(workspace.path), true)
  }
  assert.equal(retainedChecks.includes(active.id), false)
})

function temporaryPathFragment(root) {
  return basename(join(root, '..'))
}
