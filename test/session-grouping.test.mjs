import assert from 'node:assert/strict'
import test from 'node:test'

import {
  groupSessionsByProject,
  normalizeProjectPath,
  projectNameFromPath
} from '../src/sessionGrouping.js'

const adapters = [
  { id: 'claude', displayName: 'Claude Code', icon: 'C' },
  { id: 'codex', displayName: 'Codex', icon: 'X' }
]

test('normalizes equivalent project paths without merging case-sensitive Unix paths', () => {
  assert.equal(normalizeProjectPath('F:\\Projects\\UCLI\\'), 'f:/projects/ucli')
  assert.equal(normalizeProjectPath('f:/projects/ucli'), 'f:/projects/ucli')
  assert.equal(normalizeProjectPath('/work/UCLI/'), '/work/UCLI')
  assert.notEqual(normalizeProjectPath('/work/UCLI'), normalizeProjectPath('/work/ucli'))
  assert.equal(projectNameFromPath('F:\\Projects\\UCLI\\'), 'UCLI')
  assert.equal(projectNameFromPath('/'), '/')
  assert.equal(projectNameFromPath(''), '未设置目录')
})

test('groups sessions by project and adapter in configured adapter order', () => {
  const groups = groupSessionsByProject([
    { id: 'codex-1', adapterId: 'codex', cwd: 'F:\\Projects\\UCLI', updatedAt: 20 },
    { id: 'claude-1', adapterId: 'claude', cwd: 'f:/projects/ucli/', updatedAt: 10 },
    { id: 'other-1', adapterId: 'custom', cwd: '/work/other', updatedAt: 30 }
  ], adapters)

  assert.deepEqual(groups.map((group) => [group.name, group.count]), [
    ['other', 1],
    ['UCLI', 2]
  ])
  assert.deepEqual(groups[1].cliGroups.map((group) => group.id), ['claude', 'codex'])
  assert.equal(groups[0].cliGroups[0].displayName, 'custom')
})

test('sorts projects and sessions by their most recent available activity', () => {
  const groups = groupSessionsByProject([
    { id: 'old', adapterId: 'claude', cwd: '/work/a', lastActivityTs: 10, updatedAt: 100 },
    { id: 'new', adapterId: 'claude', cwd: '/work/a', updatedAt: 20 },
    { id: 'recent-project', adapterId: 'codex', cwd: '/work/b', createdAt: 30 },
    { id: 'no-project', adapterId: 'codex', cwd: '', startedAt: 5 }
  ], adapters)

  assert.deepEqual(groups.map((group) => group.name), ['b', 'a', '未设置目录'])
  assert.deepEqual(groups[1].cliGroups[0].sessions.map((session) => session.id), ['new', 'old'])
  assert.equal(groups[2].path, '')
})
