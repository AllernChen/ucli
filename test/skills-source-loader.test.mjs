import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

import { createSkillSourceLoader } from '../electron/skills/sourceLoader.js'

function createSkill(root) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), '---\nname: local-skill\ndescription: Local test skill\n---\n\n# Test\n')
}

test('local source inspection returns a safe normalized preview', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-source-'))
  try {
    const source = join(temp, 'source')
    const staging = join(temp, 'staging')
    createSkill(source)
    const loader = createSkillSourceLoader({ stagingRoot: staging })
    const preview = await loader.inspect({ type: 'local', path: source })
    assert.equal(preview.name, 'local-skill')
    assert.equal(preview.source.type, 'local')
    assert.equal(preview.source.locator, source)
    assert.equal(preview.fileList.includes('SKILL.md'), true)
    assert.equal('workingDirectory' in preview, false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('GitHub preparation invokes git without placing credentials in metadata', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-github-'))
  const calls = []
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        calls.push(args)
        const destination = args.at(-1)
        if (args[0] === 'clone') createSkill(destination)
        if (args.includes('rev-parse')) return 'abc123\n'
        return ''
      }
    })
    const preview = await loader.inspect({
      type: 'github',
      url: 'https://secret@github.com/example/skills.git',
      ref: 'main'
    })
    assert.equal(preview.source.locator, 'https://github.com/example/skills.git')
    assert.equal(preview.resolvedRevision, 'abc123')
    assert.equal(calls.flat().some((value) => String(value).includes('secret@')), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('GitLab preparation invokes git without placing credentials in metadata', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-gitlab-'))
  const calls = []
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        calls.push(args)
        const destination = args.at(-1)
        if (args[0] === 'clone') createSkill(destination)
        if (args.includes('rev-parse')) return 'gitlab123\n'
        return ''
      }
    })
    const preview = await loader.inspect({
      type: 'gitlab',
      url: 'https://secret@gitlab.com/example/platform/skills.git',
      ref: 'main'
    })
    assert.equal(preview.source.type, 'gitlab')
    assert.equal(preview.source.locator, 'https://gitlab.com/example/platform/skills.git')
    assert.equal(preview.resolvedRevision, 'gitlab123')
    assert.equal(calls.flat().some((value) => String(value).includes('secret@')), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('generic Git source resolves GitLab from the repository hostname', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-git-auto-'))
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        if (args[0] === 'clone') createSkill(args.at(-1))
        if (args.includes('rev-parse')) return 'gitlab-auto123\n'
        return ''
      }
    })
    const preview = await loader.inspect({
      type: 'git', url: 'https://gitlab.com/example/platform/skills.git', ref: 'main'
    })
    assert.equal(preview.source.type, 'gitlab')
    assert.equal(preview.source.locator, 'https://gitlab.com/example/platform/skills.git')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('ZIP source is extracted into a bounded temporary directory', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-zip-'))
  try {
    const archive = join(temp, 'local-skill.zip')
    const zip = new AdmZip()
    zip.addFile('local-skill/SKILL.md', Buffer.from('---\nname: local-skill\ndescription: ZIP test skill\n---\n\n# Test\n'))
    zip.writeZip(archive)
    const loader = createSkillSourceLoader({ stagingRoot: join(temp, 'staging') })
    const preview = await loader.inspect({ type: 'local', path: archive })
    assert.equal(preview.name, 'local-skill')
    assert.equal(preview.description, 'ZIP test skill')
    assert.equal(preview.source.type, 'zip')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('GitHub commit sources fetch and detach the requested commit', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-commit-'))
  const calls = []
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        calls.push(args)
        if (args[0] === 'clone') createSkill(args.at(-1))
        if (args.includes('rev-parse')) return '0123456789012345678901234567890123456789\n'
        return ''
      }
    })
    await loader.inspect({
      type: 'github',
      url: 'https://github.com/example/skills.git',
      refType: 'commit',
      ref: '0123456789012345678901234567890123456789'
    })
    assert.equal(calls.some((args) => args.includes('fetch') && args.includes('0123456789012345678901234567890123456789')), true)
    assert.equal(calls.some((args) => args.includes('checkout') && args.includes('FETCH_HEAD')), true)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
