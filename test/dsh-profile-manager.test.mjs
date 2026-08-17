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
  const artifact = path.join(home, 'bundled', `ucli-dsh-bridge-${DSH_BRIDGE_VERSION}.tgz`)
  mkdirSync(path.dirname(artifact), { recursive: true })
  writeFileSync(artifact, 'bridge bytes')
  return createDshProfileManager({
    homeDirectory: home,
    tempDirectory: path.join(home, 'app-temp'),
    bridgeArtifactPath: artifact,
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
        profileName: 'outdated', profileReady: true, bridgeInstalled: true,
        bridgeCompatible: false, bridgeVersion: '0.10.9', errorCode: 'DSH_BRIDGE_VERSION_UNSUPPORTED'
      },
      {
        profileName: 'plain', profileReady: true, bridgeInstalled: false,
        bridgeCompatible: false, bridgeVersion: '', errorCode: 'DSH_BRIDGE_NOT_INSTALLED'
      },
      {
        profileName: 'ready', profileReady: true, bridgeInstalled: true,
        bridgeCompatible: true, bridgeVersion: DSH_BRIDGE_VERSION, errorCode: null
      },
      {
        profileName: 'web', profileReady: true, bridgeInstalled: false,
        bridgeCompatible: false, bridgeVersion: '', errorCode: 'DSH_BRIDGE_NOT_INSTALLED'
      }
    ])
    assert.equal(result.profiles.some(profile => 'tuiReady' in profile || 'surface' in profile), false)
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

test('bridge compatibility requires dependency, bundle, contained exact manifest and regular patch together', async () => {
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
      assert.equal(byName[name].bridgeInstalled, false, name)
      assert.equal(byName[name].bridgeCompatible, false, name)
      assert.equal(byName[name].errorCode, 'DSH_BRIDGE_NOT_INSTALLED', name)
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
    assert.equal(longVersionStatus?.bridgeInstalled, true)
    assert.equal(longVersionStatus?.bridgeVersion, '')
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
      profileName: 'broken', profileReady: false, bridgeInstalled: false,
      bridgeCompatible: false, bridgeVersion: '', errorCode: 'DSH_PROFILE_INVALID'
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
    assert.equal(status.errorCode, 'DSH_BRIDGE_NOT_INSTALLED')
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
    assert.equal(status.errorCode, 'DSH_BRIDGE_NOT_INSTALLED')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('bridge enablement uses exact argv, absolute paths, shell false and does not mutate before consent', async () => {
  const home = temporaryRoot('ucli-dsh-install-')
  try {
    const profile = writeProfile(home, 'tui')
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
        const manifestPath = path.join(profile, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        manifest.dependencies[BRIDGE_NAME] = 'file:bridge.tgz'
        manifest.dsh.profile.bundles.push(BRIDGE_NAME)
        writeJson(manifestPath, manifest)
        writeJson(path.join(profile, 'node_modules', '@ucli', 'dsh-bridge', 'package.json'), {
          name: BRIDGE_NAME,
          version: DSH_BRIDGE_VERSION,
          dsh: { bundle: { patch: './cordis.patch.yml' } }
        })
        writeFileSync(path.join(profile, 'node_modules', '@ucli', 'dsh-bridge', 'cordis.patch.yml'), '[]\n')
        return { code: 0, stdout: 'sensitive install output', stderr: '' }
      }
    })

    await manager.listProfiles()
    assert.equal(readFileSync(path.join(profile, 'package.json'), 'utf8'), before)

    const result = await manager.enableBridge('tui')
    assert.equal(result.ok, true)
    assert.equal(result.errorCode, null)
    assert.equal(result.profile.bridgeCompatible, true)
    assert.equal(JSON.stringify(result).includes('sensitive install output'), false)
    assert.equal(calls.length, 1)
    assert.equal(path.isAbsolute(calls[0].file), true)
    assert.deepEqual(calls[0].args.slice(0, 5), [
      '/absolute/dsh/lib/bin.js', 'plugin', '--profile', 'tui', 'add'
    ])
    assert.equal(path.isAbsolute(calls[0].args[5]), true)
    assert.equal(calls[0].args[5], path.join(home, 'bundled', `ucli-dsh-bridge-${DSH_BRIDGE_VERSION}.tgz`))
    assert.deepEqual(calls[0].args.slice(6), ['--ignore-scripts'])
    assert.equal(existsSync(calls[0].args[5]), true)
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
        bridgeInstalled: false,
        bridgeCompatible: false,
        bridgeVersion: '',
        errorCode: 'DSH_BRIDGE_NOT_INSTALLED'
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

test('transaction accepts a bounded multi-megabyte pnpm lock and restores it exactly', async () => {
  const home = temporaryRoot('ucli-dsh-large-lock-')
  try {
    const profile = writeProfile(home, 'tui')
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
    assert.equal((await manager.enableBridge('tui')).errorCode, 'DSH_BRIDGE_INSTALL_FAILED')
    assert.equal(executed, true)
    assert.deepEqual(readFileSync(lock), original)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('unconfirmed timeout never races rollback against a possibly live pnpm descendant', async () => {
  const home = temporaryRoot('ucli-dsh-timeout-')
  try {
    const profile = writeProfile(home, 'tui')
    const manifest = path.join(profile, 'package.json')
    const manager = createManager(home, {
      execute: async () => {
        writeFileSync(manifest, '{"mutatedWhileDescendantMayLive":true}\n')
        return { code: -1, stdout: '', stderr: '', terminationConfirmed: false }
      }
    })
    const result = await manager.enableBridge('tui')
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
    const profile = writeProfile(home, 'tui')
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
    assert.deepEqual(await manager.enableBridge('tui'), {
      ok: false, errorCode: 'DSH_BRIDGE_ROLLBACK_FAILED', profile: null
    })
    const backups = readdirSync(path.join(home, 'app-temp'))
    assert.equal(backups.length, 1)
    assert.equal(existsSync(path.join(home, 'app-temp', backups[0], 'package.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('failed bridge enablement restores only the four metadata files and keeps user content', async () => {
  const home = temporaryRoot('ucli-dsh-rollback-')
  try {
    const profile = writeProfile(home, 'tui')
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

    const result = await manager.enableBridge('tui')

    assert.deepEqual(result, { ok: false, errorCode: 'DSH_BRIDGE_INSTALL_FAILED', profile: null })
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
    const profile = writeProfile(home, 'tui')
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
    assert.equal((await manager.enableBridge('tui')).errorCode, 'DSH_BRIDGE_INSTALL_FAILED')
    assert.equal(existsSync(lock), false)
    assert.equal((await import('node:fs')).statSync(manifest).mode & 0o777, 0o640)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('post-check failure restores metadata and concurrent enables coalesce per profile', async () => {
  const home = temporaryRoot('ucli-dsh-concurrent-')
  try {
    const profile = writeProfile(home, 'tui')
    const before = readFileSync(path.join(profile, 'package.json'), 'utf8')
    let release
    const gate = new Promise(resolve => { release = resolve })
    let executions = 0
    const manager = createManager(home, {
      execute: async () => {
        executions += 1
        writeFileSync(path.join(profile, 'package.json'), '{"name":"still-missing-bridge"}\n')
        await gate
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    const first = manager.enableBridge('tui')
    const second = manager.enableBridge('tui')
    while (executions === 0) await new Promise(resolve => setImmediate(resolve))
    assert.equal(executions, 1)
    release()
    const [left, right] = await Promise.all([first, second])
    assert.deepEqual(left, { ok: false, errorCode: 'DSH_BRIDGE_INSTALL_FAILED', profile: null })
    assert.deepEqual(right, left)
    assert.equal(readFileSync(path.join(profile, 'package.json'), 'utf8'), before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('bridge enablement fails closed for invalid profile, incompatible runtime, missing pnpm and missing artifact', async () => {
  const home = temporaryRoot('ucli-dsh-guards-')
  try {
    writeProfile(home, 'tui')
    let executions = 0
    const execute = async () => { executions += 1; return { code: 0, stdout: '', stderr: '' } }
    const invalid = createManager(home, { execute })
    assert.deepEqual(await invalid.enableBridge('../tui'), {
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
    assert.equal((await incompatible.enableBridge('tui')).errorCode, 'DSH_VERSION_UNSUPPORTED')
    const noPnpm = createManager(home, {
      execute,
      inspectRuntime: async () => readyRuntime(home, { pnpmAvailable: false })
    })
    assert.equal((await noPnpm.enableBridge('tui')).errorCode, 'DSH_BRIDGE_INSTALL_FAILED')
    const missingArtifact = createManager(home, {
      execute,
      bridgeArtifactPath: path.join(home, 'missing.tgz')
    })
    assert.equal((await missingArtifact.enableBridge('tui')).errorCode, 'DSH_BRIDGE_INSTALL_FAILED')
    assert.equal(executions, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('transaction temp setup failures return a stable sanitized status before execution', async () => {
  const home = temporaryRoot('ucli-dsh-temp-failure-')
  try {
    writeProfile(home, 'tui')
    let executions = 0
    const manager = createManager(home, {
      execute: async () => { executions += 1; return { code: 0, stdout: '', stderr: '' } },
      fileOps: {
        mkdir: async () => {
          throw Object.assign(new Error(`access denied at ${home}\\private`), { code: 'EACCES' })
        }
      }
    })
    const result = await manager.enableBridge('tui')
    assert.deepEqual(result, { ok: false, errorCode: 'DSH_BRIDGE_INSTALL_FAILED', profile: null })
    assert.equal(JSON.stringify(result).includes(home), false)
    assert.equal(executions, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an out-of-root transaction candidate is removed before failing closed', async () => {
  const home = temporaryRoot('ucli-dsh-temp-containment-')
  try {
    writeProfile(home, 'tui')
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

    assert.deepEqual(await manager.enableBridge('tui'), {
      ok: false, errorCode: 'DSH_BRIDGE_INSTALL_FAILED', profile: null
    })
    assert.deepEqual(removed, [outside])
    assert.equal(existsSync(outside), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH IPC exposes only list, profile-name initialization and bridge enable operations', async () => {
  const handlers = new Map()
  const received = []
  const manager = {
    listProfiles: async () => ({ runtime: {}, profiles: [] }),
    initializeProfile: async name => { received.push(['initialize', name]); return { ok: true, errorCode: null, profile: null } },
    enableBridge: async name => { received.push(name); return { ok: true, errorCode: null, profile: null } }
  }
  registerDshProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    manager
  })
  assert.deepEqual([...handlers.keys()], ['dsh:listProfiles', 'dsh:initializeProfile', 'dsh:enableBridge'])
  assert.deepEqual(await handlers.get('dsh:listProfiles')({ sender: 'renderer' }), { runtime: {}, profiles: [] })
  await handlers.get('dsh:initializeProfile')({ sender: 'renderer' }, 'team-tui')
  await handlers.get('dsh:enableBridge')({ sender: 'renderer' }, 'team-tui')
  assert.deepEqual(received, [['initialize', 'team-tui'], 'team-tui'])
})

test('orchestrator composes the DSH profile manager into live IPC channels', async () => {
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
    assert.equal(typeof handlers.get('dsh:listProfiles'), 'function')
    assert.equal(typeof handlers.get('dsh:initializeProfile'), 'function')
    assert.equal(typeof handlers.get('dsh:enableBridge'), 'function')
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
