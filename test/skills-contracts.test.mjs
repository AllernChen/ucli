import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  parseSkillManifest,
  sanitiseGitHubSource,
  validateSkillCompatibility
} from '../electron/skills/contracts.js'
import {
  buildSkillVisibility,
  planSkillProjections,
  resolveSkillRoot
} from '../electron/skills/adapters.js'

test('skill manifest requires Agent Skills name and description', () => {
  const parsed = parseSkillManifest(`---\nname: release-notes\ndescription: Prepare release notes\nallowed-tools:\n  - Read\n---\n\n# Instructions\n`)
  assert.equal(parsed.name, 'release-notes')
  assert.equal(parsed.description, 'Prepare release notes')
  assert.deepEqual(parsed.metadata['allowed-tools'], ['Read'])
  assert.throws(
    () => parseSkillManifest('---\nname: missing-description\n---\n'),
    (error) => error.code === 'SKILL_MANIFEST_INVALID'
  )
})

test('OpenCode compatibility rejects names outside its portable skill format', () => {
  assert.deepEqual(validateSkillCompatibility('release-notes'), {
    claude: { compatible: true, reason: null },
    codex: { compatible: true, reason: null },
    opencode: { compatible: true, reason: null },
    ucode: { compatible: true, reason: null }
  })
  assert.equal(validateSkillCompatibility('Release Notes').opencode.compatible, false)
})

test('GitHub source never retains embedded credentials', () => {
  assert.deepEqual(sanitiseGitHubSource({
    url: 'https://token@github.com/owner/repo.git',
    ref: 'main',
    subdir: 'skills/release'
  }), {
    url: 'https://github.com/owner/repo.git',
    ref: 'main',
    subdir: 'skills/release'
  })
  assert.throws(
    () => sanitiseGitHubSource({ url: 'https://example.com/owner/repo' }),
    (error) => error.code === 'SKILL_SOURCE_INVALID'
  )
})

test('skill roots resolve user and project scopes for all adapters', () => {
  const project = join(homedir(), 'work', 'demo')
  const home = homedir()
  assert.equal(resolveSkillRoot({ adapterId: 'claude', scopeType: 'project', projectPath: project }), join(project, '.claude', 'skills'))
  assert.equal(resolveSkillRoot({ adapterId: 'codex', scopeType: 'user', home }), join(home, '.agents', 'skills'))
  assert.equal(resolveSkillRoot({ adapterId: 'opencode', scopeType: 'project', projectPath: project }), join(project, '.opencode', 'skills'))
  assert.equal(resolveSkillRoot({ adapterId: 'ucode', scopeType: 'project', projectPath: project }), join(project, '.ucode', 'skills'))
  assert.equal(resolveSkillRoot({
    adapterId: 'ucode', scopeType: 'user', home,
    env: { UCODE_HOME: join(home, 'custom-ucode') }
  }), join(home, 'custom-ucode', 'config', 'skills'))
  assert.equal(resolveSkillRoot({
    adapterId: 'opencode', scopeType: 'user', home,
    env: { XDG_CONFIG_HOME: join(home, 'xdg-config') }
  }), join(home, 'xdg-config', 'opencode', 'skills'))
})

test('projection planner uses compatible roots and reports inherited visibility', () => {
  assert.deepEqual(planSkillProjections(['claude', 'codex', 'opencode', 'ucode']), ['claude', 'codex'])
  assert.deepEqual(planSkillProjections(['opencode', 'ucode']), ['opencode'])
  assert.deepEqual(buildSkillVisibility(['codex']), {
    claude: { visible: false, direct: false, inheritedFrom: [] },
    codex: { visible: true, direct: true, inheritedFrom: [] },
    opencode: { visible: true, direct: false, inheritedFrom: ['codex'] },
    ucode: { visible: true, direct: false, inheritedFrom: ['codex'] }
  })
})
