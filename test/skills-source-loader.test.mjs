import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

import { createSkillSourceLoader } from '../electron/skills/sourceLoader.js'
import { inspectSkillDirectory } from '../electron/skills/fileOps.js'

function createSkill(root, name = 'local-skill', description = 'Local test skill') {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Test\n`)
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

test('generic Git source accepts a private HTTP self-hosted GitLab repository', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-gitlab-private-'))
  const calls = []
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        calls.push(args)
        if (args.includes('clone')) createSkill(args.at(-1))
        if (args.includes('rev-parse')) return 'private-gitlab123\n'
        return ''
      }
    })
    const preview = await loader.inspect({
      type: 'git', url: 'http://10.44.51.32:8080/AI/pr-skills'
    })
    assert.equal(preview.source.type, 'gitlab')
    assert.equal(preview.source.locator, 'http://10.44.51.32:8080/AI/pr-skills')
    assert.equal(calls.some((args) =>
      args[0] === '-c' && args[1] === 'http.proxy=' && args.includes('clone') &&
      args.includes('http://10.44.51.32:8080/AI/pr-skills')
    ), true)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Git repository inspection returns selectable Skills when the repository root is a collection', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-collection-'))
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        if (args[0] === 'clone') {
          const destination = args.at(-1)
          createSkill(join(destination, 'skills', 'engineering', 'tdd'), 'tdd', 'Develop test-first')
          createSkill(join(destination, 'skills', 'productivity', 'grill-me'), 'grill-me', 'Clarify a plan')
        }
        if (args.includes('rev-parse')) return 'collection123\n'
        return ''
      }
    })
    const source = { type: 'git', url: 'https://github.com/example/skills.git' }
    const collection = await loader.inspect(source)
    assert.equal(collection.kind, 'collection')
    assert.deepEqual(collection.skills.map(({ name, description, subdir }) => ({ name, description, subdir })), [
      { name: 'tdd', description: 'Develop test-first', subdir: 'skills/engineering/tdd' },
      { name: 'grill-me', description: 'Clarify a plan', subdir: 'skills/productivity/grill-me' }
    ])
    assert.deepEqual({
      kind: collection.skills[0].kind,
      manifest: collection.skills[0].manifest,
      source: collection.skills[0].source,
      resolvedRevision: collection.skills[0].resolvedRevision,
      hashLength: collection.skills[0].contentSha256?.length
    }, {
      kind: 'skill',
      manifest: { name: 'tdd', description: 'Develop test-first' },
      source: {
        type: 'github',
        locator: 'https://github.com/example/skills.git',
        ref: '',
        subdir: 'skills/engineering/tdd'
      },
      resolvedRevision: 'collection123',
      hashLength: 64
    })

    const nestedCollection = await loader.inspect({ ...source, subdir: 'skills' })
    assert.deepEqual(nestedCollection.skills.map(({ subdir }) => subdir), [
      'skills/engineering/tdd',
      'skills/productivity/grill-me'
    ])

    const selected = await loader.inspect({ ...source, subdir: 'skills/engineering/tdd' })
    assert.equal(selected.kind, 'skill')
    assert.equal(selected.name, 'tdd')
    assert.equal(selected.source.subdir, 'skills/engineering/tdd')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('collection classification does not inspect an entire large repository as one Skill', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-large-collection-'))
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        if (args[0] === 'clone') {
          const destination = args.at(-1)
          mkdirSync(destination, { recursive: true })
          for (let index = 0; index < 2001; index += 1) {
            writeFileSync(join(destination, `repository-file-${index}.txt`), '')
          }
          createSkill(join(destination, 'skills', 'safe-skill'), 'safe-skill', 'A small valid Skill')
        }
        if (args.includes('rev-parse')) return 'largecollection\n'
        return ''
      }
    })

    const preview = await loader.inspect({ type: 'git', url: 'https://github.com/example/large-skills.git' })
    assert.equal(preview.kind, 'collection')
    assert.deepEqual(preview.skills.map(({ name }) => name), ['safe-skill'])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('collection inspection keeps valid Skills when another candidate is invalid', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-partial-collection-'))
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        if (args[0] === 'clone') {
          const destination = args.at(-1)
          createSkill(join(destination, 'skills', 'valid'), 'valid', 'A valid Skill')
          const invalid = join(destination, 'skills', 'invalid')
          mkdirSync(invalid, { recursive: true })
          writeFileSync(join(invalid, 'SKILL.md'), 'not valid frontmatter')
        }
        if (args.includes('rev-parse')) return 'partialcollection\n'
        return ''
      }
    })

    const preview = await loader.inspect({ type: 'git', url: 'https://github.com/example/partial-skills.git' })
    assert.deepEqual(preview.skills.map(({ name }) => name), ['valid'])
    assert.deepEqual(preview.invalidSkills, [{ subdir: 'skills/invalid', code: 'SKILL_MANIFEST_INVALID' }])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('collection traversal stops when its repository scan budget is exceeded', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-budget-collection-'))
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      collectionScanLimits: { maxEntries: 2 },
      runGit(args) {
        if (args[0] === 'clone') {
          const destination = args.at(-1)
          mkdirSync(join(destination, 'one'), { recursive: true })
          mkdirSync(join(destination, 'two'), { recursive: true })
          mkdirSync(join(destination, 'three'), { recursive: true })
        }
        if (args.includes('rev-parse')) return 'budgetcollection\n'
        return ''
      }
    })

    await assert.rejects(
      () => loader.inspect({ type: 'git', url: 'https://github.com/example/budget-skills.git' }),
      (error) => error?.code === 'SKILL_PACKAGE_TOO_LARGE' && /scan limit/.test(error.message)
    )
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

test('batch preparation checks out one pinned repository for multiple Skill subdirectories', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ucli-skill-batch-source-'))
  const calls = []
  try {
    const loader = createSkillSourceLoader({
      stagingRoot: join(temp, 'staging'),
      runGit(args) {
        calls.push(args)
        if (args[0] === 'clone') {
          const destination = args.at(-1)
          createSkill(join(destination, 'skills', 'tdd'), 'tdd', 'Develop test-first')
          createSkill(join(destination, 'skills', 'grill-me'), 'grill-me', 'Clarify a plan')
        }
        if (args.includes('rev-parse')) return 'collection123\n'
        return ''
      }
    })
    const common = {
      type: 'git', url: 'https://github.com/example/skills.git',
      refType: 'default', ref: '', expectedRevision: 'collection123'
    }

    const names = await loader.withPreparedMany([
      { ...common, subdir: 'skills/tdd' },
      { ...common, subdir: 'skills/grill-me' }
    ], async (prepared) => prepared.map((item) => ({
      name: inspectSkillDirectory(item.workingDirectory).name,
      subdir: item.source.subdir,
      revision: item.resolvedRevision
    })))

    assert.deepEqual(names, [
      { name: 'tdd', subdir: 'skills/tdd', revision: 'collection123' },
      { name: 'grill-me', subdir: 'skills/grill-me', revision: 'collection123' }
    ])
    assert.equal(calls.filter((args) => args.includes('clone')).length, 1)
    assert.equal(calls.filter((args) => args.includes('fetch')).length, 1)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
