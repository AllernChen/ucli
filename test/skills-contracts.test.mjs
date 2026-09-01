import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  parseSkillManifest,
  sanitiseGitRemoteSource,
  sanitiseGitLabSource,
  sanitiseGitHubSource,
  skillError,
  validateDshSkillName,
  validateSkillCompatibility
} from '../electron/skills/contracts.js'
import {
  buildSkillVisibility,
  listSkillPresentationAdapters,
  planSkillProjections,
  resolveDshAgentsRoot,
  resolveSkillRoot,
  SKILL_ADAPTERS
} from '../electron/skills/adapters.js'

test('projection errors retain only their stable public code', () => {
  const error = skillError('Skill projection plan is stale', 'SKILL_PROJECTION_PLAN_STALE')
  assert.equal(error.message, 'Skill projection plan is stale')
  assert.equal(error.code, 'SKILL_PROJECTION_PLAN_STALE')
})

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
    ucode: { compatible: true, reason: null },
    'deepseek-harness': { compatible: true, reason: null }
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

test('GitLab HTTPS sources preserve nested groups and never retain embedded credentials', () => {
  assert.deepEqual(sanitiseGitLabSource({
    url: 'https://token@gitlab.com/platform/agent/skills.git',
    ref: 'main',
    subdir: 'skills/release'
  }), {
    url: 'https://gitlab.com/platform/agent/skills.git',
    ref: 'main',
    subdir: 'skills/release'
  })
  assert.throws(
    () => sanitiseGitLabSource({ url: 'https://github.com/owner/repo' }),
    (error) => error.code === 'SKILL_SOURCE_INVALID'
  )
})

test('generic Git remote source detects the provider from the repository hostname', () => {
  assert.deepEqual(sanitiseGitRemoteSource({
    url: 'https://token@github.com/owner/skills.git', ref: 'main'
  }), {
    type: 'github',
    url: 'https://github.com/owner/skills.git',
    ref: 'main',
    subdir: ''
  })
  assert.deepEqual(sanitiseGitRemoteSource({
    url: 'https://token@gitlab.com/group/platform/skills.git'
  }), {
    type: 'gitlab',
    url: 'https://gitlab.com/group/platform/skills.git',
    ref: '',
    subdir: ''
  })
})

test('self-hosted GitLab permits HTTPS and private HTTP without retaining credentials', () => {
  assert.deepEqual(sanitiseGitRemoteSource({
    url: 'http://token@10.44.51.32:8080/AI/pr-skills?private_token=secret#readme'
  }), {
    type: 'gitlab',
    url: 'http://10.44.51.32:8080/AI/pr-skills',
    ref: '',
    subdir: ''
  })
  assert.deepEqual(sanitiseGitLabSource({
    url: 'https://gitlab.example.com/platform/skills.git'
  }), {
    url: 'https://gitlab.example.com/platform/skills.git',
    ref: '',
    subdir: ''
  })
  assert.throws(
    () => sanitiseGitRemoteSource({ url: 'http://gitlab.example.com/group/skills.git' }),
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
    adapterId: 'deepseek-harness', scopeType: 'project', projectPath: project
  }), join(project, '.dsh', 'skills'))
  assert.equal(resolveSkillRoot({
    adapterId: 'deepseek-harness', scopeType: 'user', home,
    env: { DSH_HOME: join(home, 'custom-dsh') }
  }), join(home, 'custom-dsh', 'skills'))
  assert.equal(resolveSkillRoot({
    adapterId: 'deepseek-harness', scopeType: 'user', home,
    env: { DSH_HOME: '  relative-dsh  ' }
  }), join(resolve(process.cwd(), '  relative-dsh  '), 'skills'))
  assert.equal(resolveSkillRoot({
    adapterId: 'deepseek-harness', scopeType: 'user', home,
    env: { DSH_HOME: '   ' }
  }), join(home, '.dsh', 'skills'))
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
    ucode: { visible: true, direct: false, inheritedFrom: ['codex'] },
    'deepseek-harness': { visible: true, direct: false, inheritedFrom: ['codex'] }
  })
})

test('DSH Skill names use the portable root-entry format', () => {
  assert.equal(validateDshSkillName('release-notes'), 'release-notes')
  assert.throws(
    () => validateDshSkillName('Release Notes'),
    { code: 'SKILL_MANIFEST_INVALID' }
  )
})

test('DeepSeek Harness uses a direct root alone and one shared projection with Codex', () => {
  assert.equal(Object.hasOwn(SKILL_ADAPTERS, 'deepseek-harness'), true)
  assert.deepEqual(planSkillProjections(['deepseek-harness']), ['deepseek-harness'])
  assert.deepEqual(planSkillProjections(['codex', 'deepseek-harness']), ['codex'])
  const adapters = listSkillPresentationAdapters()
  assert.deepEqual(adapters.at(-1), {
    id: 'deepseek-harness', displayName: 'DeepSeek Harness'
  })
  assert.deepEqual(buildSkillVisibility(['codex'], { scopeType: 'user' })['deepseek-harness'], {
    visible: true, direct: false, inheritedFrom: ['codex']
  })
  assert.deepEqual(buildSkillVisibility(['deepseek-harness'], { scopeType: 'user' })['deepseek-harness'], {
    visible: true, direct: true, inheritedFrom: []
  })
})

test('DSH project roots follow the nearest git ancestor and DSH_AGENTS_HOME controls user sharing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-dsh-skill-roots-'))
  try {
    const repository = join(root, 'repository')
    const nested = join(repository, 'packages', 'app')
    mkdirSync(join(repository, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    assert.equal(resolveSkillRoot({
      adapterId: 'deepseek-harness', scopeType: 'project', projectPath: nested
    }), join(repository, '.dsh', 'skills'))
    assert.equal(resolveSkillRoot({
      adapterId: 'codex', scopeType: 'project', projectPath: nested
    }), join(repository, '.agents', 'skills'))

    const home = join(root, 'home')
    const customAgents = join(root, 'custom-agents')
    assert.equal(resolveDshAgentsRoot({ home, env: { DSH_AGENTS_HOME: customAgents } }), join(customAgents, 'skills'))
    assert.deepEqual(planSkillProjections(['codex', 'deepseek-harness'], {
      scopeType: 'user', home, env: { DSH_AGENTS_HOME: customAgents }
    }), ['codex', 'deepseek-harness'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
