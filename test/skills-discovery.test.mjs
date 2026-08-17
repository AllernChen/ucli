import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { buildSkillVisibility } from '../electron/skills/adapters.js'
import { createSkillDiscovery } from '../electron/skills/discovery.js'
import { inspectSkillDirectory } from '../electron/skills/fileOps.js'

function createSkill(root, description, name = 'ranked-skill') {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n`)
}

function createFlatSkill(path, description, name) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n`)
}

function withDiscovery(work, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-skills-discovery-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const dshHome = join(root, 'dsh-home')
  const discovery = createSkillDiscovery({
    home,
    env: { DSH_HOME: dshHome, ...(options.env || {}) },
    flatFileLimits: options.flatFileLimits,
    flatFileOps: options.flatFileOps,
    inspectSkillDirectory,
    buildSkillVisibility
  })
  try {
    work({ root, home, project, dshHome, discovery })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('DSH discovery keeps all four physical sources and marks the highest-ranked one effective', () => {
  withDiscovery(({ home, project, dshHome, discovery }) => {
    createSkill(join(project, '.dsh', 'skills', 'ranked-skill'), 'Project DSH')
    createSkill(join(project, '.agents', 'skills', 'ranked-skill'), 'Project agents')
    createSkill(join(dshHome, 'skills', 'ranked-skill'), 'User DSH')
    createSkill(join(home, '.agents', 'skills', 'ranked-skill'), 'User agents')

    const sources = discovery.discover({ projectPath: project })
      .filter((item) => item.name === 'ranked-skill')
      .sort((left, right) => left.dshRank - right.dshRank)

    assert.deepEqual(sources.map((item) => ({
      source: item.dshSource,
      rank: item.dshRank,
      effective: item.effective,
      shadowedBy: item.shadowedBy
    })), [
      { source: 'project-dsh', rank: 100, effective: true, shadowedBy: null },
      { source: 'project-agents', rank: 200, effective: false, shadowedBy: 'project-dsh' },
      { source: 'user-dsh', rank: 400, effective: false, shadowedBy: 'project-dsh' },
      { source: 'user-agents', rank: 500, effective: false, shadowedBy: 'project-dsh' }
    ])
  })
})

test('DSH discovery accepts only root-direct portable Markdown Skill files', () => {
  withDiscovery(({ dshHome, discovery }) => {
    const skillsRoot = join(dshHome, 'skills')
    createFlatSkill(join(skillsRoot, 'flat-helper.md'), 'Flat helper', 'flat-helper')
    createFlatSkill(join(skillsRoot, 'nested', 'nested-helper.md'), 'Nested helper', 'nested-helper')
    createFlatSkill(join(skillsRoot, 'Bad Name.md'), 'Bad name', 'Bad Name')
    createSkill(join(skillsRoot, '.system'), 'Bundled helper', 'bundled-helper')

    const results = discovery.discover()
    const flat = results.find((item) => item.name === 'flat-helper')

    assert.ok(flat)
    assert.equal(flat.entryPath, join(skillsRoot, 'flat-helper.md'))
    assert.deepEqual(flat.fileList, ['flat-helper.md'])
    assert.equal(flat.dshSource, 'user-dsh')
    assert.equal(flat.dshRank, 400)
    assert.equal(flat.effective, true)
    assert.equal(flat.visibility['deepseek-harness'].direct, true)
    assert.equal(flat.format, 'flat')
    assert.equal(flat.manageable, false)
    assert.equal(flat.readOnly, true)
    assert.equal(results.some((item) => item.name === 'nested-helper'), false)
    assert.equal(results.find((item) => item.name === 'Bad Name')?.health, 'invalid')
    assert.equal(results.some((item) => item.name === 'bundled-helper'), false)
  })
})

test('flat DSH discovery bounds regular-file reads and marks oversized files invalid', () => {
  withDiscovery(({ dshHome, discovery }) => {
    const skillsRoot = join(dshHome, 'skills')
    createFlatSkill(join(skillsRoot, 'a-valid.md'), 'Fits budget', 'a-valid')
    createFlatSkill(join(skillsRoot, 'b-too-large.md'), 'x'.repeat(256), 'b-too-large')
    createFlatSkill(join(skillsRoot, 'c-total-budget.md'), 'Exceeds the aggregate budget', 'c-total-budget')

    const results = discovery.discover()
    assert.equal(results.find((item) => item.name === 'a-valid')?.health, 'ready')
    const oversized = results.find((item) => item.name === 'b-too-large')
    assert.equal(oversized?.health, 'invalid')
    assert.equal(oversized?.status, 'invalid')
    assert.equal(oversized?.contentSha256, null)
    assert.equal(oversized?.readOnly, true)
    const overBudget = results.find((item) => item.name === 'c-total-budget')
    assert.equal(overBudget?.health, 'invalid')
    assert.equal(overBudget?.contentSha256, null)
  }, { flatFileLimits: { maxFileBytes: 160, maxTotalBytes: 120 } })
})

test('flat DSH discovery never follows Markdown file links outside the declared root', (t) => {
  withDiscovery(({ root, dshHome, discovery }) => {
    const target = join(root, 'outside.md')
    const entry = join(dshHome, 'skills', 'linked.md')
    createFlatSkill(target, 'Must not be followed', 'escaped-flat')
    mkdirSync(dirname(entry), { recursive: true })
    try {
      symlinkSync(target, entry, 'file')
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('file symlinks are unavailable on this Windows host')
        return
      }
      throw error
    }

    const results = discovery.discover()
    assert.equal(results.some((item) => item.name === 'escaped-flat'), false)
    const linked = results.find((item) => item.entryPath === entry)
    assert.equal(linked?.health, 'unsupported')
    assert.equal(linked?.status, 'unsupported')
    assert.equal(linked?.format, 'flat')
    assert.equal(linked?.manageable, false)
    assert.equal(linked?.readOnly, true)
    assert.equal(linked?.contentSha256, null)
  })
})

test('flat DSH discovery rejects a regular file swapped to a symlink before open', (t) => {
  let swapped = false
  let attempted = false
  let externalTarget
  withDiscovery(({ root, dshHome, discovery }) => {
    const target = join(root, 'outside-swap.md')
    externalTarget = target
    const entry = join(dshHome, 'skills', 'swap.md')
    createFlatSkill(target, 'Must not be parsed after swap', 'escaped-swap')
    createFlatSkill(entry, 'Original direct file', 'original-swap')

    const results = discovery.discover()
    assert.equal(attempted, true, 'test hook must run between lstat and open')
    if (!swapped) {
      t.skip('file symlinks are unavailable on this Windows host')
      return
    }
    assert.equal(results.some((item) => item.name === 'escaped-swap'), false)
    assert.equal(results.some((item) => item.name === 'original-swap'), false)
    const unsupported = results.find((item) => item.entryPath === entry)
    assert.equal(unsupported?.health, 'unsupported')
    assert.equal(unsupported?.readOnly, true)
  }, {
    flatFileOps: {
      beforeOpen(path) {
        if (!path.endsWith(`${join('skills', 'swap.md')}`)) return
        attempted = true
        rmSync(path)
        try {
          symlinkSync(externalTarget, path, 'file')
          swapped = true
        } catch (error) {
          if (error?.code !== 'EPERM') throw error
        }
      }
    }
  })
})

test('Codex agents directories keep Codex naming rules while flat files are DSH-only', () => {
  withDiscovery(({ home, project, dshHome, discovery }) => {
    createSkill(join(home, '.agents', 'skills', 'legacy-display'), 'Codex legacy name', 'Release Notes')
    createFlatSkill(join(home, '.agents', 'skills', 'flat-helper.md'), 'Not a Codex directory Skill', 'flat-helper')
    createFlatSkill(join(project, '.agents', 'skills', 'project-flat.md'), 'Project DSH flat Skill', 'project-flat')
    createSkill(join(dshHome, 'skills', 'arbitrary-folder'), 'Native invalid name', 'Release Notes')

    const results = discovery.discover({ projectPath: project })
    const codex = results.find((item) => item.adapterId === 'codex' && item.name === 'Release Notes')
    assert.equal(codex?.health, 'ready')
    assert.equal(codex?.visibility.codex.direct, true)
    assert.equal(codex?.visibility['deepseek-harness'].visible, false)
    const flat = results.find((item) => item.name === 'flat-helper')
    assert.equal(flat?.adapterId, 'deepseek-harness')
    assert.equal(flat?.visibility.codex.visible, false)
    assert.equal(flat?.visibility['deepseek-harness'].direct, true)
    assert.equal(flat?.readOnly, true)
    const projectFlat = results.find((item) => item.name === 'project-flat')
    assert.equal(projectFlat?.adapterId, 'deepseek-harness')
    assert.equal(projectFlat?.dshSource, 'project-agents')
    assert.equal(projectFlat?.readOnly, true)
    const direct = results.find((item) => item.adapterId === 'deepseek-harness' && item.name === 'arbitrary-folder')
    assert.equal(direct?.health, 'invalid')
  })
})

test('DSH_AGENTS_HOME replaces only the DSH user-agents discovery root', () => {
  const customAgents = join(tmpdir(), `ucli-dsh-agents-${Date.now()}`)
  withDiscovery(({ home, discovery }) => {
    createSkill(join(home, '.agents', 'skills', 'codex-only'), 'Default Codex agents', 'codex-only')
    createSkill(join(customAgents, 'skills', 'dsh-agents'), 'Custom DSH agents', 'dsh-agents')
    createFlatSkill(join(customAgents, 'skills', 'custom-flat.md'), 'Custom flat DSH Skill', 'custom-flat')

    const results = discovery.discover()
    const codexOnly = results.find((item) => item.name === 'codex-only')
    const dshAgents = results.find((item) => item.name === 'dsh-agents')
    assert.equal(codexOnly?.visibility.codex.direct, true)
    assert.equal(codexOnly?.visibility['deepseek-harness'].visible, false)
    assert.equal(dshAgents?.dshSource, 'user-agents')
    assert.equal(dshAgents?.dshRank, 500)
    assert.equal(dshAgents?.visibility['deepseek-harness'].visible, true)
    const customFlat = results.find((item) => item.name === 'custom-flat')
    assert.equal(customFlat?.adapterId, 'deepseek-harness')
    assert.equal(customFlat?.visibility.codex.visible, false)
    assert.equal(customFlat?.readOnly, true)
  }, { env: { DSH_AGENTS_HOME: customAgents } })
  rmSync(customAgents, { recursive: true, force: true })
})

test('trusted bundled DSH root is discovered at rank 600 as read-only', () => {
  const bundledRoot = join(tmpdir(), `ucli-dsh-bundled-${Date.now()}`)
  withDiscovery(({ discovery }) => {
    createSkill(join(bundledRoot, 'bundled-helper'), 'Bundled helper', 'bundled-helper')
    const bundled = discovery.discover().find((item) => item.name === 'bundled-helper')
    assert.equal(bundled?.dshSource, 'bundled')
    assert.equal(bundled?.dshRank, 600)
    assert.equal(bundled?.origin, 'bundled')
    assert.equal(bundled?.readOnly, true)
    assert.equal(bundled?.manageable, false)
    assert.equal(bundled?.visibility['deepseek-harness'].visible, true)
  }, { env: { DSH_BUNDLED_SKILL_DIR: bundledRoot } })
  rmSync(bundledRoot, { recursive: true, force: true })
})
