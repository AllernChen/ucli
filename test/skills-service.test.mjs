import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { createSkillsService } from '../electron/skills/service.js'
import { createSkillSourceLoader } from '../electron/skills/sourceLoader.js'
import { inspectSkillDirectory } from '../electron/skills/fileOps.js'

function createSkill(root, description = 'Prepare release notes', name = 'release-notes') {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n`)
}

function findSources(state, name) {
  return state.discovered.find((group) => group.name === name)?.sources || []
}

function findSource(state, name, adapterId) {
  return findSources(state, name).find((source) => source.adapterId === adapterId) || null
}

function createDirectoryLink(target, entry) {
  mkdirSync(dirname(entry), { recursive: true })
  symlinkSync(target, entry, process.platform === 'win32' ? 'junction' : 'dir')
}

async function withService(work, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-skills-service-'))
  const db = await openDb(join(root, 'ucli.db'))
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'staging') })
  const { flushFactory, ...serviceOverrides } = overrides
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
    ...serviceOverrides,
    ...(flushFactory ? { flush: flushFactory(db) } : {})
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

test('install is idempotent for the same source and content in the same scope', async () => {
  await withService(async ({ root, db, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const request = {
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    }

    const first = await service.install(request)
    const repeated = await service.install(request)

    assert.equal(repeated.id, first.id)
    assert.deepEqual(repeated.installOutcome, {
      kind: 'already_installed',
      matchType: 'same_source_and_content',
      appliedAdapterIds: []
    })
    assert.equal(db.listSkillPackages().length, 1)
    assert.equal(db.listSkillInstallations().length, 1)
  })
})

test('install reuses identical managed content and applies it to another CLI', async () => {
  await withService(async ({ root, db, service }) => {
    const firstSource = join(root, 'source-a')
    const duplicateSource = join(root, 'source-b')
    const project = join(root, 'project')
    createSkill(firstSource)
    createSkill(duplicateSource)
    const first = await service.install({
      source: { type: 'local', path: firstSource },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })

    const reused = await service.install({
      source: { type: 'local', path: duplicateSource },
      targetAdapterIds: ['claude'],
      scopeType: 'project',
      projectPath: project
    })

    assert.equal(reused.id, first.id)
    assert.deepEqual(reused.installOutcome, {
      kind: 'applied_existing',
      matchType: 'same_content',
      appliedAdapterIds: ['claude']
    })
    assert.deepEqual(reused.installations.map((item) => item.targetAdapterId).sort(), ['claude', 'codex'])
    assert.equal(db.listSkillPackages().length, 1)
  })
})

test('install inspection identifies changed content from an already managed source', async () => {
  await withService(async ({ root, db, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })
    createSkill(source, 'Changed at the original source')

    const preview = await service.inspectSource({ type: 'local', path: source })
    assert.deepEqual(preview.installedMatches.map((item) => ({
      packageId: item.packageId,
      matchType: item.matchType
    })), [{
      packageId: installed.id,
      matchType: 'same_source_changed'
    }])
    await assert.rejects(
      service.install({
        source: { type: 'local', path: source },
        targetAdapterIds: ['claude'],
        scopeType: 'project',
        projectPath: project
      }),
      (error) => error.code === 'SKILL_SOURCE_CHANGED'
    )
    assert.equal(db.listSkillPackages().length, 1)
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

test('install adopts identical unmanaged target content instead of reporting a conflict', async () => {
  await withService(async ({ root, db, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    const target = join(project, '.agents', 'skills', 'release-notes')
    createSkill(source)
    createSkill(target)
    const before = readFileSync(join(target, 'SKILL.md'), 'utf8')

    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })

    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), before)
    assert.equal(db.listSkillPackages().length, 1)
    assert.equal(db.listSkillInstallations().length, 1)
    assert.equal(installed.installations[0].targetPath, target)
    assert.deepEqual(installed.installOutcome, {
      kind: 'adopted_existing',
      matchType: 'same_content',
      appliedAdapterIds: [],
      adoptedAdapterIds: ['codex']
    })
  })
})

test('install inspection reports identical unmanaged target content before confirmation', async () => {
  await withService(async ({ root, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    const target = join(project, '.agents', 'skills', 'release-notes')
    createSkill(source)
    createSkill(target)

    const preview = await service.inspectSource({ type: 'local', path: source }, {
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })

    assert.deepEqual(preview.targetMatches, [{
      adapterId: 'codex',
      targetPath: target,
      matchType: 'same_content'
    }])
  })
})

test('managed skill can be applied directly to another AI CLI in the same scope', async () => {
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

    const applied = await service.applyToAdapter(installed.id, 'claude')

    assert.deepEqual(
      applied.installations.map((item) => item.targetAdapterId).sort(),
      ['claude', 'codex']
    )
    assert.equal(existsSync(join(project, '.claude', 'skills', 'release-notes', 'SKILL.md')), true)
    assert.equal(applied.visibility.claude.direct, true)
  })
})

test('applying to identical external content adopts the existing CLI location', async () => {
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
    const existing = join(project, '.claude', 'skills', 'release-notes')
    createSkill(existing)

    const applied = await service.applyToAdapter(installed.id, 'claude')

    assert.equal(applied.installations.find((item) => item.targetAdapterId === 'claude')?.status, 'ready')
    assert.equal(existsSync(join(existing, 'SKILL.md')), true)
  })
})

test('applying to conflicting CLI content fails without changing files or records', async () => {
  await withService(async ({ root, db, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })
    const conflicting = join(project, '.claude', 'skills', 'release-notes')
    createSkill(conflicting, 'Different local content')

    await assert.rejects(
      service.applyToAdapter(installed.id, 'claude'),
      (error) => error.code === 'SKILL_TARGET_CONFLICT'
    )

    assert.match(readFileSync(join(conflicting, 'SKILL.md'), 'utf8'), /Different local content/)
    assert.deepEqual(db.listSkillInstallations({ packageId: installed.id }).map((item) => item.targetAdapterId), ['codex'])
  })
})

test('apply rolls back its projection and database record when persistence fails', async () => {
  let failFlush = false
  await withService(async ({ root, db, service }) => {
    const source = join(root, 'source')
    const project = join(root, 'project')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['codex'],
      scopeType: 'project',
      projectPath: project
    })
    failFlush = true

    await assert.rejects(
      service.applyToAdapter(installed.id, 'claude'),
      (error) => error.code === 'SKILL_PERSISTENCE_PENDING'
    )

    assert.equal(existsSync(join(project, '.claude', 'skills', 'release-notes')), false)
    assert.deepEqual(db.listSkillInstallations({ packageId: installed.id }).map((item) => item.targetAdapterId), ['codex'])
  }, {
    flushFactory: (db) => () => failFlush ? false : db.flush()
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

test('adopting one mirror registers sibling deployments under a single package', async () => {
  await withService(async ({ root, service }) => {
    const home = join(root, 'home')
    // Same skill deployed at both codex stores in the user home (mirror sources).
    createSkill(join(home, '.agents', 'skills', 'diagnose'), 'Diagnose helper', 'diagnose')
    createSkill(join(home, '.codex', 'skills', 'diagnose'), 'Diagnose helper', 'diagnose')
    const state = await service.getState()
    const group = state.discovered.find((item) => item.name === 'diagnose')
    assert.equal(group.status, 'mirror')
    assert.equal(group.sources.length, 2)

    const adoptTarget = group.sources.find((s) => s.path.includes('.agents'))
    const pkg = await service.adopt({
      path: adoptTarget.path,
      targetAdapterId: adoptTarget.adapterId,
      scopeType: adoptTarget.scopeType,
      projectPath: adoptTarget.scopeType === 'project' ? join(home, 'project') : undefined
    })
    // One package, but both mirror paths are now managed installations.
    const after = await service.getState()
    assert.equal(after.packages.filter((p) => p.name === 'diagnose').length, 1)
    assert.equal(pkg.installations.length, 2)
    assert.deepEqual(
      pkg.installations.map((item) => item.targetPath).sort(),
      [
        join(home, '.agents', 'skills', 'diagnose'),
        join(home, '.codex', 'skills', 'diagnose')
      ].sort()
    )
    // The discovered sources are no longer external/adoptable.
    const afterGroup = after.discovered.find((item) => item.name === 'diagnose')
    assert.equal(afterGroup.sources.every((s) => s.origin === 'managed'), true)
    assert.equal(afterGroup.sources.every((s) => s.installationId), true)
  })
})

test('adopting a conflicted skill never takes ownership of different-content siblings', async () => {
  await withService(async ({ root, service }) => {
    const home = join(root, 'home')
    const codexPath = join(home, '.agents', 'skills', 'diagnose')
    const claudePath = join(home, '.claude', 'skills', 'diagnose')
    createSkill(codexPath, 'Codex diagnosis', 'diagnose')
    createSkill(claudePath, 'Claude diagnosis', 'diagnose')

    const before = await service.getState()
    const group = before.discovered.find((item) => item.name === 'diagnose')
    assert.equal(group.status, 'conflict')

    const source = group.sources.find((item) => item.path === codexPath)
    const pkg = await service.adopt({
      path: source.path,
      targetAdapterId: source.adapterId,
      scopeType: source.scopeType
    })

    assert.deepEqual(pkg.installations.map((item) => item.targetPath), [codexPath])
    const after = await service.getState()
    const afterGroup = after.discovered.find((item) => item.name === 'diagnose')
    assert.equal(afterGroup.sources.find((item) => item.path === codexPath).origin, 'managed')
    assert.equal(afterGroup.sources.find((item) => item.path === claudePath).origin, 'external')
  })
})

test('managed installations expose visibility per projection and hide disabled locations', async () => {
  await withService(async ({ root, service }) => {
    const source = join(root, 'source')
    createSkill(source)
    const installed = await service.install({
      source: { type: 'local', path: source },
      targetAdapterIds: ['claude', 'codex'],
      scopeType: 'user'
    })
    const codex = installed.installations.find((item) => item.targetAdapterId === 'codex')
    await service.setEnabled(codex.id, false)

    const pkg = (await service.getState()).packages[0]
    const claude = pkg.installations.find((item) => item.targetAdapterId === 'claude')
    const disabledCodex = pkg.installations.find((item) => item.targetAdapterId === 'codex')
    assert.equal(claude.visibility.claude.visible, true)
    assert.equal(claude.visibility.codex.visible, false)
    assert.equal(disabledCodex.visibility.claude.visible, false)
    assert.equal(disabledCodex.visibility.codex.visible, false)
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

test('discovery enriches externally installed Skills with GitHub source projects from the skill lock', async () => {
  await withService(async ({ root, service }) => {
    const home = join(root, 'home')
    createSkill(join(home, '.agents', 'skills', 'diagnose'), 'Diagnose bugs', 'diagnose')
    createSkill(join(home, '.agents', 'skills', 'tdd'), 'Develop test-first', 'tdd')
    writeFileSync(join(home, '.agents', '.skill-lock.json'), JSON.stringify({
      version: 3,
      skills: {
        diagnose: {
          source: 'mattpocock/skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/mattpocock/skills.git'
        },
        tdd: {
          source: 'mattpocock/skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/mattpocock/skills.git'
        }
      }
    }))

    const state = await service.getState()
    assert.deepEqual(
      state.discovered.map((group) => group.sources[0].sourceProject),
      [
        { type: 'github', locator: 'https://github.com/mattpocock/skills.git' },
        { type: 'github', locator: 'https://github.com/mattpocock/skills.git' }
      ]
    )
  })
})

test('discovery restores legacy install provenance from the UCLI source-project registry', async () => {
  await withService(async ({ root, service }) => {
    const home = join(root, 'home')
    const registry = join(root, 'user-data', 'skills', 'source-projects.json')
    createSkill(join(home, '.codex', 'skills', 'writing-plans'), 'Write implementation plans', 'writing-plans')
    writeFileSync(registry, JSON.stringify({
      version: 1,
      associations: {
        'writing-plans': {
          sourceType: 'github',
          sourceUrl: 'https://github.com/obra/superpowers'
        }
      }
    }))

    const source = (await service.getState()).discovered
      .find((group) => group.name === 'writing-plans')
      .sources[0]
    assert.deepEqual(source.sourceProject, {
      type: 'github',
      locator: 'https://github.com/obra/superpowers'
    })
  })
})

test('UCLI source-project registry also enriches an adopted managed package', async () => {
  await withService(async ({ root, service }) => {
    const home = join(root, 'home')
    const skillPath = join(home, '.codex', 'skills', 'executing-plans')
    const registry = join(root, 'user-data', 'skills', 'source-projects.json')
    createSkill(skillPath, 'Execute implementation plans', 'executing-plans')
    writeFileSync(registry, JSON.stringify({
      version: 1,
      associations: {
        'executing-plans': {
          sourceType: 'github',
          sourceUrl: 'https://github.com/obra/superpowers'
        }
      }
    }))

    await service.adopt({ path: skillPath, targetAdapterId: 'codex', scopeType: 'user' })
    const pkg = (await service.getState()).packages[0]
    assert.equal(pkg.sourceType, 'adopted')
    assert.deepEqual(pkg.sourceProject, {
      type: 'github',
      locator: 'https://github.com/obra/superpowers'
    })
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
    assert.equal(state.discovered[0].sources[0].health, 'invalid')
    assert.equal(state.discovered[0].sources[0].visibility.claude.visible, false)
  })
})

test('agents root is Codex-owned and does not imply Claude visibility', async () => {
  await withService(async ({ root, service }) => {
    const skillPath = join(root, 'home', '.agents', 'skills', 'diagnose')
    createSkill(skillPath, 'Diagnose bugs', 'diagnose')

    const source = findSource(await service.getState(), 'diagnose', 'codex')

    assert.equal(source.sourceKind, 'codex_user')
    assert.equal(source.entryPath, skillPath)
    assert.equal(source.resolvedPath, realpathSync(skillPath))
    assert.equal(source.health, 'ready')
    assert.equal(source.visibility.codex.direct, true)
    assert.equal(source.visibility.claude.visible, false)
    assert.equal(source.visibility['deepseek-harness'].visible, false)
  })
})

test('project agents skills are exposed once to DSH without a DSH installation target', async () => {
  await withService(async ({ root, service }) => {
    const project = join(root, 'project')
    const skillPath = join(project, '.agents', 'skills', 'diagnose')
    createSkill(skillPath, 'Diagnose bugs', 'diagnose')

    const state = await service.getState({ projectPath: project })
    const sources = findSources(state, 'diagnose')
    const source = sources.find((item) => item.adapterId === 'codex')

    assert.equal(sources.filter((item) => item.entryPath === skillPath).length, 1)
    assert.deepEqual(source.visibility['deepseek-harness'], {
      visible: true, direct: false, inheritedFrom: ['codex']
    })
    assert.deepEqual(state.adapters.at(-1), {
      id: 'deepseek-harness', displayName: 'DeepSeek Harness', virtual: true, projectOnly: true
    })
    const managedSource = join(root, 'managed-source')
    createSkill(managedSource, 'Prepare releases', 'release-notes')
    const installed = await service.install({
      source: { type: 'local', path: managedSource },
      targetAdapterIds: ['codex'], scopeType: 'project', projectPath: project
    })
    await assert.rejects(
      service.applyToAdapter(installed.id, 'deepseek-harness'),
      (error) => error.code === 'SKILL_ADAPTER_UNAVAILABLE'
    )
  })
})

test('Claude root remains Claude-owned when its entry links into agents storage', async () => {
  await withService(async ({ root, service }) => {
    const target = join(root, 'home', '.agents', 'skills', 'diagnose')
    const entry = join(root, 'home', '.claude', 'skills', 'diagnose')
    createSkill(target, 'Diagnose bugs', 'diagnose')
    createDirectoryLink(target, entry)

    const sources = findSources(await service.getState(), 'diagnose')
    const claude = sources.find((source) => source.adapterId === 'claude')

    assert.deepEqual(sources.map((source) => source.adapterId).sort(), ['claude', 'codex'])
    assert.equal(claude.sourceKind, 'claude_user')
    assert.equal(claude.entryPath, entry)
    assert.equal(claude.resolvedPath, realpathSync(target))
    assert.equal(claude.link.status, 'valid')
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

test('Claude user Skills expose valid and broken links without treating broken targets as visible', async () => {
  await withService(async ({ root, service }) => {
    const shared = join(root, 'home', '.agents', 'skills')
    createSkill(join(shared, 'lark-doc'), 'Lark document helper', 'lark-doc')
    // Claude Code keeps ~/.claude/skills entries as symlinks into a shared store.
    const claudeSkills = join(root, 'home', '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync(join(shared, 'lark-doc'), join(claudeSkills, 'lark-doc'), 'dir')
    const missingTarget = join(shared, 'missing-target')
    symlinkSync(missingTarget, join(claudeSkills, 'lark-gone'), 'dir')

    const state = await service.getState()
    const discovered = state.discovered
    const larkDoc = discovered.find((item) => item.name === 'lark-doc')
    assert.ok(larkDoc, 'symlinked Claude skill should be discovered')
    // Same content is mirrored across the codex store and the claude symlink.
    assert.equal(larkDoc.status, 'mirror')
    assert.deepEqual(larkDoc.sources.map((s) => s.adapterId).sort(), ['claude', 'codex'])
    const broken = findSource(state, 'lark-gone', 'claude')
    assert.ok(broken, 'dangling Claude link should remain visible for diagnosis')
    assert.equal(broken.health, 'broken_link')
    assert.equal(broken.status, 'broken_link')
    assert.equal(broken.link.status, 'broken')
    assert.equal(broken.link.targetPath, missingTarget)
    assert.equal(broken.entryPath, join(claudeSkills, 'lark-gone'))
    assert.equal(broken.resolvedPath, missingTarget)
    assert.equal(broken.visibility.claude.visible, false)
  })
})

test('Claude plugin Skills only load from installed_plugins.json, not stale cache', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const installed = join(pluginsRoot, 'cache', 'superpowers-marketplace', 'superpowers', '5.1.0')
    createSkill(join(installed, 'skills', 'writing-plans'), 'Write implementation plans', 'writing-plans')
    createSkill(join(installed, 'skills', 'brainstorming'), 'Brainstorm designs', 'brainstorming')
    mkdirSync(join(installed, '.claude-plugin'), { recursive: true })
    writeFileSync(join(installed, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'superpowers',
      repository: 'https://github.com/obra/superpowers'
    }))
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
    assert.equal(source.scopeType, 'user')
    assert.equal(source.origin, 'plugin')
    assert.equal(source.sourceKind, 'claude_plugin')
    assert.deepEqual(source.plugin, {
      id: 'superpowers',
      marketplace: 'superpowers-marketplace'
    })
    assert.deepEqual(source.sourceProject, {
      type: 'github',
      locator: 'https://github.com/obra/superpowers'
    })
    assert.equal(source.installationId, null)
  })
})

test('batch install reuses one pinned checkout for multiple Skill packages', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'ucli-skills-batch-loader-'))
  const gitCalls = []
  try {
    const sourceLoader = createSkillSourceLoader({
      stagingRoot: join(sourceRoot, 'staging'),
      runGit(args) {
        gitCalls.push(args)
        if (args[0] === 'clone') {
          const destination = args.at(-1)
          createSkill(join(destination, 'skills', 'first'), 'First Skill', 'first')
          createSkill(join(destination, 'skills', 'second'), 'Second Skill', 'second')
        }
        if (args.includes('rev-parse')) return 'collection123\n'
        return ''
      }
    })
    await withService(async ({ root, db, service }) => {
      const common = {
        type: 'git', url: 'https://github.com/example/skills.git',
        refType: 'branch', ref: 'main'
      }
      const request = (subdir) => ({
        source: { ...common, subdir },
        expectedRevision: 'collection123',
        targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project')
      })

      const result = await service.installMany([
        request('skills/first'),
        request('skills/second')
      ])

      assert.deepEqual(result.installed.map((item) => item.result.name), ['first', 'second'])
      assert.deepEqual(result.failed, [])
      assert.deepEqual(db.listSkillPackages().map((pkg) => ({
        sourceRefType: pkg.sourceRefType,
        sourceRef: pkg.sourceRef,
        resolvedRevision: pkg.resolvedRevision
      })), [
        { sourceRefType: 'branch', sourceRef: 'main', resolvedRevision: 'collection123' },
        { sourceRefType: 'branch', sourceRef: 'main', resolvedRevision: 'collection123' }
      ])
      assert.equal(gitCalls.filter((args) => args.includes('clone')).length, 1)
      assert.equal(gitCalls.filter((args) => args.includes('fetch')).length, 1)
      assert.deepEqual((await service.checkUpdates()).map(({ checked, updateAvailable }) => ({ checked, updateAvailable })), [
        { checked: true, updateAvailable: false },
        { checked: true, updateAvailable: false }
      ])
    }, { sourceLoader })
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('batch install preserves confirmed results and stops when later persistence becomes pending', async () => {
  const preparedRoot = mkdtempSync(join(tmpdir(), 'ucli-skills-pending-batch-'))
  createSkill(join(preparedRoot, 'first'), 'First Skill', 'first')
  createSkill(join(preparedRoot, 'second'), 'Second Skill', 'second')
  createSkill(join(preparedRoot, 'third'), 'Third Skill', 'third')
  try {
    await withService(async ({ root, db, service }) => {
      const request = (subdir) => ({
        source: {
          type: 'git', url: 'https://github.com/example/skills.git',
          refType: 'default', ref: '', subdir
        },
        expectedRevision: 'collection123',
        targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project')
      })

      const result = await service.installMany([
        request('skills/first'), request('skills/second'), request('skills/third')
      ])

      assert.deepEqual(result.installed.map((item) => item.result.name), ['first'])
      assert.deepEqual(result.failed, [])
      assert.equal(result.aborted.request.source.subdir, 'skills/second')
      assert.deepEqual(result.aborted.error, {
        code: 'SKILL_PERSISTENCE_PENDING', message: 'Skill changes are pending persistence'
      })
      assert.deepEqual(result.aborted.skippedRequests.map((item) => item.source.subdir), ['skills/third'])
      assert.deepEqual(db.listSkillPackages().map((pkg) => pkg.name).sort(), ['first', 'second'])
      assert.equal(existsSync(join(root, 'project', '.agents', 'skills', 'first')), true)
      assert.equal(existsSync(join(root, 'project', '.agents', 'skills', 'second')), true)
      assert.equal(existsSync(join(root, 'project', '.agents', 'skills', 'third')), false)
    }, {
      sourceLoader: {
        async withPreparedMany(_sources, work) {
          return work([
            {
              workingDirectory: join(preparedRoot, 'first'),
              source: { type: 'github', locator: 'https://github.com/example/skills.git', ref: '', subdir: 'skills/first' },
              resolvedRevision: 'collection123'
            },
            {
              workingDirectory: join(preparedRoot, 'second'),
              source: { type: 'github', locator: 'https://github.com/example/skills.git', ref: '', subdir: 'skills/second' },
              resolvedRevision: 'collection123'
            },
            {
              workingDirectory: join(preparedRoot, 'third'),
              source: { type: 'github', locator: 'https://github.com/example/skills.git', ref: '', subdir: 'skills/third' },
              resolvedRevision: 'collection123'
            }
          ])
        }
      },
      flushFactory: (db) => {
        let calls = 0
        return () => {
          calls += 1
          return calls === 2 ? false : db.flush()
        }
      }
    })
  } finally {
    rmSync(preparedRoot, { recursive: true, force: true })
  }
})

test('batch install rejects mixed target and scope contexts before source preparation', async () => {
  let prepared = false
  await withService(async ({ root, service }) => {
    const base = (subdir) => ({
      source: {
        type: 'git', url: 'https://github.com/example/skills.git',
        refType: 'default', ref: '', subdir
      },
      expectedRevision: 'collection123', scopeType: 'project', projectPath: join(root, 'project')
    })
    await assert.rejects(
      service.installMany([
        { ...base('skills/first'), targetAdapterIds: ['codex'] },
        { ...base('skills/second'), targetAdapterIds: ['claude'] }
      ]),
      (error) => error.code === 'SKILL_BATCH_CONTEXT_INVALID'
    )
    assert.equal(prepared, false)
  }, {
    sourceLoader: {
      async withPreparedMany() { prepared = true }
    }
  })
})

test('collection inspection adds independent install preflight to every selectable Skill', async () => {
  let collection
  await withService(async ({ root, service }) => {
    const project = join(root, 'project')
    const existingTdd = join(project, '.agents', 'skills', 'tdd')
    createSkill(existingTdd, 'Develop test-first', 'tdd')
    const tddHash = inspectSkillDirectory(existingTdd).contentSha256
    collection = {
      kind: 'collection',
      skills: [
        {
          kind: 'skill', name: 'tdd', description: 'Develop test-first',
          subdir: 'skills/engineering/tdd', contentSha256: tddHash,
          source: { type: 'github', locator: 'https://github.com/example/skills.git', ref: '', subdir: 'skills/engineering/tdd' }
        },
        {
          kind: 'skill', name: 'grill-me', description: 'Clarify a plan',
          subdir: 'skills/productivity/grill-me', contentSha256: 'different-content',
          source: { type: 'github', locator: 'https://github.com/example/skills.git', ref: '', subdir: 'skills/productivity/grill-me' }
        }
      ],
      source: { type: 'github', locator: 'https://github.com/example/skills.git', ref: '', subdir: '' },
      resolvedRevision: 'collection123'
    }

    const inspected = await service.inspectSource({
      type: 'git', url: 'https://github.com/example/skills.git'
    }, {
      targetAdapterIds: ['codex'], scopeType: 'project', projectPath: project
    })

    assert.deepEqual(inspected.skills.map((skill) => ({
      name: skill.name,
      installedMatches: skill.installedMatches,
      targetMatches: skill.targetMatches.map(({ adapterId, matchType }) => ({ adapterId, matchType }))
    })), [
      { name: 'tdd', installedMatches: [], targetMatches: [{ adapterId: 'codex', matchType: 'same_content' }] },
      { name: 'grill-me', installedMatches: [], targetMatches: [] }
    ])
  }, {
    sourceLoader: { async inspect() { return collection } }
  })
})

test('GitLab-installed Skills retain their GitLab source when checking for updates', async () => {
  let sourceRoot = ''
  const loaderCalls = []
  const sourceLoader = {
    async withPrepared(source, work) {
      loaderCalls.push(source)
      return work({
        workingDirectory: sourceRoot,
        source: source.type === 'local'
          ? { type: 'local', locator: source.path, ref: '', subdir: '' }
          : { type: source.type, locator: source.url, ref: source.ref || '', subdir: source.subdir || '' },
        resolvedRevision: '0123456789012345678901234567890123456789'
      })
    },
    async inspect() { throw new Error('not used') }
  }

  await withService(async ({ root, db, service }) => {
    sourceRoot = join(root, 'source')
    createSkill(sourceRoot)
    const installed = await service.install({
      source: { type: 'local', path: sourceRoot },
      targetAdapterIds: ['codex'],
      scopeType: 'user'
    })
    db.updateSkillPackage(installed.id, {
      sourceType: 'gitlab',
      sourceLocator: 'https://gitlab.com/example/platform/skills.git',
      sourceRef: 'main',
      sourceRefType: 'branch'
    })

    const preview = await service.previewUpdate(installed.id)

    assert.equal(preview.updateable, true)
    assert.deepEqual(loaderCalls.at(-1), {
      type: 'gitlab',
      url: 'https://gitlab.com/example/platform/skills.git',
      ref: 'main',
      refType: 'branch',
      subdir: ''
    })
  }, { sourceLoader })
})

test('Claude plugin Skills remain discoverable through an aliased install root', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const actualInstall = join(root, 'plugin-store', 'superpowers', '5.1.0')
    const aliasedInstall = join(pluginsRoot, 'cache', 'superpowers', '5.1.0')
    createSkill(join(actualInstall, 'skills', 'writing-plans'), 'Write implementation plans', 'writing-plans')
    createDirectoryLink(actualInstall, aliasedInstall)
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@superpowers-marketplace': [{
          scope: 'user',
          installPath: aliasedInstall,
          version: '5.1.0'
        }]
      }
    }))

    const source = findSource(await service.getState(), 'writing-plans', 'claude')

    assert.ok(source)
    assert.equal(source.entryPath, join(aliasedInstall, 'skills', 'writing-plans'))
    assert.equal(source.resolvedPath, realpathSync(join(actualInstall, 'skills', 'writing-plans')))
  })
})

test('user plugin Skills are user-installed and nested Skills are discovered', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const installed = join(pluginsRoot, 'cache', 'mattpocock-skills', '1.0.0')
    createSkill(join(installed, 'skills', 'engineering', 'diagnose'), 'Diagnose bugs', 'diagnose')
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'mattpocock-skills@mattpocock-skills': [{
          scope: 'user',
          installPath: installed,
          version: '1.0.0'
        }]
      }
    }))
    writeFileSync(join(pluginsRoot, 'known_marketplaces.json'), JSON.stringify({
      'mattpocock-skills': {
        source: { source: 'github', repo: 'mattpocock/skills' },
        installLocation: join(pluginsRoot, 'marketplaces', 'mattpocock-skills')
      }
    }))

    const source = findSource(await service.getState(), 'diagnose', 'claude')
    assert.ok(source)
    assert.equal(source.origin, 'plugin')
    assert.equal(source.scopeType, 'user')
    assert.equal(source.sourceKind, 'claude_plugin')
    assert.deepEqual(source.plugin, {
      id: 'mattpocock-skills',
      marketplace: 'mattpocock-skills'
    })
    assert.deepEqual(source.sourceProject, {
      type: 'github',
      locator: 'https://github.com/mattpocock/skills'
    })
  })
})

test('project plugin Skills appear only for their registered project', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const installed = join(pluginsRoot, 'cache', 'superpowers', '1.0.0')
    const projectA = join(root, 'project-a')
    const projectB = join(root, 'project-b')
    createSkill(join(installed, 'skills', 'writing-plans'), 'Write plans', 'writing-plans')
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@marketplace': [{
          scope: 'project',
          projectPath: projectA,
          installPath: installed,
          version: '1.0.0'
        }]
      }
    }))

    const projectSource = findSource(await service.getState({ projectPath: projectA }), 'writing-plans', 'claude')
    assert.ok(projectSource)
    assert.equal(projectSource.scopeType, 'project')
    assert.equal(
      projectSource.scopeKey,
      process.platform === 'win32' ? resolve(projectA).toLowerCase() : resolve(projectA)
    )
    assert.equal(findSource(await service.getState({ projectPath: projectB }), 'writing-plans', 'claude'), null)
    assert.equal(findSource(await service.getState(), 'writing-plans', 'claude'), null)
  })
})

test('commands and MCP-only plugins do not create fake Skills', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const installed = join(pluginsRoot, 'cache', 'commit-commands', '1.0.0')
    mkdirSync(join(installed, 'commands'), { recursive: true })
    writeFileSync(join(installed, 'commands', 'commit.md'), '# Commit')
    writeFileSync(join(installed, '.mcp.json'), '{"mcpServers":{}}')
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'commit-commands@official': [{ scope: 'user', installPath: installed }]
      }
    }))

    const sources = (await service.getState()).discovered.flatMap((group) => group.sources)
    assert.equal(sources.some((source) => source.plugin?.id === 'commit-commands'), false)
  })
})

test('plugin discovery cannot escape its install root or loop through directory links', async () => {
  await withService(async ({ root, service }) => {
    const pluginsRoot = join(root, 'home', '.claude', 'plugins')
    const installed = join(pluginsRoot, 'cache', 'safe-plugin', '1.0.0')
    const skillsRoot = join(installed, 'skills')
    const outside = join(root, 'outside-plugin')
    createSkill(join(outside, 'escaped-skill'), 'Must not be scanned', 'escaped-skill')
    mkdirSync(skillsRoot, { recursive: true })
    createDirectoryLink(outside, join(skillsRoot, 'escape'))
    createDirectoryLink(skillsRoot, join(skillsRoot, 'cycle'))
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'safe-plugin@test': [{ scope: 'user', installPath: installed }]
      }
    }))

    const names = (await service.getState()).discovered.map((group) => group.name)
    assert.equal(names.includes('escaped-skill'), false)
    assert.equal(names.includes('escape'), false)
    assert.equal(names.includes('cycle'), false)
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
