import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RULESET } from '../electron/permission/defaultRules.js'
import { classify, toClassifierInput } from '../electron/permission/classifier.js'

test('default rules allow ordinary removal but confirm recursive removal', () => {
  assert.equal(
    classify({ tool: 'Bash', command: 'rm note.txt' }, DEFAULT_RULESET).classification,
    'default'
  )
  assert.equal(
    classify({ tool: 'Bash', command: 'rm -r build' }, DEFAULT_RULESET).classification,
    'high-risk'
  )
})

test('command prefix rules match Windows command casing', () => {
  assert.equal(
    classify(
      { tool: 'Bash', command: 'remove-item -recurse build' },
      DEFAULT_RULESET
    ).classification,
    'high-risk'
  )
})

test('home-relative secret paths match their absolute Windows location', () => {
  const home = process.env.HOME || process.env.USERPROFILE
  assert.ok(home)
  assert.equal(
    classify(
      { tool: 'Write', path: `${home}\\.aws\\credentials` },
      DEFAULT_RULESET
    ).classification,
    'high-risk'
  )
})

test('hard blacklist catches destructive PowerShell removal on a system root', () => {
  assert.equal(classify({
    tool: 'PowerShell', command: 'Remove-Item -Recurse -Force C:\\Windows'
  }, {}).classification, 'blacklist')
})

test('classifier preserves rule paths and separately resolves blacklist paths', () => {
  assert.deepEqual(
    toClassifierInput('Write', { path: '../.ssh/authorized_keys' }, 'C:\\Users\\alice\\workspace'),
    {
      tool: 'Write', path: '../.ssh/authorized_keys',
      resolvedPath: 'C:\\Users\\alice\\.ssh\\authorized_keys'
    }
  )
  assert.deepEqual(
    toClassifierInput('Write', { path: '../.ssh/authorized_keys' }, '/home/alice/workspace'),
    {
      tool: 'Write', path: '../.ssh/authorized_keys',
      resolvedPath: '/home/alice/.ssh/authorized_keys'
    }
  )
})

test('relative user globs still match when a trusted cwd is present', () => {
  const input = toClassifierInput('Write', { path: 'src/generated/file.js' }, 'C:\\workspace')
  assert.equal(classify(input, { deny: ['Write(src/**)'] }).classification, 'deny')
})

test('hard blacklist catches option separators, PowerShell aliases, extended paths, and cwd-less escapes', () => {
  const calls = [
    { tool: 'Bash', command: 'rm -rf -- /' },
    { tool: 'Bash', command: 'rm --force --recursive /' },
    { tool: 'PowerShell', command: 'ri -r -fo C:\\Windows' },
    { tool: 'Write', path: '\\\\?\\C:\\Windows\\System32\\drivers\\etc\\hosts' },
    toClassifierInput('Write', { path: '../../../home/alice/.ssh/authorized_keys' })
  ]
  for (const call of calls) {
    assert.equal(classify(call, {}).classification, 'blacklist', JSON.stringify(call))
  }
})
