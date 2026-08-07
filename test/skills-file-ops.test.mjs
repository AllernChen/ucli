import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  copySkillDirectoryAtomic,
  diffSkillDirectories,
  inspectSkillDirectory,
  removeManagedSkillDirectory
} from '../electron/skills/fileOps.js'

function createSkill(root, { name = 'release-notes', description = 'Prepare release notes', extra = '' } = {}) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n${extra}`)
  mkdirSync(join(root, 'references'), { recursive: true })
  writeFileSync(join(root, 'references', 'format.md'), 'Use markdown.\n')
}

test('inspection hashes real package content and enforces file limits', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-inspect-'))
  try {
    const root = join(temp, 'skill')
    createSkill(root)
    const first = inspectSkillDirectory(root)
    assert.equal(first.name, 'release-notes')
    assert.equal(first.description, 'Prepare release notes')
    assert.deepEqual(first.fileList, ['SKILL.md', 'references/format.md'])
    assert.equal(first.contentSha256.length, 64)

    writeFileSync(join(root, 'references', 'format.md'), 'Use plain text.\n')
    assert.notEqual(inspectSkillDirectory(root).contentSha256, first.contentSha256)
    assert.throws(
      () => inspectSkillDirectory(root, { maxFiles: 1 }),
      (error) => error.code === 'SKILL_PACKAGE_TOO_LARGE'
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('directory diff distinguishes SKILL.md changes from supporting file changes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-diff-'))
  try {
    const before = join(temp, 'before')
    const after = join(temp, 'after')
    createSkill(before)
    createSkill(after)
    writeFileSync(join(after, 'references', 'format.md'), 'Use plain text.\n')
    assert.deepEqual(diffSkillDirectories(before, after), {
      addedFiles: [],
      removedFiles: [],
      changedFiles: ['references/format.md'],
      skillMdChanged: false
    })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('atomic projection refuses conflicts and protects drifted managed files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-project-'))
  try {
    const source = join(temp, 'source')
    const target = join(temp, 'project', '.agents', 'skills', 'release-notes')
    createSkill(source)
    const deployed = copySkillDirectoryAtomic(source, target)
    assert.equal(existsSync(target), true)
    assert.equal(deployed.contentSha256, inspectSkillDirectory(target).contentSha256)

    assert.throws(
      () => copySkillDirectoryAtomic(source, target),
      (error) => error.code === 'SKILL_TARGET_CONFLICT'
    )

    writeFileSync(join(target, 'SKILL.md'), `${readFileSync(join(target, 'SKILL.md'), 'utf8')}\nChanged outside UCLI.`)
    assert.throws(
      () => removeManagedSkillDirectory(target, deployed.contentSha256),
      (error) => error.code === 'SKILL_DRIFTED'
    )
    assert.equal(existsSync(target), true)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('managed projection can be updated and removed only with the expected hash', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-update-'))
  try {
    const source = join(temp, 'source')
    const target = join(temp, 'target')
    createSkill(source)
    const first = copySkillDirectoryAtomic(source, target)

    createSkill(source, { extra: 'Updated instructions.\n' })
    const second = copySkillDirectoryAtomic(source, target, { expectedExistingSha256: first.contentSha256 })
    assert.notEqual(second.contentSha256, first.contentSha256)
    assert.equal(removeManagedSkillDirectory(target, second.contentSha256), true)
    assert.equal(existsSync(target), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
