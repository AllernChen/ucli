import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import {
  DSH_BRIDGE_VERSION,
  SUPPORTED_DSH_VERSION,
  inspectDshRuntime,
  runResolvedProcess,
  resolveDshHome,
  resolveDshLaunch,
  resolveNpmLaunch,
  validateDshProfileName
} from '../electron/adapters/deepSeekHarnessRuntime.js'
import {
  createDshProfileManager,
  registerDshProfileIpc
} from '../electron/adapters/dshProfileManager.js'

const BRIDGE_NAME = '@ucli/dsh-bridge'

function temporaryRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeProfile(home, name, {
  bundles = ['@deepseek-ai/dsh-base', '@example/tui-client'],
  dependencies = {},
  bridgeVersion,
  patch = '[]\n'
} = {}) {
  const directory = path.join(home, 'profiles', name)
  mkdirSync(directory, { recursive: true })
  writeJson(path.join(directory, 'package.json'), {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } }
  })
  writeFileSync(path.join(directory, 'cordis.patch.yml'), patch)
  writeFileSync(path.join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  if (bridgeVersion) {
    const bridgeDirectory = path.join(directory, 'node_modules', '@ucli', 'dsh-bridge')
    writeJson(path.join(bridgeDirectory, 'package.json'), {
      name: BRIDGE_NAME,
      version: bridgeVersion,
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    })
    writeFileSync(path.join(bridgeDirectory, 'cordis.patch.yml'), '[]\n')
  }
  return directory
}

function writeLegacyProfile(home, name = 'legacy') {
  return writeProfile(home, name, {
    bundles: ['@deepseek-ai/dsh-base', '@example/custom', BRIDGE_NAME],
    dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
    bridgeVersion: DSH_BRIDGE_VERSION
  })
}

function readyRuntime(home, overrides = {}) {
  return {
    installed: true,
    compatible: true,
    version: SUPPORTED_DSH_VERSION,
    reason: '',
    pnpmAvailable: true,
    launch: { file: process.execPath, prefixArgs: ['/absolute/dsh/lib/bin.js'] },
    home,
    ...overrides
  }
}

function createManager(home, options = {}) {
  return createDshProfileManager({
    homeDirectory: home,
    tempDirectory: path.join(home, 'app-temp'),
    inspectRuntime: async () => readyRuntime(home),
    execute: async () => ({ code: 0, stdout: '', stderr: '' }),
    ...options
  })
}

test('runtime constants pin the published DSH and UCLI bridge baselines', () => {
  assert.equal(SUPPORTED_DSH_VERSION, '0.1.0-rc.6')
  assert.equal(DSH_BRIDGE_VERSION, '0.11.0')
})

test('DSH home matches rc6 resolve semantics for explicit, env, blank, tilde and relative values', () => {
  const custom = path.resolve('F:\\managed-dsh-home')
  const cwd = path.resolve('F:\\workspace\\project')
  const userHome = path.resolve('C:\\Users\\tester')
  assert.equal(resolveDshHome({ configured: custom, env: { DSH_HOME: 'ignored' }, homeDirectory: userHome, cwd }), custom)
  assert.equal(resolveDshHome({ env: { DSH_HOME: custom }, homeDirectory: userHome, cwd }), custom)
  assert.equal(resolveDshHome({ env: { DSH_HOME: '   ' }, homeDirectory: userHome, cwd }), path.join(userHome, '.dsh'))
  assert.equal(resolveDshHome({ env: { DSH_HOME: '~/custom' }, homeDirectory: userHome, cwd }), path.join(userHome, 'custom'))
  assert.equal(resolveDshHome({ env: { DSH_HOME: '..\\shared' }, homeDirectory: userHome, cwd }), path.resolve(cwd, '..\\shared'))
})

test('profile validation rejects traversal, reserved, control and overlong names', () => {
  for (const value of [
    '', '.', '..', 'node_modules', '../tui', 'a/b', 'a\\b', 'bad\u0000name', 'x'.repeat(129),
    'CON', 'com1', 'LPT9.txt', 'bad:name', 'bad*name', 'bad?name', 'bad<name', 'bad|name', 'trailing.', 'trailing '
  ]) {
    assert.throws(() => validateDshProfileName(value), { code: 'DSH_PROFILE_INVALID' })
  }
  assert.equal(validateDshProfileName('team-tui_01'), 'team-tui_01')
})

test('Windows npm shim resolution returns absolute node and JS entry paths without a shell', {
  skip: process.platform !== 'win32' && 'Windows shim layout is platform-specific'
}, async () => {
  const root = temporaryRoot('ucli-dsh-shim-')
  try {
    const shim = path.join(root, 'dsh.cmd')
    const siblingNode = path.join(root, 'node.exe')
    const packagedExecutable = path.join(root, 'UCLI.exe')
    const packageDirectory = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
    const entry = path.join(packageDirectory, 'lib', 'bin.js')
    mkdirSync(path.dirname(entry), { recursive: true })
    writeFileSync(shim, '@ECHO off\r\n')
    writeFileSync(siblingNode, 'trusted node runtime')
    writeFileSync(packagedExecutable, 'packaged electron runtime')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    writeJson(path.join(packageDirectory, 'package.json'), {
      name: '@deepseek-ai/dsh',
      version: SUPPORTED_DSH_VERSION,
      bin: { dsh: 'lib/bin.js' }
    })
    const launch = resolveDshLaunch({
      env: { PATH: root, PATHEXT: '.CMD;.EXE' },
      platform: 'win32',
      nodeExecutable: packagedExecutable
    })
    assert.deepEqual(launch, {
      file: path.resolve(realpathSync(siblingNode)),
      prefixArgs: [path.resolve(entry)]
    })
    assert.equal(path.isAbsolute(launch.file), true)
    assert.equal(path.isAbsolute(launch.prefixArgs[0]), true)
    assert.equal('shell' in launch, false)

    writeJson(path.join(packageDirectory, 'package.json'), {
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.5',
      bin: { dsh: 'lib/bin.js' }
    })
    const unsupportedLaunch = resolveDshLaunch({
      env: { PATH: root, PATHEXT: '.CMD' }, platform: 'win32', nodeExecutable: packagedExecutable
    })
    assert.ok(unsupportedLaunch)
    const unsupported = await inspectDshRuntime({
      resolveLaunch: () => unsupportedLaunch,
      resolvePnpm: () => true,
      run: async () => ({ code: 0, stdout: '0.1.0-rc.5\n', stderr: '' })
    })
    assert.equal(unsupported.installed, true)
    assert.equal(unsupported.reason, 'unsupported-version')

    writeJson(path.join(packageDirectory, 'package.json'), {
      name: '@deepseek-ai/not-dsh',
      version: SUPPORTED_DSH_VERSION,
      bin: { dsh: 'lib/bin.js' }
    })
    assert.equal(resolveDshLaunch({
      env: { PATH: root, PATHEXT: '.CMD' }, platform: 'win32', nodeExecutable: packagedExecutable
    }), null)

    writeFileSync(path.join(root, 'dsh.exe'), 'not the pinned npm package')
    assert.equal(resolveDshLaunch({
      env: { PATH: root, PATHEXT: '.EXE' }, platform: 'win32', nodeExecutable: packagedExecutable
    }), null)

    writeJson(path.join(packageDirectory, 'package.json'), {
      name: '@deepseek-ai/dsh',
      version: SUPPORTED_DSH_VERSION,
      bin: { dsh: 'lib/bin.js' }
    })
    rmSync(siblingNode)
    assert.equal(resolveDshLaunch({
      env: { PATH: root, PATHEXT: '.CMD' }, platform: 'win32', nodeExecutable: packagedExecutable
    }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('trusted npm resolution binds Windows npm.cmd to its sibling node and npm CLI', {
  skip: process.platform !== 'win32' && 'Windows shim layout is platform-specific'
}, () => {
  const root = temporaryRoot('ucli-npm-shim-')
  try {
    const shim = path.join(root, 'npm.cmd')
    const node = path.join(root, 'node.exe')
    const npmCli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    writeFileSync(shim, '@ECHO off\r\n')
    writeFileSync(node, 'trusted node')
    mkdirSync(path.dirname(npmCli), { recursive: true })
    writeFileSync(npmCli, 'trusted npm cli')

    assert.deepEqual(resolveNpmLaunch({
      env: { PATH: root, PATHEXT: '.CMD;.EXE' }, platform: 'win32'
    }), {
      file: path.resolve(realpathSync(node)),
      prefixArgs: [path.resolve(realpathSync(npmCli))]
    })

    rmSync(npmCli)
    assert.equal(resolveNpmLaunch({
      env: { PATH: root, PATHEXT: '.CMD' }, platform: 'win32'
    }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POSIX npm resolution accepts only an executable from an absolute PATH entry', {
  skip: process.platform === 'win32' && 'POSIX executable resolution is platform-specific'
}, () => {
  const root = temporaryRoot('ucli-posix-npm-')
  try {
    const npm = path.join(root, 'npm')
    writeFileSync(npm, '#!/bin/sh\n')
    chmodSync(npm, 0o755)
    assert.deepEqual(resolveNpmLaunch({ env: { PATH: root }, platform: 'linux' }), {
      file: path.resolve(realpathSync(npm)), prefixArgs: []
    })
    assert.equal(resolveNpmLaunch({ env: { PATH: 'relative-bin' }, platform: 'linux' }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime inspection reports supported, unsupported, unreadable and missing states without raw output', async () => {
  const launch = { file: process.execPath, prefixArgs: ['/absolute/dsh/lib/bin.js'] }
  const cases = [
    {
      name: 'supported',
      resolveLaunch: () => launch,
      run: async () => ({ code: 0, stdout: `${SUPPORTED_DSH_VERSION}\n`, stderr: '' }),
      want: { installed: true, compatible: true, version: SUPPORTED_DSH_VERSION, reason: '' }
    },
    {
      name: 'unsupported',
      resolveLaunch: () => launch,
      run: async () => ({ code: 0, stdout: '0.1.0-rc.5\n', stderr: 'secret' }),
      want: { installed: true, compatible: false, version: '0.1.0-rc.5', reason: 'unsupported-version' }
    },
    {
      name: 'unreadable',
      resolveLaunch: () => launch,
      run: async () => ({ code: 1, stdout: '', stderr: 'provider-token=secret' }),
      want: { installed: true, compatible: false, version: '', reason: 'version-unreadable' }
    },
    {
      name: 'malicious-version-output',
      resolveLaunch: () => launch,
      run: async () => ({ code: 0, stdout: 'token=C:\\Users\\secret\\credentials.json\n', stderr: '' }),
      want: { installed: true, compatible: false, version: '', reason: 'version-unreadable' }
    },
    {
      name: 'missing',
      resolveLaunch: () => null,
      run: async () => assert.fail('missing DSH must not be spawned'),
      want: { installed: false, compatible: false, version: '', reason: 'not-installed' }
    }
  ]
  for (const fixture of cases) {
    const actual = await inspectDshRuntime({
      homeDirectory: homedir(),
      resolveLaunch: fixture.resolveLaunch,
      resolvePnpm: () => null,
      run: fixture.run
    })
    assert.deepEqual({
      installed: actual.installed,
      compatible: actual.compatible,
      version: actual.version,
      reason: actual.reason
    }, fixture.want, fixture.name)
    assert.equal(actual.pnpmAvailable, false)
    assert.equal(JSON.stringify(actual).includes('secret'), false)
  }
})

test('resolved process timeout waits for confirmed tree termination before settling', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 42
  child.kill = () => true
  let terminateCalled = false
  let releaseTermination
  const termination = new Promise(resolve => { releaseTermination = resolve })
  const pending = runResolvedProcess(process.execPath, [], {
    timeoutMs: 1,
    spawnProcess: () => child,
    terminateProcessTree: async () => {
      terminateCalled = true
      await termination
      child.emit('close', -1)
      return true
    }
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(terminateCalled, true)
  child.emit('error', new Error('error while tree termination is still pending'))
  let settled = false
  pending.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  releaseTermination()
  const result = await pending
  assert.equal(result.code, -1)
  assert.equal(result.terminationConfirmed, true)
})

test('profile listing inspects direct safe children and returns only allowlisted status metadata', async () => {
  const home = temporaryRoot('ucli-dsh-profiles-')
  try {
    writeProfile(home, 'ready', {
      bundles: ['@deepseek-ai/dsh-base', '@example/tui-client', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    writeProfile(home, 'outdated', {
      bundles: ['@deepseek-ai/dsh-base', '@example/tui-client', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:old.tgz' },
      bridgeVersion: '0.10.9'
    })
    writeProfile(home, 'plain', { bundles: ['@deepseek-ai/dsh-base'] })
    writeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
    writeProfile(home, 'headless', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] })
    mkdirSync(path.join(home, 'profiles', 'node_modules'), { recursive: true })
    writeFileSync(path.join(home, 'profiles', 'README.txt'), 'not a profile')

    const result = await createManager(home).listProfiles()

    assert.deepEqual(result.runtime, {
      installed: true,
      compatible: true,
      version: SUPPORTED_DSH_VERSION,
      reason: '',
      pnpmAvailable: true
    })
    assert.deepEqual(result.profiles, [
      {
        profileName: 'headless', profileReady: true, surface: 'headless', interactive: false,
        legacyBridgeInstalled: false, legacyBridgeVersion: '', errorCode: null
      },
      {
        profileName: 'outdated', profileReady: true, surface: 'custom', interactive: false,
        legacyBridgeInstalled: true, legacyBridgeVersion: '0.10.9', errorCode: null
      },
      {
        profileName: 'plain', profileReady: true, surface: 'custom', interactive: false,
        legacyBridgeInstalled: false, legacyBridgeVersion: '', errorCode: null
      },
      {
        profileName: 'ready', profileReady: true, surface: 'custom', interactive: false,
        legacyBridgeInstalled: true, legacyBridgeVersion: DSH_BRIDGE_VERSION, errorCode: null
      },
      {
        profileName: 'web', profileReady: true, surface: 'web', interactive: true,
        legacyBridgeInstalled: false, legacyBridgeVersion: '', errorCode: null
      }
    ])
    assert.equal(result.profiles.some(profile => (
      'tuiReady' in profile || 'bridgeInstalled' in profile || 'bridgeCompatible' in profile
    )), false)
    assert.deepEqual(Object.keys(result), ['runtime', 'profiles'])
    assert.equal(JSON.stringify(result).includes(home), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile listing excludes linked children and rejects linked or oversized metadata', async (t) => {
  const home = temporaryRoot('ucli-dsh-contained-profiles-')
  const outside = temporaryRoot('ucli-dsh-outside-profile-')
  try {
    writeProfile(home, 'valid')
    writeProfile(outside, 'target')
    try {
      symlinkSync(path.join(outside, 'profiles', 'target'), path.join(home, 'profiles', 'linked'), 'junction')
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error
      t.diagnostic('profile junction creation is unavailable on this host')
    }
    const linkedMetadata = writeProfile(home, 'linked-metadata')
    const realManifest = path.join(home, 'real-package.json')
    writeFileSync(realManifest, '{}\n')
    rmSync(path.join(linkedMetadata, 'package.json'))
    try {
      symlinkSync(realManifest, path.join(linkedMetadata, 'package.json'), 'file')
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error
      t.diagnostic('metadata symlink creation is unavailable on this host')
    }
    const oversized = writeProfile(home, 'oversized')
    writeFileSync(path.join(oversized, 'package.json'), ' '.repeat(1024 * 1024 + 1))

    const statuses = (await createManager(home).listProfiles()).profiles
    assert.equal(statuses.some(profile => profile.profileName === 'linked'), false)
    assert.equal(statuses.find(profile => profile.profileName === 'linked-metadata')?.errorCode, 'DSH_PROFILE_INVALID')
    assert.equal(statuses.find(profile => profile.profileName === 'oversized')?.errorCode, 'DSH_PROFILE_INVALID')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('legacy bridge status requires dependency, bundle, contained exact manifest and regular patch together', async () => {
  const home = temporaryRoot('ucli-dsh-bridge-triad-')
  try {
    const missingDependency = writeProfile(home, 'missing-dependency', {
      bundles: ['@deepseek-ai/dsh-base', '@example/tui-client', BRIDGE_NAME],
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    const missingBundle = writeProfile(home, 'missing-bundle', {
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    const missingPatch = writeProfile(home, 'missing-patch', {
      bundles: ['@deepseek-ai/dsh-base', '@example/tui-client', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    rmSync(path.join(missingPatch, 'node_modules', '@ucli', 'dsh-bridge', 'cordis.patch.yml'))
    const wrongName = writeProfile(home, 'wrong-name', {
      bundles: ['@deepseek-ai/dsh-base', '@example/tui-client', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    const wrongManifest = JSON.parse(readFileSync(path.join(wrongName, 'node_modules', '@ucli', 'dsh-bridge', 'package.json')))
    wrongManifest.name = '@attacker/not-bridge'
    writeJson(path.join(wrongName, 'node_modules', '@ucli', 'dsh-bridge', 'package.json'), wrongManifest)
    writeProfile(home, 'duplicate-bundle', {
      bundles: ['@deepseek-ai/dsh-base', '@example/tui-client', BRIDGE_NAME, BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    assert.ok(missingDependency && missingBundle)

    const byName = Object.fromEntries((await createManager(home).listProfiles()).profiles.map(value => [value.profileName, value]))
    for (const name of ['duplicate-bundle', 'missing-dependency', 'missing-bundle', 'missing-patch', 'wrong-name']) {
      assert.equal(byName[name].legacyBridgeInstalled, false, name)
      assert.equal(byName[name].legacyBridgeVersion, byName[name].legacyBridgeVersion || '', name)
      assert.equal(byName[name].errorCode, null, name)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile metadata bounds dependency specs, package names, version output and profile count', async () => {
  const home = temporaryRoot('ucli-dsh-profile-bounds-')
  try {
    const invalidDependency = writeProfile(home, 'invalid-dependency', {
      bundles: ['@deepseek-ai/dsh-base', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: { attacker: true } },
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    assert.ok(invalidDependency)
    writeProfile(home, 'invalid-bundle', { bundles: ['@deepseek-ai/dsh-base', '../escape'] })
    const longVersion = writeProfile(home, 'long-version', {
      bundles: ['@deepseek-ai/dsh-base', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: `0.11.0-${'x'.repeat(5000)}`
    })
    assert.ok(longVersion)
    for (let index = 0; index < 260; index += 1) writeProfile(home, `profile-${String(index).padStart(3, '0')}`)

    const result = await createManager(home).listProfiles()
    assert.equal(result.profiles.length, 256)
    assert.equal(result.profiles.find(value => value.profileName === 'invalid-dependency')?.errorCode, 'DSH_PROFILE_INVALID')
    assert.equal(result.profiles.find(value => value.profileName === 'invalid-bundle')?.errorCode, 'DSH_PROFILE_INVALID')
    const longVersionStatus = result.profiles.find(value => value.profileName === 'long-version')
    assert.equal(longVersionStatus?.legacyBridgeInstalled, true)
    assert.equal(longVersionStatus?.legacyBridgeVersion, '')
    assert.equal(JSON.stringify(result).includes('x'.repeat(100)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('malformed profile metadata is isolated as a stable invalid status', async () => {
  const home = temporaryRoot('ucli-dsh-invalid-profile-')
  try {
    const directory = writeProfile(home, 'broken')
    writeFileSync(path.join(directory, 'package.json'), '{not-json')
    const result = await createManager(home).listProfiles()
    assert.deepEqual(result.profiles, [{
      profileName: 'broken', profileReady: false, surface: 'custom', interactive: false,
      legacyBridgeInstalled: false, legacyBridgeVersion: '', errorCode: 'DSH_PROFILE_INVALID'
    }])
    assert.equal(JSON.stringify(result).includes('not-json'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('missing optional profile patch remains structurally ready under rc6 semantics', async () => {
  const home = temporaryRoot('ucli-dsh-optional-patch-')
  try {
    const profile = writeProfile(home, 'no-user-patch')
    rmSync(path.join(profile, 'cordis.patch.yml'))
    const status = (await createManager(home).listProfiles()).profiles[0]
    assert.equal(status.profileName, 'no-user-patch')
    assert.equal(status.profileReady, true)
    assert.equal(status.errorCode, null)
    assert.equal(status.surface, 'custom')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('missing optional bundle list is a valid empty rc6 profile', async () => {
  const home = temporaryRoot('ucli-dsh-optional-bundles-')
  try {
    const profile = writeProfile(home, 'empty-profile')
    writeJson(path.join(profile, 'package.json'), {
      name: 'dsh-profile-empty-profile',
      private: true,
      dependencies: {}
    })
    const status = (await createManager(home).listProfiles()).profiles[0]
    assert.equal(status.profileName, 'empty-profile')
    assert.equal(status.profileReady, true)
    assert.equal(status.errorCode, null)
    assert.equal(status.surface, 'custom')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('legacy bridge removal uses exact fixed argv and returns sanitized profile status', async () => {
  const home = temporaryRoot('ucli-dsh-remove-legacy-')
  try {
    const profile = writeProfile(home, 'legacy', {
      bundles: ['@deepseek-ai/dsh-base', '@example/custom', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: DSH_BRIDGE_VERSION
    })
    const before = readFileSync(path.join(profile, 'package.json'), 'utf8')
    const calls = []
    const manager = createManager(home, {
      env: {
        PATH: process.env.PATH,
        UCLI_DSH_BRIDGE_TOKEN: 'must-not-reach-profile-init',
        ucli_dsh_bridge_endpoint: 'must-not-reach-profile-init'
      },
      execute: async (file, args, options) => {
        calls.push({ file, args, options })
        const manifestFile = path.join(profile, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
        delete manifest.dependencies[BRIDGE_NAME]
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== BRIDGE_NAME)
        writeJson(manifestFile, manifest)
        rmSync(path.join(profile, 'node_modules', '@ucli', 'dsh-bridge'), { recursive: true, force: true })
        return { code: 0, stdout: 'sensitive removal output', stderr: '' }
      }
    })

    await manager.listProfiles()
    assert.equal(readFileSync(path.join(profile, 'package.json'), 'utf8'), before)

    const result = await manager.removeLegacyBridge('legacy')
    assert.equal(result.ok, true)
    assert.equal(result.errorCode, null)
    assert.equal(result.profile.legacyBridgeInstalled, false)
    assert.equal(result.profile.legacyBridgeVersion, '')
    assert.equal(result.profile.surface, 'custom')
    assert.equal(JSON.stringify(result).includes('sensitive removal output'), false)
    assert.equal(calls.length, 1)
    assert.equal(path.isAbsolute(calls[0].file), true)
    assert.deepEqual(calls[0].args, [
      '/absolute/dsh/lib/bin.js', 'plugin', '--profile', 'legacy',
      'remove', BRIDGE_NAME, '--config.ignore-scripts=true'
    ])
    assert.equal(calls[0].options.shell, false)
    assert.equal(calls[0].options.env.DSH_HOME, home)
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(calls[0].options.env.UCLI_DSH_BRIDGE_TOKEN, undefined)
    assert.equal(calls[0].options.env.ucli_dsh_bridge_endpoint, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile initialization creates one native base profile through fixed shell-free DSH arguments', async () => {
  const home = temporaryRoot('ucli-dsh-initialize-')
  try {
    const calls = []
    const manager = createManager(home, {
      execute: async (file, args, options) => {
        calls.push({ file, args, options })
        writeProfile(home, 'team-tui', { bundles: ['@deepseek-ai/dsh-base'] })
        return { code: 0, stdout: 'sensitive profile path', stderr: '' }
      }
    })

    const result = await manager.initializeProfile('team-tui')

    assert.deepEqual(result, {
      ok: true,
      errorCode: null,
      profile: {
        profileName: 'team-tui',
        profileReady: true,
        surface: 'custom',
        interactive: false,
        legacyBridgeInstalled: false,
        legacyBridgeVersion: '',
        errorCode: null
      }
    })
    assert.equal(JSON.stringify(result).includes(home), false)
    assert.equal(JSON.stringify(result).includes('sensitive profile path'), false)
    assert.equal(calls.length, 1)
    assert.equal(path.isAbsolute(calls[0].file), true)
    assert.deepEqual(calls[0].args, [
      '/absolute/dsh/lib/bin.js', 'plugin', '--profile', 'team-tui', 'install', '--ignore-scripts'
    ])
    assert.equal(calls[0].options.shell, false)
    assert.equal(calls[0].options.env.DSH_HOME, home)
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile initialization rejects and removes web, headless, and legacy bridge output', async () => {
  for (const fixture of [
    { name: 'web-output', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
    { name: 'headless-output', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] },
    {
      name: 'dependency-only-output',
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' }
    },
    {
      name: 'bundle-partial-output',
      bundles: ['@deepseek-ai/dsh-base', BRIDGE_NAME]
    },
    {
      name: 'installed-file-only-output',
      bundles: ['@deepseek-ai/dsh-base'],
      bridgeVersion: DSH_BRIDGE_VERSION
    },
    {
      name: 'legacy-output',
      bundles: ['@deepseek-ai/dsh-base', '@example/custom', BRIDGE_NAME],
      dependencies: { [BRIDGE_NAME]: 'file:bridge.tgz' },
      bridgeVersion: DSH_BRIDGE_VERSION
    }
  ]) {
    const home = temporaryRoot(`ucli-dsh-initialize-${fixture.name}-`)
    try {
      const manager = createManager(home, {
        execute: async () => {
          writeProfile(home, fixture.name, fixture)
          return { code: 0, stdout: `private:${home}`, stderr: '' }
        }
      })

      assert.deepEqual(await manager.initializeProfile(fixture.name), {
        ok: false, errorCode: 'DSH_PROFILE_INITIALIZE_FAILED', profile: null
      })
      assert.equal(existsSync(path.join(home, 'profiles', fixture.name)), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('profile initialization rolls back partial nonzero output and verifies deletion', async () => {
  const cleanHome = temporaryRoot('ucli-dsh-initialize-nonzero-')
  try {
    const manager = createManager(cleanHome, {
      execute: async () => {
        writeProfile(cleanHome, 'partial', { bundles: ['@deepseek-ai/dsh-base'] })
        return { code: 1, stderr: `private:${cleanHome}` }
      }
    })
    assert.deepEqual(await manager.initializeProfile('partial'), {
      ok: false, errorCode: 'DSH_PROFILE_INITIALIZE_FAILED', profile: null
    })
    assert.equal(existsSync(path.join(cleanHome, 'profiles', 'partial')), false)
  } finally {
    rmSync(cleanHome, { recursive: true, force: true })
  }

  for (const mode of ['throw', 'noop']) {
    const home = temporaryRoot(`ucli-dsh-initialize-rollback-${mode}-`)
    try {
      const nativeRm = (await import('node:fs/promises')).rm
      const manager = createManager(home, {
        execute: async () => {
          writeProfile(home, 'partial', { bundles: ['@deepseek-ai/dsh-base'] })
          return { code: 1, stderr: `private:${home}` }
        },
        fileOps: {
          rm: async (target, options) => {
            if (path.basename(target) === 'partial' && options?.recursive) {
              if (mode === 'throw') throw Object.assign(new Error(`private:${target}`), { code: 'EACCES' })
              return
            }
            return nativeRm(target, options)
          }
        }
      })
      const result = await manager.initializeProfile('partial')
      assert.deepEqual(result, {
        ok: false, errorCode: 'DSH_PROFILE_INITIALIZE_ROLLBACK_FAILED', profile: null
      })
      assert.equal(JSON.stringify(result).includes(home), false)
      assert.equal(existsSync(path.join(home, 'profiles', 'partial')), true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('profile initialization never races rollback against an unconfirmed live descendant', async () => {
  const home = temporaryRoot('ucli-dsh-initialize-live-descendant-')
  try {
    const manager = createManager(home, {
      execute: async () => {
        writeProfile(home, 'partial', { bundles: ['@deepseek-ai/dsh-base'] })
        return { code: -1, terminationConfirmed: false, stderr: `private:${home}` }
      }
    })
    const result = await manager.initializeProfile('partial')
    assert.deepEqual(result, {
      ok: false, errorCode: 'DSH_PROFILE_INITIALIZE_ROLLBACK_FAILED', profile: null
    })
    assert.equal(JSON.stringify(result).includes(home), false)
    assert.equal(existsSync(path.join(home, 'profiles', 'partial')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profile initialization never overwrites an existing native profile and coalesces concurrent requests', async () => {
  const home = temporaryRoot('ucli-dsh-initialize-guards-')
  try {
    writeProfile(home, 'existing')
    let executions = 0
    let release
    let markStarted
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { markStarted = resolve })
    const manager = createManager(home, {
      execute: async () => {
        executions += 1
        markStarted()
        await gate
        writeProfile(home, 'new-profile', { bundles: ['@deepseek-ai/dsh-base'] })
        return { code: 0 }
      }
    })

    assert.deepEqual(await manager.initializeProfile('existing'), {
      ok: false, errorCode: 'DSH_PROFILE_ALREADY_EXISTS', profile: null
    })
    assert.equal(executions, 0)

    const first = manager.initializeProfile('new-profile')
    const second = manager.initializeProfile('new-profile')
    await started
    assert.equal(executions, 1)
    release()
    assert.deepEqual(await second, await first)
    assert.equal(executions, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('legacy removal transaction accepts a bounded multi-megabyte pnpm lock and restores it exactly', async () => {
  const home = temporaryRoot('ucli-dsh-large-lock-')
  try {
    const profile = writeLegacyProfile(home, 'tui')
    const lock = path.join(profile, 'pnpm-lock.yaml')
    const original = Buffer.alloc(2 * 1024 * 1024, 0x61)
    writeFileSync(lock, original)
    let executed = false
    const manager = createManager(home, {
      execute: async () => {
        executed = true
        writeFileSync(lock, 'changed')
        return { code: 1, stdout: '', stderr: '' }
      }
    })
    assert.equal((await manager.removeLegacyBridge('tui')).errorCode, 'DSH_BRIDGE_REMOVE_FAILED')
    assert.equal(executed, true)
    assert.deepEqual(readFileSync(lock), original)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('unconfirmed timeout never races rollback against a possibly live pnpm descendant', async () => {
  const home = temporaryRoot('ucli-dsh-timeout-')
  try {
    const profile = writeLegacyProfile(home, 'tui')
    const manifest = path.join(profile, 'package.json')
    const manager = createManager(home, {
      execute: async () => {
        writeFileSync(manifest, '{"mutatedWhileDescendantMayLive":true}\n')
        return { code: -1, stdout: '', stderr: '', terminationConfirmed: false }
      }
    })
    const result = await manager.removeLegacyBridge('tui')
    assert.deepEqual(result, { ok: false, errorCode: 'DSH_BRIDGE_ROLLBACK_FAILED', profile: null })
    assert.equal(readFileSync(manifest, 'utf8'), '{"mutatedWhileDescendantMayLive":true}\n')
    assert.equal(readdirSync(path.join(home, 'app-temp')).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rollback restoration failure has an explicit stable outcome and preserves recovery backup', async () => {
  const home = temporaryRoot('ucli-dsh-rollback-failure-')
  try {
    const profile = writeLegacyProfile(home, 'tui')
    const nativeRename = (await import('node:fs/promises')).rename
    const manager = createManager(home, {
      execute: async () => {
        writeFileSync(path.join(profile, 'package.json'), '{"changed":true}\n')
        return { code: 1, stdout: '', stderr: '' }
      },
      fileOps: {
        rename: async (source, target) => {
          if (path.basename(source).startsWith('.package.json.ucli-restore-')) {
            throw Object.assign(new Error('restore denied'), { code: 'EACCES' })
          }
          return nativeRename(source, target)
        }
      }
    })
    assert.deepEqual(await manager.removeLegacyBridge('tui'), {
      ok: false, errorCode: 'DSH_BRIDGE_ROLLBACK_FAILED', profile: null
    })
    const backups = readdirSync(path.join(home, 'app-temp'))
    assert.equal(backups.length, 1)
    assert.equal(existsSync(path.join(home, 'app-temp', backups[0], 'package.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('failed legacy bridge removal restores only the four metadata files and keeps user content', async () => {
  const home = temporaryRoot('ucli-dsh-rollback-')
  try {
    const profile = writeLegacyProfile(home, 'tui')
    writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'before-lock\n')
    writeFileSync(path.join(profile, 'keep.txt'), 'keep me')
    const metadata = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']
    const before = Object.fromEntries(metadata.map(name => [name, readFileSync(path.join(profile, name), 'utf8')]))
    const manager = createManager(home, {
      execute: async () => {
        for (const name of metadata) writeFileSync(path.join(profile, name), `changed-${name}`)
        writeFileSync(path.join(profile, 'new-user-file.txt'), 'leave me')
        return { code: 9, stdout: '', stderr: 'registry credential leaked here' }
      }
    })

    const result = await manager.removeLegacyBridge('tui')

    assert.deepEqual(result, { ok: false, errorCode: 'DSH_BRIDGE_REMOVE_FAILED', profile: null })
    for (const name of metadata) assert.equal(readFileSync(path.join(profile, name), 'utf8'), before[name])
    assert.equal(readFileSync(path.join(profile, 'keep.txt'), 'utf8'), 'keep me')
    assert.equal(readFileSync(path.join(profile, 'new-user-file.txt'), 'utf8'), 'leave me')
    assert.equal(existsSync(path.join(home, 'app-temp')) ? readdirSync(path.join(home, 'app-temp')).length : 0, 0)
    assert.equal(JSON.stringify(result).includes(home), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rollback removes originally missing metadata and preserves original file mode', {
  skip: process.platform === 'win32' && 'POSIX file mode restoration is covered on macOS/Linux'
}, async () => {
  const home = temporaryRoot('ucli-dsh-rollback-mode-')
  try {
    const profile = writeLegacyProfile(home, 'tui')
    const lock = path.join(profile, 'pnpm-lock.yaml')
    const manifest = path.join(profile, 'package.json')
    chmodSync(manifest, 0o640)
    const manager = createManager(home, {
      execute: async () => {
        writeFileSync(lock, 'new lock\n')
        chmodSync(manifest, 0o600)
        return { code: 1, stdout: '', stderr: '' }
      }
    })
    assert.equal((await manager.removeLegacyBridge('tui')).errorCode, 'DSH_BRIDGE_REMOVE_FAILED')
    assert.equal(existsSync(lock), false)
    assert.equal((await import('node:fs')).statSync(manifest).mode & 0o777, 0o640)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('post-check failure restores metadata and concurrent legacy removals coalesce per profile', async () => {
  const home = temporaryRoot('ucli-dsh-concurrent-')
  try {
    const profile = writeLegacyProfile(home, 'tui')
    const before = readFileSync(path.join(profile, 'package.json'), 'utf8')
    let release
    const gate = new Promise(resolve => { release = resolve })
    let executions = 0
    const manager = createManager(home, {
      execute: async () => {
        executions += 1
        const manifestFile = path.join(profile, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== BRIDGE_NAME)
        writeJson(manifestFile, manifest)
        await gate
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    const first = manager.removeLegacyBridge('tui')
    const second = manager.removeLegacyBridge('tui')
    while (executions === 0) await new Promise(resolve => setImmediate(resolve))
    assert.equal(executions, 1)
    release()
    const [left, right] = await Promise.all([first, second])
    assert.deepEqual(left, { ok: false, errorCode: 'DSH_BRIDGE_REMOVE_FAILED', profile: null })
    assert.deepEqual(right, left)
    assert.equal(readFileSync(path.join(profile, 'package.json'), 'utf8'), before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('legacy bridge removal fails closed for invalid profile, incompatible runtime, missing pnpm and absent bridge', async () => {
  const home = temporaryRoot('ucli-dsh-guards-')
  try {
    writeLegacyProfile(home, 'tui')
    writeProfile(home, 'plain')
    let executions = 0
    const execute = async () => { executions += 1; return { code: 0, stdout: '', stderr: '' } }
    const invalid = createManager(home, { execute })
    assert.deepEqual(await invalid.removeLegacyBridge('../tui'), {
      ok: false, errorCode: 'DSH_PROFILE_INVALID', profile: null
    })
    const incompatible = createManager(home, {
      execute,
      inspectRuntime: async () => readyRuntime(home, {
        compatible: false,
        version: '0.1.0-rc.5',
        reason: 'unsupported-version'
      })
    })
    assert.equal((await incompatible.removeLegacyBridge('tui')).errorCode, 'DSH_VERSION_UNSUPPORTED')
    const noPnpm = createManager(home, {
      execute,
      inspectRuntime: async () => readyRuntime(home, { pnpmAvailable: false })
    })
    assert.equal((await noPnpm.removeLegacyBridge('tui')).errorCode, 'DSH_BRIDGE_REMOVE_FAILED')
    assert.equal((await invalid.removeLegacyBridge('plain')).errorCode, 'DSH_BRIDGE_NOT_INSTALLED')
    assert.equal(executions, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('transaction temp setup failures return a stable sanitized status before execution', async () => {
  const home = temporaryRoot('ucli-dsh-temp-failure-')
  try {
    writeLegacyProfile(home, 'tui')
    let executions = 0
    const manager = createManager(home, {
      execute: async () => { executions += 1; return { code: 0, stdout: '', stderr: '' } },
      fileOps: {
        mkdir: async () => {
          throw Object.assign(new Error(`access denied at ${home}\\private`), { code: 'EACCES' })
        }
      }
    })
    const result = await manager.removeLegacyBridge('tui')
    assert.deepEqual(result, { ok: false, errorCode: 'DSH_BRIDGE_REMOVE_FAILED', profile: null })
    assert.equal(JSON.stringify(result).includes(home), false)
    assert.equal(executions, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an out-of-root transaction candidate is never recursively removed before containment is proven', async () => {
  const home = temporaryRoot('ucli-dsh-temp-containment-')
  try {
    writeLegacyProfile(home, 'tui')
    const outside = path.join(home, 'outside-transaction')
    mkdirSync(outside)
    const removed = []
    const manager = createManager(home, {
      execute: async () => assert.fail('an unsafe transaction root must not execute DSH'),
      fileOps: {
        mkdtemp: async () => outside,
        rm: async (target, options) => {
          removed.push(target)
          return (await import('node:fs/promises')).rm(target, options)
        }
      }
    })

    assert.deepEqual(await manager.removeLegacyBridge('tui'), {
      ok: false, errorCode: 'DSH_BRIDGE_REMOVE_FAILED', profile: null
    })
    assert.deepEqual(removed, [])
    assert.equal(existsSync(outside), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an in-root unowned transaction candidate is never used or recursively removed', async () => {
  const home = temporaryRoot('ucli-dsh-temp-owner-')
  try {
    writeLegacyProfile(home, 'tui')
    const tempRoot = path.join(home, 'app-temp')
    const unowned = path.join(tempRoot, 'ucli-dsh-profile-abcdef')
    mkdirSync(unowned, { recursive: true })
    writeFileSync(path.join(unowned, 'keep.txt'), 'keep')
    const removed = []
    let executed = false
    const manager = createManager(home, {
      execute: async () => { executed = true; return { code: 1 } },
      fileOps: {
        mkdtemp: async () => unowned,
        rm: async (target, options) => {
          removed.push(target)
          return (await import('node:fs/promises')).rm(target, options)
        }
      }
    })

    assert.deepEqual(await manager.removeLegacyBridge('tui'), {
      ok: false, errorCode: 'DSH_BRIDGE_REMOVE_FAILED', profile: null
    })
    assert.equal(executed, false)
    assert.equal(removed.includes(unowned), false)
    assert.equal(readFileSync(path.join(unowned, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a swapped transaction directory or forged owner marker is never recursively removed', async () => {
  const home = temporaryRoot('ucli-dsh-temp-owner-swap-')
  try {
    writeLegacyProfile(home, 'tui')
    const tempRoot = path.join(home, 'app-temp')
    let swappedDirectory = null
    const managerRemoved = []
    const nativeRm = (await import('node:fs/promises')).rm
    const manager = createManager(home, {
      execute: async () => {
        const [name] = readdirSync(tempRoot).filter(value => value.startsWith('ucli-dsh-profile-'))
        swappedDirectory = path.join(tempRoot, name)
        rmSync(swappedDirectory, { recursive: true, force: true })
        mkdirSync(swappedDirectory)
        writeFileSync(path.join(swappedDirectory, '.ucli-dsh-profile-owner.json'), '{"forged":true}\n')
        writeFileSync(path.join(swappedDirectory, 'keep.txt'), 'keep')
        return { code: 1 }
      },
      fileOps: {
        rm: async (target, options) => {
          managerRemoved.push(target)
          return nativeRm(target, options)
        }
      }
    })

    assert.deepEqual(await manager.removeLegacyBridge('tui'), {
      ok: false, errorCode: 'DSH_BRIDGE_CLEANUP_FAILED', profile: null
    })
    assert.equal(managerRemoved.includes(swappedDirectory), false)
    assert.equal(readFileSync(path.join(swappedDirectory, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('legacy removal surfaces backup cleanup failure and retries the internal cleanup without renderer paths', async () => {
  const home = temporaryRoot('ucli-dsh-cleanup-retry-')
  try {
    const profile = writeLegacyProfile(home, 'legacy')
    let executions = 0
    let cleanupAttempts = 0
    let releaseCleanup
    let markCleanupStarted
    const cleanupGate = new Promise(resolve => { releaseCleanup = resolve })
    const cleanupStarted = new Promise(resolve => { markCleanupStarted = resolve })
    const nativeRm = (await import('node:fs/promises')).rm
    const manager = createManager(home, {
      execute: async () => {
        executions += 1
        const manifestFile = path.join(profile, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
        delete manifest.dependencies[BRIDGE_NAME]
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== BRIDGE_NAME)
        writeJson(manifestFile, manifest)
        rmSync(path.join(profile, 'node_modules', '@ucli', 'dsh-bridge'), { recursive: true, force: true })
        return { code: 0, stdout: `private:${home}`, stderr: '' }
      },
      fileOps: {
        rm: async (target, options) => {
          if (options?.recursive && path.basename(target).startsWith('ucli-dsh-profile-')) {
            cleanupAttempts += 1
            if (cleanupAttempts === 1) throw Object.assign(new Error(`private:${target}`), { code: 'EACCES' })
            if (cleanupAttempts === 2) {
              markCleanupStarted()
              await cleanupGate
            }
          }
          return nativeRm(target, options)
        }
      }
    })

    const first = await manager.removeLegacyBridge('legacy')
    assert.deepEqual(first, { ok: false, errorCode: 'DSH_BRIDGE_CLEANUP_FAILED', profile: null })
    assert.equal(JSON.stringify(first).includes(home), false)
    assert.equal(executions, 1)
    assert.equal(readdirSync(path.join(home, 'app-temp')).length, 1)

    const firstRetry = manager.removeLegacyBridge('legacy', { path: home, command: 'ignored' })
    await cleanupStarted
    const concurrentRetry = manager.removeLegacyBridge('legacy', { version: 'ignored' })
    releaseCleanup()
    const [retried, coalesced] = await Promise.all([firstRetry, concurrentRetry])
    assert.deepEqual(coalesced, retried)
    assert.equal(retried.ok, true)
    assert.equal(retried.profile.legacyBridgeInstalled, false)
    assert.equal(executions, 1)
    assert.equal(cleanupAttempts, 2)
    assert.equal(readdirSync(path.join(home, 'app-temp')).length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH IPC exposes only fixed managed-runtime and profile operations', async () => {
  const handlers = new Map()
  const received = []
  const profileManager = {
    listProfiles: async () => ({ runtime: {}, profiles: [] }),
    initializeProfile: async name => { received.push(['initialize', name]); return { ok: true, errorCode: null, profile: null } },
    removeLegacyBridge: async name => { received.push(['removeLegacyBridge', name]); return { ok: true, errorCode: null, profile: null } }
  }
  const runtimeManager = {
    getState: async (...args) => { received.push(['getState', args]); return { status: 'missing' } },
    install: async (...args) => { received.push(['install', args]); return { status: 'healthy' } },
    upgrade: async (...args) => { received.push(['upgrade', args]); return { status: 'healthy' } },
    repair: async (...args) => { received.push(['repair', args]); return { status: 'healthy' } },
    remove: async (...args) => { received.push(['remove', args]); return { status: 'missing' } }
  }
  registerDshProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    profileManager,
    runtimeManager
  })
  assert.deepEqual([...handlers.keys()], [
    'dsh:getState',
    'dsh:listProfiles',
    'dsh:initializeProfile',
    'dsh:installRuntime',
    'dsh:upgradeRuntime',
    'dsh:repairRuntime',
    'dsh:removeRuntime',
    'dsh:removeLegacyBridge'
  ])
  const malicious = { version: 'latest', registry: 'https://evil.invalid', command: 'rm -rf' }
  await handlers.get('dsh:getState')({ sender: 'renderer' }, malicious)
  assert.deepEqual(await handlers.get('dsh:listProfiles')({ sender: 'renderer' }), { runtime: {}, profiles: [] })
  await handlers.get('dsh:initializeProfile')({ sender: 'renderer' }, 'team-web', malicious)
  await handlers.get('dsh:installRuntime')({ sender: 'renderer' }, malicious)
  await handlers.get('dsh:upgradeRuntime')({ sender: 'renderer' }, malicious)
  await handlers.get('dsh:repairRuntime')({ sender: 'renderer' }, malicious)
  await handlers.get('dsh:removeRuntime')({ sender: 'renderer' }, malicious)
  await handlers.get('dsh:removeLegacyBridge')({ sender: 'renderer' }, 'legacy', malicious)
  assert.deepEqual(received, [
    ['getState', []],
    ['initialize', 'team-web'],
    ['install', []],
    ['upgrade', []],
    ['repair', []],
    ['remove', []],
    ['removeLegacyBridge', 'legacy']
  ])
})

test('preload and renderer wrappers expose fixed DSH runtime actions without bridge enablement', () => {
  const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  const renderer = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
  for (const [name, channel] of [
    ['getDshState', 'dsh:getState'],
    ['installDshRuntime', 'dsh:installRuntime'],
    ['upgradeDshRuntime', 'dsh:upgradeRuntime'],
    ['repairDshRuntime', 'dsh:repairRuntime'],
    ['removeDshRuntime', 'dsh:removeRuntime']
  ]) {
    assert.match(preload, new RegExp(`${name}: \\(\\) => ipcRenderer\\.invoke\\('${channel}'\\)`))
    assert.match(renderer, new RegExp(`${name}: \\(\\) => u\\.${name}\\(\\)`))
  }
  assert.match(preload, /removeDshLegacyBridge: \(profileName\) => ipcRenderer\.invoke\('dsh:removeLegacyBridge', profileName\)/)
  assert.match(renderer, /removeDshLegacyBridge: \(profileName\) => u\.removeDshLegacyBridge\(profileName\)/)
  assert.doesNotMatch(preload, /enableDshBridge|dsh:enableBridge/)
  assert.doesNotMatch(renderer, /enableDshBridge/)
})

test('orchestrator composes managed runtime and profile operations into live IPC channels', async () => {
  register('./fixtures/electron-stub-loader.mjs', import.meta.url)
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const root = temporaryRoot('ucli-dsh-orchestrator-ipc-')
  const previous = process.env.UCLI_TEST_USER_DATA
  process.env.UCLI_TEST_USER_DATA = root
  let orchestrator
  try {
    const module = await import(`../electron/orchestrator.js?dsh-ipc=${Date.now()}`)
    orchestrator = module.createOrchestrator()
    orchestrator.registerIpc()
    assert.deepEqual([...handlers.keys()].filter(channel => channel.startsWith('dsh:')), [
      'dsh:getState', 'dsh:listProfiles', 'dsh:initializeProfile',
      'dsh:installRuntime', 'dsh:upgradeRuntime', 'dsh:repairRuntime',
      'dsh:removeRuntime', 'dsh:removeLegacyBridge'
    ])
    const state = await handlers.get('dsh:getState')({ sender: 'renderer' }, { path: root })
    assert.deepEqual(Object.keys(state), [
      'revision', 'supportedVersion', 'managed', 'system', 'selected', 'action', 'busy', 'errorCode'
    ])
    const result = await handlers.get('dsh:listProfiles')({ sender: 'renderer' })
    assert.deepEqual(Object.keys(result), ['runtime', 'profiles'])
    assert.equal(JSON.stringify(result).includes(root), false)
  } finally {
    await orchestrator?.shutdown()
    if (previous === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('orchestrator quiescent gate stops owned DSH Web adapters and retains a failed handle', async () => {
  register('./fixtures/electron-stub-loader.mjs', import.meta.url)
  const module = await import(`../electron/orchestrator.js?dsh-quiescent=${Date.now()}`)
  const events = []
  const stopped = { _accepting: true, dispose: async () => { events.push('stopped') } }
  const failed = { _accepting: true, dispose: async () => { events.push('failed'); throw new Error('private path') } }
  const entries = new Map([
    ['stopped', { adapter: stopped, session: { adapterId: 'deepseek-harness', capabilities: { surface: 'web' } }, status: 'online' }],
    ['failed', { adapter: failed, session: { adapterId: 'deepseek-harness', capabilities: { surface: 'web' } }, status: 'online' }],
    ['other', { adapter: { dispose: async () => assert.fail('non-DSH must remain live') }, session: { adapterId: 'claude' }, status: 'online' }]
  ])

  await assert.rejects(module.assertDshQuiescent(entries), { code: 'DSH_RUNTIME_BUSY' })
  assert.equal(stopped._accepting, false)
  assert.equal(failed._accepting, false)
  assert.equal(entries.get('stopped').adapter, null)
  assert.equal(entries.get('stopped').status, 'offline')
  assert.equal(entries.get('failed').adapter, failed)
  assert.equal(entries.get('failed').status, 'online')
  assert.deepEqual(events, ['stopped', 'failed'])
})
