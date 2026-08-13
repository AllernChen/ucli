import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import test from 'node:test'

import {
  runScheduledStorageCleanup,
  runScheduledStorageCleanupSync
} from '../electron/storage/startupCleanup.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ucli-startup-cleanup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roots = {
    userData: join(root, 'user-data'),
    baseCache: join(root, 'cache-base'),
    browserCacheParent: join(root, 'temp', 'ucli'),
    browserCache: join(root, 'temp', 'ucli', 'electron-session-data'),
    installedSkills: join(root, 'user-data', 'skills'),
    skillStaging: join(root, 'user-data', 'skills', '.source-staging'),
    updateDownloads: join(root, 'cache-base', 'ucli-updater')
  }
  const markerPath = join(roots.userData, 'storage-cleanup.json')
  await mkdir(roots.userData, { recursive: true })
  return { root, roots, markerPath }
}

async function schedule(markerPath, categories) {
  await writeFile(markerPath, JSON.stringify({ version: 1, categories }))
}

test('scheduled cleanup removes exact trusted targets and deletes a completed marker', async t => {
  const { roots, markerPath } = await fixture(t)
  for (const target of [roots.browserCache, roots.skillStaging, roots.updateDownloads]) {
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'owned.bin'), 'owned')
  }
  await schedule(markerPath, ['browser-cache', 'skill-staging', 'update-downloads'])

  assert.deepEqual(await runScheduledStorageCleanup({ markerPath, roots }), {
    removed: ['browser-cache', 'skill-staging', 'update-downloads'], failed: []
  })
  assert.equal(existsSync(markerPath), false)
  for (const target of [roots.browserCache, roots.skillStaging, roots.updateDownloads]) {
    assert.equal(existsSync(target), false)
  }
})

test('a failed target retains only its category ID for the next start', async t => {
  const { roots, markerPath } = await fixture(t)
  await mkdir(roots.browserCache, { recursive: true })
  await mkdir(roots.skillStaging, { recursive: true })
  await schedule(markerPath, ['browser-cache', 'skill-staging'])

  const result = await runScheduledStorageCleanup({
    markerPath,
    roots,
    removeTarget: async target => {
      if (target === roots.browserCache) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      await rm(target, { recursive: true, force: true })
    }
  })
  assert.deepEqual(result, { removed: ['skill-staging'], failed: ['browser-cache'] })
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), {
    version: 1, categories: ['browser-cache']
  })
})

test('unknown, duplicated, extra-field, and path-shaped marker values are rejected', async t => {
  const { roots, markerPath } = await fixture(t)
  const invalidMarkers = [
    { version: 1, categories: ['unknown'] },
    { version: 1, categories: ['../browser-cache'] },
    { version: 1, categories: ['C:\\cache'] },
    { version: 1, categories: ['browser-cache', 'browser-cache'] },
    { version: 1, categories: ['browser-cache'], path: roots.browserCache }
  ]
  for (const marker of invalidMarkers) {
    await writeFile(markerPath, JSON.stringify(marker))
    await assert.rejects(
      runScheduledStorageCleanup({ markerPath, roots }),
      error => error?.code === 'STORAGE_CLEANUP_MARKER_INVALID'
    )
    assert.equal(existsSync(markerPath), true)
  }
})

test('marker path must be the exact trusted user-data marker and cannot be a symlink', async t => {
  const { root, roots, markerPath } = await fixture(t)
  const outsideMarker = join(root, 'outside-marker.json')
  await schedule(outsideMarker, ['browser-cache'])
  await assert.rejects(
    runScheduledStorageCleanup({ markerPath: outsideMarker, roots }),
    error => error?.code === 'STORAGE_CLEANUP_MARKER_UNSAFE'
  )
  assert.equal(existsSync(outsideMarker), true)

  const linkedMarker = join(root, 'linked-marker.json')
  await schedule(linkedMarker, ['browser-cache'])
  try {
    await symlink(linkedMarker, markerPath, 'file')
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('symlink creation unavailable')
    throw error
  }
  await assert.rejects(
    runScheduledStorageCleanup({ markerPath, roots }),
    error => error?.code === 'STORAGE_CLEANUP_MARKER_UNSAFE'
  )
  assert.equal(existsSync(linkedMarker), true)
})

test('unsafe root, sibling substitution, and symlink targets fail closed', async t => {
  const { root, roots, markerPath } = await fixture(t)
  await schedule(markerPath, ['skill-staging'])
  await assert.rejects(
    runScheduledStorageCleanup({ markerPath, roots: { ...roots, skillStaging: parse(root).root } }),
    error => error?.code === 'STORAGE_CLEANUP_TARGET_UNSAFE'
  )
  await assert.rejects(
    runScheduledStorageCleanup({ markerPath, roots: { ...roots, skillStaging: join(dirname(roots.installedSkills), 'skills-sibling') } }),
    error => error?.code === 'STORAGE_CLEANUP_TARGET_UNSAFE'
  )
  await assert.rejects(
    runScheduledStorageCleanup({ markerPath, roots: { ...roots, skillStaging: join(roots.installedSkills, 'unexpected-child') } }),
    error => error?.code === 'STORAGE_CLEANUP_TARGET_UNSAFE'
  )

  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await mkdir(dirname(roots.skillStaging), { recursive: true })
  try {
    await symlink(outside, roots.skillStaging, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('junction creation unavailable')
    throw error
  }
  await assert.rejects(
    runScheduledStorageCleanup({ markerPath, roots }),
    error => error?.code === 'STORAGE_CLEANUP_TARGET_UNSAFE'
  )
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
})

test('a symlinked configured parent fails closed before deleting descendants', async t => {
  const { root, roots, markerPath } = await fixture(t)
  const outside = join(root, 'outside-parent')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await rm(roots.installedSkills, { recursive: true, force: true })
  await mkdir(dirname(roots.installedSkills), { recursive: true })
  try {
    await symlink(outside, roots.installedSkills, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('junction creation unavailable')
    throw error
  }
  await schedule(markerPath, ['skill-staging'])
  await assert.rejects(
    runScheduledStorageCleanup({ markerPath, roots }),
    error => error?.code === 'STORAGE_CLEANUP_TARGET_UNSAFE'
  )
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
})

test('sync startup wrapper completes cleanup before returning', async t => {
  const { roots, markerPath } = await fixture(t)
  await mkdir(roots.browserCache, { recursive: true })
  await schedule(markerPath, ['browser-cache'])
  assert.deepEqual(runScheduledStorageCleanupSync({ markerPath, roots }), {
    removed: ['browser-cache'], failed: []
  })
  assert.equal(existsSync(roots.browserCache), false)
  assert.equal(existsSync(markerPath), false)
})

test('main runs trusted cleanup before recreating browser cache, Skills, and updater startup', () => {
  const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
  const resolveRoots = source.indexOf('resolveUcliStorageRoots({')
  const cleanup = source.indexOf('runScheduledStorageCleanupSync({', resolveRoots)
  const sessionMkdir = source.indexOf('mkdirSync(sessionDataPath', cleanup)
  const orchestrator = source.indexOf('createOrchestrator()', sessionMkdir)
  const updater = source.indexOf('createUpdateService({', orchestrator)

  assert.ok(resolveRoots >= 0 && cleanup > resolveRoots)
  assert.ok(sessionMkdir > cleanup)
  assert.ok(orchestrator > sessionMkdir)
  assert.ok(updater > orchestrator)
})
