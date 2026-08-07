import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { createSkillsService } from '../electron/skills/service.js'
import { createSkillSourceLoader } from '../electron/skills/sourceLoader.js'

function createSkill(root, description = 'Prepare release notes', name = 'release-notes') {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n`)
}

async function withService(work, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-skills-service-'))
  const db = await openDb(join(root, 'ucli.db'))
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'staging') })
  const service = createSkillsService({
    db,
    userDataPath: join(root, 'user-data'),
    home: join(root, 'home'),
    sourceLoader,
    flush: () => db.flush(),
    listSessions: () => [
      { id: 'codex-session', adapterId: 'codex', cwd: join(root, 'project'), status: 'offline' },
      { id: 'claude-session', adapterId: 'claude', cwd: join(root, 'other'), status: 'offline' }
    ],
    ...overrides
  })
  try { await work({ root, db, service }) } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('install stores one managed package and the minimum projections for four CLIs', async () => {
  await withService(async ({ root, db, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)

    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['claude', 'codex', 'opencode', 'ucode'],
      scopeType: 'project',
      projectPath: project
    })
    assert.equal(installed.name, 'release-notes')
    assert.deepEqual(installed.installations.map((item) => item.targetAdapterId), ['claude', 'codex'])
    assert.equal(existsSync(join(project, '.claude', 'skills', 'release-notes', 'SKILL.md')), true)
    assert.equal(existsSync(join(project, '.agents', 'skills', 'release-notes', 'SKILL.md')), true)
    assert.equal(existsSync(join(project, '.opencode', 'skills', 'release-notes')), false)
    assert.equal(db.listSkillPackages().length, 1)

    const state = await service.getState({ projectPath: project })
    assert.deepEqual(state.summary, {
      managedPackages: 1,
      activeInstallations: 2,
      updates: 0,
      conflicts: 0
    })
    assert.equal(state.packages[0].visibility.opencode.visible, true)
    assert.equal(state.packages[0].visibility.opencode.direct, false)
  })
})

test('install never overwrites an external skill with the same target', async () => {
  await withService(async ({ root, db, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    createSkill(join(project, '.agents', 'skills', 'release-notes'), 'External version')

    await assert.rejects(
      service.install({
        source: { type: 'local', path: source },
        targetAdapterIds: ['codex'],
        scopeType: 'project',
        projectPath: project
      }),
      (error) => error.code === 'SKILL_TARGET_CONFLICT'
    )
    assert.equal(db.listSkillPackages().length, 0)
  })
})

test('managed projections can be disabled, re-enabled and adopted safely', async () => {
  await withService(async ({ root, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })
    const projection = installed.installations[0]
    await service.setEnabled(projection.id, false)
    assert.equal(existsSync(projection.targetPath), false)
    await service.setEnabled(projection.id, true)
    assert.equal(existsSync(projection.targetPath), true)

    const external = join(project, '.claude', 'skills', 'release-notes')
    createSkill(external)
    const adopted = await service.adopt({
      path: external,
      targetAdapterId: 'claude',
      scopeType: 'project',
      projectPath: project
    })
    assert.equal(adopted.installations[0].status, 'ready')
  })
})

test('affected sessions are filtered by effective visibility and project scope', async () => {
  await withService(async ({ root, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })
    assert.deepEqual(service.getAffectedSessions([installed.installations[0].id]).map((item) => item.id), ['codex-session'])
  })
})

test('local sources expose an update preview and refresh every managed projection', async () => {
  await withService(async ({ root, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })
    createSkill(source, 'Updated release notes')

    const preview = await service.previewUpdate(installed.id)
    assert.equal(preview.hasChanges, true)
    const updated = await service.update(installed.id, preview.fromRevision)
    assert.equal(updated.description, 'Updated release notes')
    assert.equal(updated.installations[0].status, 'ready')
  })
})

test('discovery marks same-name different-content sources as a conflict', async () => {
  await withService(async ({ root, service }) => {
    const project = join(root, 'project')
    createSkill(join(project, '.agents', 'skills', 'release-notes'), 'Codex version')
    createSkill(join(project, '.claude', 'skills', 'release-notes'), 'Claude version')
    const state = await service.getState({ projectPath: project })
    assert.equal(state.summary.conflicts, 1)
    assert.equal(state.discovered[0].status, 'conflict')
  })
})

test('U-Code authoritative discovery does not create a false conflict for an already scanned path', async () => {
  let discoveredPath
  await withService(async ({ root, service }) => {
    const project = join(root, 'project')
    discoveredPath = join(project, '.claude', 'skills', 'release-notes')
    createSkill(discoveredPath)
    const state = await service.getState({ projectPath: project })
    assert.equal(state.summary.conflicts, 0)
    assert.equal(state.discovered[0].status, 'ready')
    assert.equal(state.discovered[0].sources.length, 1)
  }, {
    discoverUCodeSkills: () => [{
      name: 'release-notes',
      description: 'Prepare release notes',
      path: discoveredPath,
      origin: 'system'
    }]
  })
})

test('drift can be restored from the managed copy or adopted as the new managed source', async () => {
  await withService(async ({ root, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })
    const projection = installed.installations[0]

    createSkill(projection.targetPath, 'Changed outside UCLI')
    const restored = await service.resolveDrift(projection.id, 'restore')
    assert.equal(restored.status, 'ready')
    assert.equal((await service.getState({ projectPath: project })).packages[0].description, 'Prepare release notes')

    createSkill(projection.targetPath, 'Accepted outside change')
    const adopted = await service.resolveDrift(projection.id, 'adopt')
    assert.equal(adopted.description, 'Accepted outside change')
    assert.equal(adopted.sourceType, 'adopted')
    assert.equal(adopted.installations[0].status, 'ready')
  })
})

test('discovery surfaces malformed SKILL.md files as invalid instead of hiding them', async () => {
  await withService(async ({ root, service }) => {
    const project = join(root, 'project')
    const invalid = join(project, '.claude', 'skills', 'broken-skill')
    mkdirSync(invalid, { recursive: true })
    writeFileSync(join(invalid, 'SKILL.md'), '---\nname: broken-skill\n---\n')
    const state = await service.getState({ projectPath: project })
    assert.equal(state.discovered[0].name, 'broken-skill')
    assert.equal(state.discovered[0].status, 'invalid')
    assert.equal(state.discovered[0].sources[0].origin, 'external')
  })
})

test('Codex system Skills are visible as read-only bundled entries', async () => {
  await withService(async ({ root, service }) => {
    createSkill(join(root, 'home', '.codex', 'skills', '.system', 'builtin-help'), 'Bundled helper')
    const state = await service.getState()
    assert.equal(state.discovered[0].sources[0].adapterId, 'codex')
    assert.equal(state.discovered[0].sources[0].origin, 'bundled')
    assert.equal(state.discovered[0].sources[0].installationId, null)
  })
})

test('Claude user Skills behind a symlink are discovered without dangling-link noise', async () => {
  await withService(async ({ root, service }) => {
    const shared = join(root, 'home', '.agents', 'skills')
    createSkill(join(shared, 'lark-doc'), 'Lark document helper', 'lark-doc')
    // Claude Code keeps ~/.claude/skills entries as symlinks into a shared store.
    const claudeSkills = join(root, 'home', '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync(join(shared, 'lark-doc'), join(claudeSkills, 'lark-doc'), 'dir')
    // Dangling symlink (target does not exist) must be ignored, not crash.
    symlinkSync(join(shared, 'missing-target'), join(claudeSkills, 'lark-gone'), 'dir')

    const state = await service.getState()
    const discovered = state.discovered
    const larkDoc = discovered.find((item) => item.name === 'lark-doc')
    assert.ok(larkDoc, 'symlinked Claude skill should be discovered')
    // Same content is mirrored across the codex store and the claude symlink.
    assert.equal(larkDoc.status, 'mirror')
    assert.deepEqual(larkDoc.sources.map((s) => s.adapterId).sort(), ['claude', 'codex'])
    assert.equal(discovered.some((item) => item.name === 'lark-gone'), false)
  })
})

test('Claude plugin Skills only load from installed_plugins.json, not stale cache', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const installed = join(pluginsRoot, 'cache', 'superpowers-marketplace', 'superpowers', '5.1.0')
    createSkill(join(installed, 'skills', 'writing-plans'), 'Write implementation plans', 'writing-plans')
    createSkill(join(installed, 'skills', 'brainstorming'), 'Brainstorm designs', 'brainstorming')
    // A stale/uninstalled cache copy must NOT be discovered.
    const stale = join(pluginsRoot, 'cache', 'some-uninstalled-plugin', 'plugin', '9.9.9')
    createSkill(join(stale, 'skills', 'uninstalled-skill'), 'Should not appear', 'uninstalled-skill')
    // Marketplace raw checkout must NOT be discovered either.
    const marketplace = join(pluginsRoot, 'marketplaces', 'vendor', 'plugin', 'v1')
    createSkill(join(marketplace, 'skills', 'code-review'), 'Should not appear', 'code-review')
    // Mark only the superpowers plugin as installed.
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@superpowers-marketplace': [{
          scope: 'user',
          installPath: installed,
          version: '5.1.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-01T00:00:00.000Z'
        }]
      }
    }))

    const state = await service.getState()
    const names = state.discovered.map((item) => item.name)
    assert.ok(names.includes('writing-plans'))
    assert.ok(names.includes('brainstorming'))
    assert.equal(names.includes('uninstalled-skill'), false)
    assert.equal(names.includes('code-review'), false)
    const writingPlans = state.discovered.find((item) => item.name === 'writing-plans')
    const source = writingPlans.sources.find((s) => s.adapterId === 'claude')
    assert.equal(source.scopeType, 'system')
    assert.equal(source.origin, 'bundled')
    assert.equal(source.installationId, null)
  })
})

test('Claude plugin Skills are found inside a nested .claude/skills folder', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const installed = join(pluginsRoot, 'cache', 'ui-ux-pro-max-skill', 'ui-ux-pro-max', '2.5.0')
    createSkill(join(installed, '.claude', 'skills', 'banner-design'), 'Banner design', 'banner-design')
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'ui-ux-pro-max@ui-ux-pro-max-skill': [{
          scope: 'user',
          installPath: installed,
          version: '2.5.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-01T00:00:00.000Z'
        }]
      }
    }))
    const state = await service.getState()
    const names = state.discovered.map((item) => item.name)
    assert.ok(names.includes('banner-design'))
  })
})

test('OpenCode plugin Skills are discovered from the package cache as bundled entries', async () => {
  await withService(async ({ root, service }) => {
    const pluginRoot = join(
      root, 'home', '.cache', 'opencode', 'packages',
      'superpowers@git+https_', 'github.com', 'obra', 'superpowers.git',
      'node_modules', 'superpowers'
    )
    createSkill(join(pluginRoot, 'skills', 'writing-plans'), 'Write implementation plans', 'writing-plans')
    createSkill(join(pluginRoot, 'skills', 'brainstorming'), 'Brainstorm designs', 'brainstorming')

    const state = await service.getState()
    const names = state.discovered.map((item) => item.name)
    assert.ok(names.includes('writing-plans'))
    assert.ok(names.includes('brainstorming'))
    const writingPlans = state.discovered.find((item) => item.name === 'writing-plans')
    const source = writingPlans.sources.find((s) => s.adapterId === 'opencode')
    assert.equal(source.scopeType, 'system')
    assert.equal(source.origin, 'bundled')
    assert.equal(source.installationId, null)
  })
})
