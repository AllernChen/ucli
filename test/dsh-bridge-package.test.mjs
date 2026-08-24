import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { replaceBridgeArtifact } from '../scripts/package-dsh-bridge.mjs'

const root = path.resolve(import.meta.dirname, '..')
const artifact = path.join(root, 'resources', 'deepseek-harness', 'ucli-dsh-bridge-0.11.0.tgz')

/**
 * Run a pnpm command. CI installs pnpm globally (npm install -g pnpm), so it is
 * resolved from PATH on every platform; UCLI_TEST_PNPM overrides for local hosts
 * where pnpm lives elsewhere. shell:true lets the .cmd shim resolve on Windows.
 */
function spawnPnpm(args, options = {}) {
  const command = process.env.UCLI_TEST_PNPM ||
    (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  return spawnSync(command, args, { shell: process.platform === 'win32', ...options })
}

function readTar(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim()
    const size = Number.parseInt(sizeText || '0', 8)
    const bodyStart = offset + 512
    entries.set(name, buffer.subarray(bodyStart, bodyStart + size))
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return entries
}

test('quarantined bridge manifest remains exactly 0.11.0 for legacy rollback compatibility', async () => {
  const manifest = JSON.parse(await readFile(
    path.join(root, 'integrations', 'deepseek-harness-bridge', 'package.json'),
    'utf8'
  ))
  assert.equal(manifest.name, '@ucli/dsh-bridge')
  assert.equal(manifest.version, '0.11.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, './index.js')
  assert.deepEqual(manifest.exports, {
    '.': './index.js',
    './framing.js': './framing.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json'
  })
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.deepEqual(manifest.files, ['index.js', 'framing.js', 'cordis.patch.yml'])
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false)
  assert.deepEqual(manifest.peerDependencies, {
    '@deepseek-ai/cordis': '4.0.1',
    '@deepseek-ai/dsh-agent': '0.1.0-rc.6',
    '@deepseek-ai/dsh-llm': '0.1.0-rc.6',
    '@deepseek-ai/dsh-sandbox-policy': '0.1.0-rc.6',
    '@deepseek-ai/dsh-session': '0.1.0-rc.6',
    '@deepseek-ai/dsh-tools': '0.1.0-rc.6'
  })
  assert.deepEqual(manifest.peerDependenciesMeta, Object.fromEntries(
    Object.keys(manifest.peerDependencies).map((name) => [name, { optional: true }])
  ))
})

test('quarantined bridge artifact remains installable only for explicit legacy rollback', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'ucli-dsh-rc6-profile-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const profile = path.join(fixture, 'profiles', 'legacy-rollback')
  const runtime = path.join(fixture, 'runtime')
  const peerVersions = {
    '@deepseek-ai/cordis': '4.0.1',
    '@deepseek-ai/dsh-agent': '0.1.0-rc.6',
    '@deepseek-ai/dsh-llm': '0.1.0-rc.6',
    '@deepseek-ai/dsh-sandbox-policy': '0.1.0-rc.6',
    '@deepseek-ai/dsh-session': '0.1.0-rc.6',
    '@deepseek-ai/dsh-tools': '0.1.0-rc.6'
  }
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(fixture, 'pnpm-workspace.yaml'), [
    "packages:",
    "  - 'profiles/*'",
    "  - 'runtime/*'",
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    ''
  ].join('\n'))
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ private: true }))
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'rc6-legacy-rollback-profile',
    private: true,
    dependencies: Object.fromEntries(Object.keys(peerVersions).map((name) => [name, 'workspace:*']))
  }))
  for (const [name, version] of Object.entries(peerVersions)) {
    const packageRoot = path.join(runtime, name.slice('@deepseek-ai/'.length))
    await mkdir(packageRoot, { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version }))
  }

  const installed = spawnPnpm([
    'install', '--offline', '--ignore-scripts', '--reporter=append-only'
  ], {
    cwd: fixture,
    encoding: 'utf8'
  })
  assert.equal(installed.status, 0, installed.stderr || installed.stdout)
  const added = spawnPnpm([
    '--dir', profile, 'add', path.join(root, 'integrations', 'deepseek-harness-bridge'),
    '--offline', '--ignore-scripts', '--reporter=append-only'
  ], { cwd: fixture, encoding: 'utf8' })
  assert.equal(added.status, 0, added.stderr || added.stdout)
  assert.doesNotMatch(`${added.stdout}\n${added.stderr}`, /(?:missing|unmet) peer/iu)

  const bridgeRoot = await realpath(path.join(profile, 'node_modules', '@ucli', 'dsh-bridge'))
  await assert.rejects(access(path.join(bridgeRoot, 'node_modules', '@deepseek-ai')))
  for (const name of Object.keys(peerVersions)) {
    const resolvedPeer = await realpath(path.join(profile, 'node_modules', ...name.split('/')))
    const sourcePeer = await realpath(path.join(runtime, name.slice('@deepseek-ai/'.length)))
    assert.equal(resolvedPeer, sourcePeer)
  }
})

test('packaging writes the deterministic bridge artifact only to an isolated output root', async (t) => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'ucli-dsh-bridge-output-'))
  const outputArtifact = path.join(outputRoot, 'ucli-dsh-bridge-0.11.0.tgz')
  let productionArtifact = null
  try {
    productionArtifact = await readFile(artifact)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  t.after(() => rm(outputRoot, { recursive: true, force: true }))
  const env = {
    ...process.env,
    UCLI_DSH_BRIDGE_OUTPUT_ROOT: outputRoot,
    UCLI_DSH_BRIDGE_TOKEN: 'supersecret-runtime-token'
  }
  const first = spawnSync(process.execPath, ['scripts/package-dsh-bridge.mjs'], {
    cwd: root,
    env,
    encoding: 'utf8'
  })
  assert.equal(first.status, 0, first.stderr)
  const firstBytes = await readFile(outputArtifact)
  const entries = readTar(gunzipSync(firstBytes))
  assert.deepEqual([...entries.keys()], [
    'package/package.json',
    'package/cordis.patch.yml',
    'package/framing.js',
    'package/index.js'
  ])
  const archiveText = Buffer.concat([...entries.values()]).toString('utf8')
  for (const forbidden of [
    'supersecret-runtime-token',
    'pnpm-lock.yaml',
    'package-lock.json',
    'node_modules/',
    '.test.mjs'
  ]) assert.equal(archiveText.includes(forbidden), false, forbidden)

  const second = spawnSync(process.execPath, ['scripts/package-dsh-bridge.mjs'], {
    cwd: root,
    env,
    encoding: 'utf8'
  })
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(await readFile(outputArtifact), firstBytes)
  if (productionArtifact) {
    assert.deepEqual(await readFile(artifact), productionArtifact)
  } else {
    await assert.rejects(access(artifact))
  }
})

test('root lifecycle scripts package the bridge through exactly one builder resource mapping', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['package:dsh-bridge'], 'node scripts/package-dsh-bridge.mjs')
  for (const lifecycle of ['predev', 'prebuild', 'predist', 'predist:win', 'predist:mac']) {
    assert.equal(manifest.scripts[lifecycle], 'npm run package:dsh-bridge')
  }
  const builder = await readFile(path.join(root, 'electron-builder.yml'), 'utf8')
  assert.doesNotMatch(builder, /^\s*- resources\/\*\*\/\*\s*$/mu)
  assert.match(builder, /^\s*- from: resources\/\s*$/mu)
})

test('artifact replacement restores the only previous tgz when final rename fails', async () => {
  const files = new Map([['bridge.tgz', Buffer.from('previous')]])
  const operations = []
  const fs = {
    async writeFile(name, value) {
      operations.push(['write', name])
      files.set(name, Buffer.from(value))
    },
    async rename(from, to) {
      operations.push(['rename', from, to])
      if (from.endsWith('.tmp') && to === 'bridge.tgz') {
        const error = new Error('simulated final rename failure')
        error.code = 'EACCES'
        throw error
      }
      if (!files.has(from)) {
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }
      files.set(to, files.get(from))
      files.delete(from)
    },
    async rm(name) {
      operations.push(['rm', name])
      files.delete(name)
    }
  }
  await assert.rejects(
    replaceBridgeArtifact('bridge.tgz', Buffer.from('next'), { fs, suffix: 'fixed' }),
    /simulated final rename failure/
  )
  assert.equal(files.get('bridge.tgz').toString(), 'previous')
  assert.deepEqual([...files.keys()], ['bridge.tgz'])
  assert.deepEqual(operations, [
    ['write', 'bridge.tgz.fixed.tmp'],
    ['rename', 'bridge.tgz', 'bridge.tgz.fixed.backup'],
    ['rename', 'bridge.tgz.fixed.tmp', 'bridge.tgz'],
    ['rename', 'bridge.tgz.fixed.backup', 'bridge.tgz'],
    ['rm', 'bridge.tgz.fixed.tmp'],
    ['rm', 'bridge.tgz.fixed.backup']
  ])
})

test('artifact replacement removes a partial temporary file when writing fails', async () => {
  const files = new Set()
  const operations = []
  const fs = {
    async writeFile(name) {
      operations.push(['write', name])
      files.add(name)
      throw new Error('simulated partial write failure')
    },
    async rename() {
      assert.fail('rename must not run after a failed temporary write')
    },
    async rm(name) {
      operations.push(['rm', name])
      files.delete(name)
    }
  }
  await assert.rejects(
    replaceBridgeArtifact('bridge.tgz', Buffer.from('next'), { fs, suffix: 'partial' }),
    /simulated partial write failure/
  )
  assert.deepEqual([...files], [])
  assert.deepEqual(operations, [
    ['write', 'bridge.tgz.partial.tmp'],
    ['rm', 'bridge.tgz.partial.tmp'],
    ['rm', 'bridge.tgz.partial.backup']
  ])
})
