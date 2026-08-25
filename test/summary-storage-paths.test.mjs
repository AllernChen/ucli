import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSafeSummaryChild,
  resolveSummaryChild,
  resolveSummaryStorageRoot,
  resolveSummaryWorkLogsRoot,
  resolveWorkLogsFile
} from '../electron/summaries/summaryStoragePaths.js'

const isUnsafe = error => error?.code === 'SUMMARY_STORAGE_PATH_UNSAFE'

test('resolves the Windows summary root from LOCALAPPDATA', () => {
  assert.equal(resolveSummaryStorageRoot({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    homeDirectory: 'C:\\Users\\demo'
  }), 'C:\\Users\\demo\\AppData\\Local\\UCLI\\summary')
})

test('resolves the macOS summary root below the user cache directory', () => {
  assert.equal(resolveSummaryStorageRoot({
    platform: 'darwin',
    env: {},
    homeDirectory: '/Users/demo'
  }), '/Users/demo/Library/Caches/UCLI/summary')
})

test('prefers XDG_CACHE_HOME for the Linux summary root', () => {
  assert.equal(resolveSummaryStorageRoot({
    platform: 'linux',
    env: { XDG_CACHE_HOME: '/var/cache/demo' },
    homeDirectory: '/home/demo'
  }), '/var/cache/demo/ucli/summary')
})

test('falls back to the user cache directory for Linux', () => {
  assert.equal(resolveSummaryStorageRoot({
    platform: 'linux',
    env: {},
    homeDirectory: '/home/demo'
  }), '/home/demo/.cache/ucli/summary')
})

test('rejects missing or relative platform cache roots instead of using cwd', () => {
  for (const input of [
    { platform: 'win32', env: {}, homeDirectory: 'C:\\Users\\demo' },
    { platform: 'win32', env: { LOCALAPPDATA: 'relative-cache' }, homeDirectory: 'C:\\Users\\demo' },
    { platform: 'darwin', env: {}, homeDirectory: 'relative-home' },
    { platform: 'linux', env: { XDG_CACHE_HOME: 'relative-cache' }, homeDirectory: '/home/demo' },
    { platform: 'linux', env: {}, homeDirectory: 'relative-home' }
  ]) {
    assert.throws(() => resolveSummaryStorageRoot(input), isUnsafe)
  }
})

test('resolves an opaque workspace or cache child below its category', () => {
  assert.equal(
    resolveSummaryChild('/safe/summary', 'workspaces', 'report_01-ABC'),
    '/safe/summary/workspaces/report_01-ABC'
  )
  assert.equal(
    resolveSummaryChild('/safe/summary', 'cache', 'a1'),
    '/safe/summary/cache/a1'
  )
})

test('rejects traversal, absolute, separator, and unsupported child values', () => {
  for (const [category, opaqueId] of [
    ['workspaces', '../escape'],
    ['workspaces', '..\\escape'],
    ['workspaces', '/absolute'],
    ['workspaces', 'C:\\absolute'],
    ['workspaces', 'nested/value'],
    ['workspaces', 'nested\\value'],
    ['workspaces', '.hidden'],
    ['other', 'valid-id'],
    ['cache', ''],
    ['cache', 'a'.repeat(129)]
  ]) {
    assert.throws(
      () => resolveSummaryChild('/safe/summary', category, opaqueId),
      isUnsafe,
      `${category}:${opaqueId}`
    )
  }
})

test('rejects sibling-prefix paths and the storage root itself', () => {
  assert.throws(
    () => assertSafeSummaryChild('/safe/summary', '/safe/summary-escape/workspaces/id'),
    isUnsafe
  )
  assert.throws(
    () => assertSafeSummaryChild('/safe/summary', '/safe/summary'),
    isUnsafe
  )
})

test('resolves the workLogs root below the trusted summary storage root', () => {
  assert.equal(resolveSummaryWorkLogsRoot({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    homeDirectory: 'C:\\Users\\demo'
  }), 'C:\\Users\\demo\\AppData\\Local\\UCLI\\summary\\workLogs')
  assert.equal(resolveSummaryWorkLogsRoot({
    platform: 'darwin',
    env: {},
    homeDirectory: '/Users/demo'
  }), '/Users/demo/Library/Caches/UCLI/summary/workLogs')
  assert.equal(resolveSummaryWorkLogsRoot({
    platform: 'linux',
    env: { XDG_CACHE_HOME: '/var/cache/demo' },
    homeDirectory: '/home/demo'
  }), '/var/cache/demo/ucli/summary/workLogs')
})

test('resolves an opaque file inside workLogs with its platform path semantics', () => {
  assert.equal(
    resolveWorkLogsFile('C:\\safe\\summary\\workLogs', 'week-2026-33.md'),
    'C:\\safe\\summary\\workLogs\\week-2026-33.md'
  )
  assert.equal(
    resolveWorkLogsFile('/safe/summary/workLogs', 'week-2026-33.html'),
    '/safe/summary/workLogs/week-2026-33.html'
  )
})

test('rejects traversal, separators, dotfiles, and non-opaque names inside workLogs', () => {
  for (const fileName of [
    '../escape.md',
    '..\\escape.md',
    '/absolute.md',
    'C:\\absolute.md',
    'nested/value.md',
    'nested\\value.md',
    '.hidden',
    '.week-2026-33.md',
    'a'.repeat(129),
    ''
  ]) {
    assert.throws(
      () => resolveWorkLogsFile('/safe/summary/workLogs', fileName),
      isUnsafe,
      fileName
    )
  }
})

test('rejects a workLogs candidate that escapes below the storage root', () => {
  assert.throws(
    () => assertSafeSummaryChild(
      'C:\\safe\\summary\\workLogs',
      'C:\\safe\\summary\\other\\week-2026-33.md'
    ),
    isUnsafe
  )
})

test('validates Windows children with Windows path semantics', () => {
  assert.equal(
    assertSafeSummaryChild(
      'C:\\safe\\summary',
      'C:\\safe\\summary\\workspaces\\job-1'
    ),
    'C:\\safe\\summary\\workspaces\\job-1'
  )
  assert.throws(
    () => assertSafeSummaryChild(
      'C:\\safe\\summary',
      'C:\\safe\\summary-escape\\workspaces\\job-1'
    ),
    isUnsafe
  )
})
