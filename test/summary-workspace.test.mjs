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
})

function temporaryPathFragment(root) {
  return basename(join(root, '..'))
}
