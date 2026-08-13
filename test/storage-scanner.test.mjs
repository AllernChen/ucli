import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  STORAGE_CATEGORY_IDS,
  resolveUcliStorageRoots
} from '../electron/storage/storageCatalog.js'
import { scanStorageCategories } from '../electron/storage/storageScanner.js'

const EXPECTED_IDS = [
  'core-data',
  'installed-skills',
  'other-user-data',
  'summary-cache',
  'summary-workspaces',
  'browser-cache',
  'skill-staging',
  'update-downloads',
  'logs'
]

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ucli-storage-scanner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const userDataPath = path.join(root, 'user-data')
  const sessionDataPath = path.join(root, 'session-data')
  const cacheBase = path.join(root, 'cache')
  await Promise.all([
    mkdir(userDataPath, { recursive: true }),
    mkdir(sessionDataPath, { recursive: true }),
    mkdir(cacheBase, { recursive: true })
  ])
  const roots = resolveUcliStorageRoots({
    platform: process.platform,
    env: process.platform === 'win32'
      ? { LOCALAPPDATA: cacheBase }
      : { XDG_CACHE_HOME: cacheBase },
    homeDirectory: root,
    userDataPath,
    sessionDataPath
  })
  return { root, roots }
}

function byId(results, id) {
  return results.find(result => result.id === id)
}

test('storage ownership uses the fixed category order and platform cache roots', () => {
  assert.deepEqual(STORAGE_CATEGORY_IDS, EXPECTED_IDS)

  const windows = resolveUcliStorageRoots({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    homeDirectory: 'C:\\Users\\demo',
    userDataPath: 'C:\\Users\\demo\\AppData\\Roaming\\UCLI',
    sessionDataPath: 'C:\\Temp\\ucli\\electron-session-data'
  })
  assert.equal(windows.baseCache, 'C:\\Users\\demo\\AppData\\Local')
  assert.equal(windows.summaryCache, 'C:\\Users\\demo\\AppData\\Local\\UCLI\\summary\\cache')
  assert.equal(windows.updateDownloads, 'C:\\Users\\demo\\AppData\\Local\\ucli-updater')

  const mac = resolveUcliStorageRoots({
    platform: 'darwin',
    env: {},
    homeDirectory: '/Users/demo',
    userDataPath: '/Users/demo/Library/Application Support/UCLI',
    sessionDataPath: '/tmp/ucli/electron-session-data'
  })
  assert.equal(mac.summaryWorkspaces, '/Users/demo/Library/Caches/UCLI/summary/workspaces')
  assert.equal(mac.updateDownloads, '/Users/demo/Library/Caches/ucli-updater')

  const linux = resolveUcliStorageRoots({
    platform: 'linux',
    env: { XDG_CACHE_HOME: '/var/cache/demo' },
    homeDirectory: '/home/demo',
    userDataPath: '/home/demo/.config/UCLI',
    sessionDataPath: '/tmp/ucli/electron-session-data'
  })
  assert.equal(linux.summaryCache, '/var/cache/demo/ucli/summary/cache')
  assert.equal(linux.updateDownloads, '/var/cache/demo/ucli-updater')
})

test('configured storage roots fail closed when they are not absolute', () => {
  assert.throws(
    () => resolveUcliStorageRoots({
      platform: 'linux',
      env: { XDG_CACHE_HOME: 'relative-cache' },
      homeDirectory: '/home/demo',
      userDataPath: '/home/demo/.config/UCLI',
      sessionDataPath: '/tmp/ucli/session'
    }),
    error => error?.code === 'STORAGE_ROOT_UNSAFE'
  )
  assert.throws(
    () => resolveUcliStorageRoots({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\demo',
      userDataPath: 'UCLI',
      sessionDataPath: 'C:\\Temp\\ucli\\session'
    }),
    error => error?.code === 'STORAGE_ROOT_UNSAFE'
  )
})

test('fixed descriptors produce non-overlapping owned categories', async t => {
  const { roots } = await fixture(t)
  await Promise.all([
    writeFile(path.join(roots.userData, 'ucli.db'), 'database'),
    writeFile(path.join(roots.userData, 'ucli.db.bak'), 'backup'),
    writeFile(path.join(roots.userData, 'window-state.json'), 'window'),
    writeFile(path.join(roots.userData, 'ucli.log'), 'log'),
    writeFile(path.join(roots.userData, 'notes.txt'), 'other'),
    mkdir(path.join(roots.installedSkills, 'installed-one'), { recursive: true }),
    mkdir(roots.skillStaging, { recursive: true }),
    mkdir(roots.summaryCache, { recursive: true }),
    mkdir(roots.summaryWorkspaces, { recursive: true }),
    mkdir(roots.updateDownloads, { recursive: true })
  ])
  await Promise.all([
    writeFile(path.join(roots.installedSkills, 'installed-one', 'SKILL.md'), 'skill'),
    writeFile(path.join(roots.skillStaging, 'download.tmp'), 'staged'),
    writeFile(path.join(roots.summaryCache, 'result.json'), 'cache'),
    writeFile(path.join(roots.summaryWorkspaces, 'manifest.json'), 'workspace'),
    writeFile(path.join(roots.browserCache, 'Cache.data'), 'browser'),
    writeFile(path.join(roots.updateDownloads, 'installer.exe'), 'update')
  ])

  const results = await scanStorageCategories(roots.descriptors)
  assert.deepEqual(results.map(result => result.id), EXPECTED_IDS)
  assert.equal(byId(results, 'installed-skills').bytes, 5)
  assert.equal(byId(results, 'skill-staging').bytes, 6)
  assert.equal(byId(results, 'other-user-data').bytes, 5)
  assert.equal(byId(results, 'logs').bytes, 3)
  assert.equal(byId(results, 'summary-cache').bytes, 5)
  assert.equal(byId(results, 'summary-workspaces').bytes, 9)
  assert.equal(byId(results, 'browser-cache').bytes, 7)
  assert.equal(byId(results, 'update-downloads').bytes, 6)
  assert.equal(byId(results, 'core-data').bytes, 20)
  assert.equal(results.reduce((sum, result) => sum + result.bytes, 0), 66)
})

test('directory symlinks and Windows junctions are counted but never followed', async t => {
  const { root, roots } = await fixture(t)
  const outside = path.join(root, 'provider-owned')
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret-transcript.jsonl'), 'must-not-be-counted')
  const link = path.join(roots.userData, 'linked-provider-data')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

  const results = await scanStorageCategories(roots.descriptors)
  const other = byId(results, 'other-user-data')
  assert.equal(other.bytes, 0)
  assert.equal(other.itemCount, 1)
  assert.equal(other.status, 'ready')
})

test('entry and depth bounds stop traversal and report partial', async t => {
  const { roots } = await fixture(t)
  await Promise.all([
    writeFile(path.join(roots.userData, 'a.txt'), 'x'),
    writeFile(path.join(roots.userData, 'b.txt'), 'x'),
    writeFile(path.join(roots.userData, 'c.txt'), 'x'),
    writeFile(path.join(roots.userData, 'd.txt'), 'x')
  ])
  const entryBound = await scanStorageCategories([
    { id: 'bounded', roots: [roots.userData] }
  ], { maxEntries: 3 })
  assert.deepEqual(entryBound, [{
    id: 'bounded',
    bytes: 3,
    itemCount: 3,
    status: 'partial'
  }])

  const top = path.join(roots.browserCache, 'top')
  const nested = path.join(top, 'nested')
  await mkdir(nested, { recursive: true })
  await writeFile(path.join(nested, 'too-deep.bin'), 'hidden')
  const depthBound = await scanStorageCategories([
    { id: 'depth-bounded', roots: [roots.browserCache] },
    { id: 'independent', roots: [path.join(roots.userData, 'a.txt')] }
  ], { maxDepth: 1 })
  assert.equal(depthBound[0].status, 'partial')
  assert.equal(depthBound[0].bytes, 0)
  assert.equal(depthBound[0].itemCount, 1)
  assert.deepEqual(depthBound[1], {
    id: 'independent',
    bytes: 1,
    itemCount: 1,
    status: 'ready'
  })
})

test('scan errors are unavailable rather than false zero and results leak no paths', async t => {
  const { root, roots } = await fixture(t)
  const unreadable = path.join(root, 'unreadable')
  await mkdir(unreadable)
  if (process.platform !== 'win32') {
    await chmod(unreadable, 0)
    t.after(() => chmod(unreadable, 0o700).catch(() => {}))
  }
  const invalidRoot = `${unreadable}\0invalid`
  const results = await scanStorageCategories([
    { id: 'unavailable', roots: [invalidRoot] },
    ...roots.descriptors
  ])
  assert.deepEqual(results[0], {
    id: 'unavailable',
    bytes: 0,
    itemCount: 0,
    status: 'unavailable'
  })
  const encoded = JSON.stringify(results)
  assert.equal(encoded.includes(root), false)
  assert.equal(encoded.includes('invalid'), false)
  assert.equal(results.every(result => Number.isSafeInteger(result.bytes)), true)
  assert.equal(results.every(result => Number.isSafeInteger(result.itemCount)), true)
})

test('exclusions use path boundaries rather than sibling prefixes', async t => {
  const { root } = await fixture(t)
  const owned = path.join(root, 'owned')
  const ownedSibling = path.join(root, 'owned-copy')
  await Promise.all([
    mkdir(owned),
    mkdir(ownedSibling)
  ])
  await Promise.all([
    writeFile(path.join(owned, 'excluded.bin'), 'excluded'),
    writeFile(path.join(ownedSibling, 'included.bin'), 'included')
  ])
  const results = await scanStorageCategories([{
    id: 'boundary',
    roots: [root],
    excludePaths: [owned]
  }])
  assert.equal(results[0].bytes, 8)
  assert.equal(results[0].status, 'ready')
})
