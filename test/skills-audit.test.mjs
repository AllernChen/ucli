import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditSkills } from '../scripts/audit-skill-discovery.mjs'

function createSkill(root, name, description) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n`)
}

function snapshotDirectory(root) {
  return readdirSync(root, { recursive: true })
    .map((value) => String(value).replaceAll('\\', '/'))
    .sort()
}

test('Skill audit summarizes source kinds and health without mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-skills-audit-'))
  const home = join(root, 'home')
  const projectPath = join(root, 'project')
  try {
    createSkill(join(home, '.agents', 'skills', 'diagnose'), 'diagnose', 'Diagnose bugs')

    const claudeSkills = join(home, '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync(join(home, '.agents', 'skills', 'missing-lark'), join(claudeSkills, 'lark-doc'), 'dir')

    const pluginsRoot = join(home, '.claude', 'plugins')
    const pluginRoot = join(pluginsRoot, 'cache', 'mattpocock-skills', '1.0.0')
    createSkill(join(pluginRoot, 'skills', 'engineering', 'tdd'), 'tdd', 'Test-driven development')
    mkdirSync(pluginsRoot, { recursive: true })
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'mattpocock-skills@mattpocock-skills': [{ scope: 'user', installPath: pluginRoot }]
      }
    }))
    mkdirSync(projectPath, { recursive: true })

    const before = snapshotDirectory(home)
    const report = await auditSkills({ home, projectPath })

    assert.deepEqual(report.countsBySourceKind, {
      claude_plugin: 1,
      claude_user: 1,
      codex_user: 1
    })
    assert.deepEqual(report.countsByHealth, { broken_link: 1, ready: 2 })
    assert.deepEqual(report.locations.map((item) => [item.name, item.sourceKind, item.health]), [
      ['diagnose', 'codex_user', 'ready'],
      ['lark-doc', 'claude_user', 'broken_link'],
      ['tdd', 'claude_plugin', 'ready']
    ])
    assert.deepEqual(snapshotDirectory(home), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
