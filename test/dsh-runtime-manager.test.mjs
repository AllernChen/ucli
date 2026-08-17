import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDshRuntimeManager } from '../electron/adapters/dshRuntimeManager.js'

const DSH_INTEGRITY = 'sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg=='

function temporaryRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function materializeVerifiedInstall(staging) {
  writeJson(path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh', version: '0.1.0-rc.6', bin: { dsh: 'lib/bin.js' }
  })
  mkdirSync(path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  writeJson(path.join(staging, 'node_modules', 'pnpm', 'package.json'), {
    name: 'pnpm', version: '10.30.3'
  })
  writeJson(path.join(staging, 'package-lock.json'), {
    packages: {
      'node_modules/@deepseek-ai/dsh': {
        version: '0.1.0-rc.6', integrity: DSH_INTEGRITY
      }
    }
  })
}

function materializeManagedRuntime(runtimeDirectory, {
  version = '0.1.0-rc.6',
  integrity = DSH_INTEGRITY,
  pnpmVersion = '10.30.3',
  owner = { name: 'ucli-dsh-runtime', version: '0.11.1' }
} = {}) {
  const current = path.join(runtimeDirectory, 'current')
  materializeVerifiedInstall(current)
  const manifestFile = path.join(current, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.version = version
  writeJson(manifestFile, manifest)
  const lockFile = path.join(current, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  lock.packages['node_modules/@deepseek-ai/dsh'] = { version, integrity }
  writeJson(lockFile, lock)
  const pnpmFile = path.join(current, 'node_modules', 'pnpm', 'package.json')
  writeJson(pnpmFile, { name: 'pnpm', version: pnpmVersion })
  writeJson(path.join(current, '.ucli-dsh-runtime.json'), owner)
  return current
}

test('install uses the pinned registry transaction and selects the verified managed runtime', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-')
  const npmCli = path.join(root, 'trusted', 'npm-cli.js')
  const node = path.join(root, 'trusted', 'node')
  mkdirSync(path.dirname(npmCli), { recursive: true })
  writeFileSync(npmCli, 'trusted npm cli')
  writeFileSync(node, 'trusted node')
  const calls = []
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory: path.join(root, 'runtimes', 'deepseek-harness'),
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: node, prefixArgs: [npmCli] }),
      inspectSystem: async () => ({ installed: false, compatible: false, version: '', reason: 'not-installed' }),
      execute: async (file, args, options) => {
        calls.push({ file, args, options })
        const staging = args[args.indexOf('--prefix') + 1]
        materializeVerifiedInstall(staging)
        return { code: 0, stdout: 'private path', stderr: '' }
      },
      assertQuiescent: async () => true
    })

    const state = await manager.install()

    assert.equal(calls.length, 1)
    const staging = calls[0].args[calls[0].args.indexOf('--prefix') + 1]
    assert.deepEqual(calls[0].args, [
      npmCli, 'install', '--prefix', staging,
      '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund',
      '--package-lock=true', '@deepseek-ai/dsh@0.1.0-rc.6', 'pnpm@10.30.3'
    ])
    assert.equal(path.dirname(staging), path.join(root, 'runtimes', 'deepseek-harness'))
    assert.notEqual(staging, path.join(root, 'runtimes', 'deepseek-harness', 'current'))
    assert.equal(state.selected, 'managed')
    assert.equal(JSON.stringify(state).includes('private path'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent runtime operations coalesce and expose only a sanitized busy state', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-concurrent-')
  let release
  const gate = new Promise(resolve => { release = resolve })
  let executions = 0
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory: path.join(root, 'managed'),
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        executions += 1
        await gate
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: 'registry credential', stderr: '' }
      }
    })
    const first = manager.install()
    const second = manager.install()
    assert.equal(first, second)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await manager.getState()).busy, true)
    release()
    const state = await first
    assert.equal(executions, 1)
    assert.equal(state.busy, false)
    assert.deepEqual(Object.keys(state), [
      'revision', 'supportedVersion', 'managed', 'system', 'selected', 'action', 'busy', 'errorCode'
    ])
    assert.equal(JSON.stringify(state).includes('credential'), false)
  } finally {
    release?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('upgrade is available only for an installed older managed runtime', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-upgrade-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory, { version: '0.1.0-rc.5' })
  let executions = 0
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        executions += 1
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    assert.equal((await manager.getState()).action, 'upgrade')
    const state = await manager.upgrade()
    assert.equal(executions, 1)
    assert.equal(state.managed.version, '0.1.0-rc.6')
    assert.equal(state.errorCode, null)
    const rejected = await manager.upgrade()
    assert.equal(rejected.errorCode, 'DSH_RUNTIME_ACTION_INVALID')
    assert.equal(executions, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repair accepts only an unhealthy supported managed runtime', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-repair-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory, { integrity: 'sha512-tampered' })
  let executions = 0
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        executions += 1
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    assert.equal((await manager.getState()).action, 'repair')
    assert.equal((await manager.repair()).managed.health, 'healthy')
    assert.equal((await manager.install()).errorCode, 'DSH_RUNTIME_ACTION_INVALID')
    assert.equal(executions, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime mutation is rejected while an owned DSH Web process is active', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-active-')
  let executed = false
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory: path.join(root, 'managed'),
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => assert.fail('npm must not be resolved while DSH is active'),
      inspectSystem: async () => ({ installed: false }),
      execute: async () => { executed = true },
      assertQuiescent: async () => false
    })
    const state = await manager.install()
    assert.equal(state.errorCode, 'DSH_RUNTIME_BUSY')
    assert.equal(state.busy, false)
    assert.equal(executed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('npm discovery failures are converted to a stable sanitized state', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-npm-error-')
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory: path.join(root, 'managed'),
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => { throw new Error('C:\\Users\\private\\token') },
      inspectSystem: async () => ({ installed: false })
    })
    const state = await manager.install()
    assert.equal(state.errorCode, 'DSH_NPM_UNAVAILABLE')
    assert.equal(JSON.stringify(state).includes('private'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed installation rejects an unverified DSH package, integrity or pnpm version', async (t) => {
  const cases = {
    'package name': staging => {
      const file = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      const value = JSON.parse(readFileSync(file, 'utf8'))
      value.name = '@deepseek-ai/not-dsh'
      writeJson(file, value)
    },
    'package version': staging => {
      const file = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      const value = JSON.parse(readFileSync(file, 'utf8'))
      value.version = '0.1.0-rc.5'
      writeJson(file, value)
    },
    'binary entry': staging => {
      const file = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      const value = JSON.parse(readFileSync(file, 'utf8'))
      value.bin.dsh = 'malicious.js'
      writeJson(file, value)
    },
    integrity: staging => {
      const file = path.join(staging, 'package-lock.json')
      const value = JSON.parse(readFileSync(file, 'utf8'))
      value.packages['node_modules/@deepseek-ai/dsh'].integrity = 'sha512-tampered'
      writeJson(file, value)
    },
    'pnpm version': staging => {
      writeJson(path.join(staging, 'node_modules', 'pnpm', 'package.json'), {
        name: 'pnpm', version: '10.30.2'
      })
    }
  }
  for (const [name, tamper] of Object.entries(cases)) {
    await t.test(name, async () => {
      const root = temporaryRoot('ucli-dsh-runtime-invalid-')
      const runtimeDirectory = path.join(root, 'managed')
      try {
        const manager = createDshRuntimeManager({
          runtimeDirectory,
          dshHome: path.join(root, '.dsh'),
          resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
          inspectSystem: async () => ({ installed: false }),
          execute: async (_file, args) => {
            const staging = args[args.indexOf('--prefix') + 1]
            materializeVerifiedInstall(staging)
            tamper(staging)
            return { code: 0, stdout: 'private registry output', stderr: '' }
          }
        })
        const state = await manager.install()
        assert.equal(state.errorCode, 'DSH_RUNTIME_INSTALL_FAILED')
        assert.equal(state.managed.installed, false)
        assert.equal(existsSync(path.join(runtimeDirectory, 'current')), false)
        assert.equal(JSON.stringify(state).includes('registry'), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

test('failed atomic promotion restores the previous managed runtime', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-rollback-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory, { version: '0.1.0-rc.5' })
  let rejectedPromotion = false
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      },
      fs: {
        rename(from, to) {
          if (!rejectedPromotion && path.basename(from).startsWith('.staging-') && to.endsWith(`${path.sep}current`)) {
            rejectedPromotion = true
            throw Object.assign(new Error('promotion failed'), { code: 'EACCES' })
          }
          renameSync(from, to)
        }
      }
    })
    const state = await manager.upgrade()
    assert.equal(state.errorCode, 'DSH_RUNTIME_INSTALL_FAILED')
    assert.equal(state.managed.version, '0.1.0-rc.5')
    assert.equal(readdirSync(runtimeDirectory).some(name => name.startsWith('.backup-')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed rollback preserves backup and staging with a stable recovery code', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-rollback-failed-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory, { version: '0.1.0-rc.5' })
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      },
      fs: {
        rename(from, to) {
          if (to.endsWith(`${path.sep}current`) && (
            path.basename(from).startsWith('.staging-') || path.basename(from).startsWith('.backup-')
          )) throw Object.assign(new Error('rename failed'), { code: 'EACCES' })
          renameSync(from, to)
        }
      }
    })
    const state = await manager.upgrade()
    const entries = readdirSync(runtimeDirectory)
    assert.equal(state.errorCode, 'DSH_RUNTIME_ROLLBACK_FAILED')
    assert.equal(entries.some(name => name.startsWith('.backup-')), true)
    assert.equal(entries.some(name => name.startsWith('.staging-')), true)
    assert.equal(JSON.stringify(state).includes(runtimeDirectory), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remove accepts no path, requires ownership and preserves DSH_HOME', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-remove-')
  const runtimeDirectory = path.join(root, 'managed')
  const dshHome = path.join(root, '.dsh')
  materializeManagedRuntime(runtimeDirectory)
  mkdirSync(path.join(dshHome, 'profiles'), { recursive: true })
  writeFileSync(path.join(dshHome, 'profiles', 'keep.txt'), 'keep profile')
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome,
      inspectSystem: async () => ({ installed: false }),
      assertQuiescent: async () => true
    })
    const outside = path.join(root, 'outside')
    mkdirSync(outside)
    const rejected = await manager.remove(outside)
    assert.equal(rejected.errorCode, 'DSH_RUNTIME_ACTION_INVALID')
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), true)
    assert.equal(existsSync(outside), true)

    const state = await manager.remove()
    assert.equal(state.errorCode, null)
    assert.equal(state.managed.installed, false)
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), false)
    assert.equal(readFileSync(path.join(dshHome, 'profiles', 'keep.txt'), 'utf8'), 'keep profile')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remove rejects an unowned or non-direct managed directory', async (t) => {
  await t.test('owner marker mismatch', async () => {
    const root = temporaryRoot('ucli-dsh-runtime-owner-')
    const runtimeDirectory = path.join(root, 'managed')
    materializeManagedRuntime(runtimeDirectory, {
      owner: { name: 'foreign-runtime', version: '0.11.1' }
    })
    try {
      const manager = createDshRuntimeManager({
        runtimeDirectory,
        dshHome: path.join(root, '.dsh'),
        inspectSystem: async () => ({ installed: false })
      })
      const state = await manager.remove()
      assert.equal(state.errorCode, 'DSH_RUNTIME_REMOVE_REJECTED')
      assert.equal(existsSync(path.join(runtimeDirectory, 'current')), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await t.test('realpath escapes direct child', async () => {
    const root = temporaryRoot('ucli-dsh-runtime-contained-')
    const runtimeDirectory = path.join(root, 'managed')
    const current = materializeManagedRuntime(runtimeDirectory)
    try {
      const manager = createDshRuntimeManager({
        runtimeDirectory,
        dshHome: path.join(root, '.dsh'),
        inspectSystem: async () => ({ installed: false }),
        fs: {
          realpath(target) {
            if (target === current) return path.join(root, 'outside', 'current')
            return realpathSync(target)
          }
        }
      })
      const state = await manager.remove()
      assert.equal(state.errorCode, 'DSH_RUNTIME_REMOVE_REJECTED')
      assert.equal(existsSync(current), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('launch selection prefers healthy managed DSH and falls back to compatible system DSH', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-select-')
  const runtimeDirectory = path.join(root, 'managed')
  const dshHome = path.join(root, '.dsh')
  const managedNode = path.join(root, 'trusted-node')
  const systemLaunch = { file: path.join(root, 'system-dsh'), prefixArgs: [] }
  materializeManagedRuntime(runtimeDirectory)
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome,
      nodeExecutable: managedNode,
      inspectSystem: async () => ({
        installed: true,
        compatible: true,
        version: '0.1.0-rc.6',
        reason: '',
        launch: systemLaunch,
        home: path.join(root, 'system-home')
      })
    })
    const managed = await manager.selectLaunch()
    assert.equal(managed.source, 'managed')
    assert.equal(managed.launch.file, managedNode)
    assert.equal(path.isAbsolute(managed.launch.prefixArgs[0]), true)

    rmSync(path.join(runtimeDirectory, 'current'), { recursive: true, force: true })
    const system = await manager.selectLaunch()
    assert.deepEqual(system, {
      source: 'system', launch: systemLaunch, home: path.join(root, 'system-home')
    })
    assert.equal((await manager.getState()).selected, 'system')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('system inspection cannot leak raw version or error details into runtime state', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-system-sanitize-')
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory: path.join(root, 'managed'),
      dshHome: path.join(root, '.dsh'),
      inspectSystem: async () => ({
        installed: true,
        compatible: true,
        version: 'C:\\Users\\private\\token',
        reason: 'registry password',
        launch: { file: 'private executable', prefixArgs: [] }
      })
    })
    const state = await manager.getState()
    assert.deepEqual(state.system, {
      installed: true, compatible: false, version: '', health: 'unhealthy'
    })
    assert.equal(state.selected, null)
    assert.equal(JSON.stringify(state).includes('private'), false)
    assert.equal(JSON.stringify(state).includes('password'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upgrade and repair never replace a current directory without the exact owner marker', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-unowned-mutation-')
  const runtimeDirectory = path.join(root, 'managed')
  const current = materializeManagedRuntime(runtimeDirectory, {
    owner: { name: 'foreign-runtime', version: '0.11.1' }
  })
  const sentinel = path.join(current, 'foreign-data.txt')
  writeFileSync(sentinel, 'do not replace')
  let executed = false
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async () => { executed = true }
    })
    assert.equal((await manager.getState()).action, null)
    const state = await manager.repair()
    assert.equal(state.errorCode, 'DSH_RUNTIME_ACTION_INVALID')
    assert.equal(executed, false)
    assert.equal(readFileSync(sentinel, 'utf8'), 'do not replace')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mutation dependency failures return stable sanitized states', async (t) => {
  const cases = [
    {
      name: 'quiescent check throws',
      errorCode: 'DSH_RUNTIME_BUSY',
      options: { assertQuiescent: async () => { throw new Error('C:\\private\\process') } }
    },
    {
      name: 'runtime root creation throws',
      errorCode: 'DSH_RUNTIME_INSTALL_FAILED',
      options: { fs: { mkdir: () => { throw new Error('C:\\private\\runtime') } } }
    },
    {
      name: 'transaction id throws',
      errorCode: 'DSH_RUNTIME_INSTALL_FAILED',
      options: { id: () => { throw new Error('C:\\private\\uuid') } }
    }
  ]
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = temporaryRoot('ucli-dsh-runtime-dependency-')
      try {
        const manager = createDshRuntimeManager({
          runtimeDirectory: path.join(root, 'managed'),
          dshHome: path.join(root, '.dsh'),
          resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
          inspectSystem: async () => ({ installed: false }),
          execute: async () => assert.fail('execution must not start'),
          ...fixture.options
        })
        const state = await manager.install()
        assert.equal(state.errorCode, fixture.errorCode)
        assert.equal(state.busy, false)
        assert.equal(JSON.stringify(state).includes('private'), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

test('remove sanitizes a failing quiescent check without touching current', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-remove-active-error-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory)
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      inspectSystem: async () => ({ installed: false }),
      assertQuiescent: async () => { throw new Error('C:\\private\\pid') }
    })
    const state = await manager.remove()
    assert.equal(state.errorCode, 'DSH_RUNTIME_BUSY')
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), true)
    assert.equal(JSON.stringify(state).includes('private'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remove sanitizes transaction setup failure without touching current', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-remove-id-error-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory)
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      inspectSystem: async () => ({ installed: false }),
      id: () => { throw new Error('C:\\private\\remove-id') }
    })
    const state = await manager.remove()
    assert.equal(state.errorCode, 'DSH_RUNTIME_REMOVE_FAILED')
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), true)
    assert.equal(JSON.stringify(state).includes('private'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('backup cleanup failure keeps the promoted owned runtime selected and retryable', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-backup-cleanup-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory, { version: '0.1.0-rc.5' })
  let failCleanup = true
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      },
      fs: {
        remove(target, options) {
          if (failCleanup && path.basename(target).startsWith('.backup-')) {
            throw Object.assign(new Error('C:\\private\\backup'), { code: 'EACCES' })
          }
          rmSync(target, options)
        }
      }
    })
    const state = await manager.upgrade()
    assert.equal(state.errorCode, 'DSH_RUNTIME_BACKUP_CLEANUP_FAILED')
    assert.equal(state.selected, 'managed')
    assert.equal(state.action, null)
    assert.deepEqual(state.managed, {
      installed: true, compatible: true, version: '0.1.0-rc.6', health: 'healthy'
    })
    assert.equal(readdirSync(runtimeDirectory).some(name => name.startsWith('.backup-')), true)
    assert.equal(JSON.stringify(state).includes('private'), false)
    const blocked = await manager.remove()
    assert.equal(blocked.errorCode, 'DSH_RUNTIME_BACKUP_CLEANUP_FAILED')
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), true)
    assert.equal(readdirSync(runtimeDirectory).some(name => name.startsWith('.backup-')), true)
    failCleanup = false
    const retried = await manager.getState()
    assert.equal(retried.errorCode, null)
    assert.equal(retried.action, 'remove')
    assert.equal(retried.revision, blocked.revision + 1)
    assert.equal(readdirSync(runtimeDirectory).some(name => name.startsWith('.backup-')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime state revision increases after each completed mutation', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-revision-')
  const runtimeDirectory = path.join(root, 'managed')
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    assert.equal((await manager.getState()).revision, 1)
    assert.equal((await manager.install()).revision, 2)
    assert.equal((await manager.getState()).revision, 2)
    assert.equal((await manager.remove()).revision, 3)
    assert.equal((await manager.getState()).revision, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installation rejects a package entry whose canonical path escapes staging', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-contained-entry-')
  const runtimeDirectory = path.join(root, 'managed')
  let escapedEntry = null
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        const staging = args[args.indexOf('--prefix') + 1]
        materializeVerifiedInstall(staging)
        escapedEntry = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        return { code: 0, stdout: '', stderr: '' }
      },
      fs: {
        realpath(target) {
          if (target === escapedEntry) return path.join(root, 'outside', 'bin.js')
          return realpathSync(target)
        }
      }
    })
    const state = await manager.install()
    assert.equal(state.errorCode, 'DSH_RUNTIME_INSTALL_FAILED')
    assert.equal(state.managed.installed, false)
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installation rejects a Windows junction that escapes the staged DSH package', {
  skip: process.platform !== 'win32' && 'Windows junction semantics are platform-specific'
}, async (t) => {
  const root = temporaryRoot('ucli-dsh-runtime-junction-')
  const runtimeDirectory = path.join(root, 'managed')
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        const staging = args[args.indexOf('--prefix') + 1]
        materializeVerifiedInstall(staging)
        const outside = path.join(root, 'outside-install')
        materializeVerifiedInstall(outside)
        const stagedDsh = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh')
        const outsideDsh = path.join(outside, 'node_modules', '@deepseek-ai', 'dsh')
        rmSync(stagedDsh, { recursive: true, force: true })
        try {
          symlinkSync(outsideDsh, stagedDsh, 'junction')
        } catch {
          t.skip('junction creation is unavailable on this host')
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const state = await manager.install()
    assert.equal(state.errorCode, 'DSH_RUNTIME_INSTALL_FAILED')
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('promotion re-verifies the canonical runtime tree before reporting success', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-post-verify-')
  const runtimeDirectory = path.join(root, 'managed')
  let promoted = false
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      },
      fs: {
        rename(from, to) {
          renameSync(from, to)
          if (to === path.join(runtimeDirectory, 'current')) promoted = true
        },
        realpath(target) {
          if (promoted && target === path.join(
            runtimeDirectory, 'current', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'
          )) return path.join(root, 'outside', 'bin.js')
          return realpathSync(target)
        }
      }
    })
    const state = await manager.install()
    assert.equal(state.errorCode, 'DSH_RUNTIME_INSTALL_FAILED')
    assert.equal(state.managed.installed, false)
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('constructor rejects equal or nested runtime and DSH home paths', () => {
  const root = temporaryRoot('ucli-dsh-runtime-path-conflict-')
  try {
    const cases = [
      [path.join(root, 'same'), path.join(root, 'same')],
      [path.join(root, 'runtime'), path.join(root, 'runtime', 'home')],
      [path.join(root, 'home', 'runtime'), path.join(root, 'home')]
    ]
    for (const [runtimeDirectory, dshHome] of cases) {
      assert.throws(() => createDshRuntimeManager({ runtimeDirectory, dshHome }), {
        code: 'DSH_RUNTIME_PATH_CONFLICT'
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('constructor rejects canonical overlap and linked runtime ancestors', () => {
  const root = temporaryRoot('ucli-dsh-runtime-canonical-conflict-')
  const runtimeDirectory = path.join(root, 'runtime')
  const dshHome = path.join(root, 'home')
  mkdirSync(runtimeDirectory)
  mkdirSync(dshHome)
  try {
    assert.throws(() => createDshRuntimeManager({
      runtimeDirectory,
      dshHome,
      fs: {
        realpath(target) {
          if (target === dshHome) return path.join(runtimeDirectory, 'canonical-home')
          return realpathSync(target)
        }
      }
    }), { code: 'DSH_RUNTIME_PATH_CONFLICT' })

    assert.throws(() => createDshRuntimeManager({
      runtimeDirectory: path.join(runtimeDirectory, 'child'),
      dshHome,
      fs: {
        lstat(target) {
          const stat = lstatSync(target)
          if (target === runtimeDirectory) {
            return { ...stat, isDirectory: () => true, isSymbolicLink: () => true }
          }
          return stat
        }
      }
    }), { code: 'DSH_RUNTIME_PATH_UNSAFE' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('constructor rejects Windows junction runtime roots and canonical DSH overlap', {
  skip: process.platform !== 'win32' && 'Windows junction semantics are platform-specific'
}, (t) => {
  const root = temporaryRoot('ucli-dsh-runtime-root-junction-')
  const target = path.join(root, 'runtime-target')
  const runtimeLink = path.join(root, 'runtime-link')
  const dshHome = path.join(root, 'home')
  mkdirSync(target)
  mkdirSync(dshHome)
  try {
    try {
      symlinkSync(target, runtimeLink, 'junction')
    } catch {
      t.skip('junction creation is unavailable on this host')
      return
    }
    assert.throws(() => createDshRuntimeManager({
      runtimeDirectory: runtimeLink, dshHome
    }), { code: 'DSH_RUNTIME_PATH_UNSAFE' })

    const nestedHome = path.join(target, 'nested-home')
    const homeLink = path.join(root, 'home-link')
    mkdirSync(nestedHome)
    symlinkSync(nestedHome, homeLink, 'junction')
    assert.throws(() => createDshRuntimeManager({
      runtimeDirectory: target, dshHome: homeLink
    }), { code: 'DSH_RUNTIME_PATH_CONFLICT' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('each destructive operation revalidates runtime placement before touching disk', async (t) => {
  for (const operation of ['install', 'remove']) {
    await t.test(operation, async () => {
      const root = temporaryRoot(`ucli-dsh-runtime-placement-${operation}-`)
      const runtimeDirectory = path.join(root, 'managed')
      const dshHome = path.join(root, '.dsh')
      if (operation === 'remove') materializeManagedRuntime(runtimeDirectory)
      mkdirSync(dshHome, { recursive: true })
      const homeSentinel = path.join(dshHome, 'keep.txt')
      writeFileSync(homeSentinel, 'keep home')
      let unsafe = false
      let executed = false
      try {
        const manager = createDshRuntimeManager({
          runtimeDirectory,
          dshHome,
          resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
          inspectSystem: async () => ({ installed: false }),
          execute: async () => { executed = true },
          fs: {
            lstat(target) {
              if (unsafe && target === runtimeDirectory) {
                return { isDirectory: () => true, isSymbolicLink: () => true }
              }
              return lstatSync(target)
            }
          }
        })
        await manager.getState()
        unsafe = true
        const state = await manager[operation]()
        assert.equal(state.errorCode, 'DSH_RUNTIME_PATH_UNSAFE')
        assert.equal(state.action, null)
        assert.equal(executed, false)
        assert.equal(readFileSync(homeSentinel, 'utf8'), 'keep home')
        if (operation === 'remove') {
          assert.equal(existsSync(path.join(runtimeDirectory, 'current')), true)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

test('an exact-owned unhealthy runtime with unreadable version remains repairable', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-repair-unreadable-')
  const runtimeDirectory = path.join(root, 'managed')
  const current = materializeManagedRuntime(runtimeDirectory)
  writeFileSync(path.join(current, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{broken')
  let executions = 0
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        executions += 1
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const before = await manager.getState()
    assert.equal(before.managed.version, '')
    assert.equal(before.action, 'repair')
    const after = await manager.repair()
    assert.equal(after.errorCode, null)
    assert.equal(after.selected, 'managed')
    assert.equal(executions, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup cleanup removes only fixed-name exact-owned backups behind a healthy current', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-startup-cleanup-')
  const runtimeDirectory = path.join(root, 'managed')
  materializeManagedRuntime(runtimeDirectory)
  const ownedSource = path.join(root, 'owned-source')
  const foreignSource = path.join(root, 'foreign-source')
  const ownedCurrent = materializeManagedRuntime(ownedSource, { version: '0.1.0-rc.5' })
  const foreignCurrent = materializeManagedRuntime(foreignSource, {
    owner: { name: 'foreign-runtime', version: '0.11.1' }
  })
  const ownedBackup = path.join(runtimeDirectory, '.backup-11111111-1111-4111-8111-111111111111')
  const foreignBackup = path.join(runtimeDirectory, '.backup-22222222-2222-4222-8222-222222222222')
  renameSync(ownedCurrent, ownedBackup)
  renameSync(foreignCurrent, foreignBackup)
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      inspectSystem: async () => ({ installed: false })
    })
    const state = await manager.getState()
    assert.equal(existsSync(ownedBackup), false)
    assert.equal(existsSync(foreignBackup), true)
    assert.equal(state.errorCode, null)
    assert.equal(state.action, 'remove')
    assert.equal(state.revision, 2)
    assert.equal(JSON.stringify(state).includes('.backup-'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installation revalidates runtime ancestors after npm returns', async () => {
  const root = temporaryRoot('ucli-dsh-runtime-post-npm-placement-')
  const ancestor = path.join(root, 'runtime-parent')
  const runtimeDirectory = path.join(ancestor, 'managed')
  mkdirSync(ancestor)
  let linkedAncestor = false
  let removedWhileUnsafe = false
  try {
    const manager = createDshRuntimeManager({
      runtimeDirectory,
      dshHome: path.join(root, '.dsh'),
      resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
      inspectSystem: async () => ({ installed: false }),
      execute: async (_file, args) => {
        materializeVerifiedInstall(args[args.indexOf('--prefix') + 1])
        linkedAncestor = true
        return { code: 0, stdout: '', stderr: '' }
      },
      fs: {
        lstat(target) {
          if (linkedAncestor && target === ancestor) {
            return { isDirectory: () => true, isSymbolicLink: () => true }
          }
          return lstatSync(target)
        },
        remove(target, options) {
          if (linkedAncestor) removedWhileUnsafe = true
          rmSync(target, options)
        }
      }
    })
    const state = await manager.install()
    assert.equal(state.errorCode, 'DSH_RUNTIME_INSTALL_FAILED')
    assert.equal(existsSync(path.join(runtimeDirectory, 'current')), false)
    assert.equal(removedWhileUnsafe, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('destructive operations revalidate placement after the quiescent await boundary', async (t) => {
  for (const operation of ['install', 'remove']) {
    await t.test(operation, async () => {
      const root = temporaryRoot(`ucli-dsh-runtime-post-quiescent-${operation}-`)
      const ancestor = path.join(root, 'runtime-parent')
      const runtimeDirectory = path.join(ancestor, 'managed')
      const dshHome = path.join(root, '.dsh')
      mkdirSync(ancestor)
      if (operation === 'remove') materializeManagedRuntime(runtimeDirectory)
      mkdirSync(dshHome)
      const sentinel = path.join(dshHome, 'keep.txt')
      writeFileSync(sentinel, 'keep home')
      let unsafe = false
      let executed = false
      try {
        const manager = createDshRuntimeManager({
          runtimeDirectory,
          dshHome,
          resolveNpm: () => ({ file: process.execPath, prefixArgs: [] }),
          inspectSystem: async () => ({ installed: false }),
          assertQuiescent: async () => {
            unsafe = true
            return true
          },
          execute: async () => { executed = true },
          fs: {
            lstat(target) {
              if (unsafe && target === ancestor) {
                return { isDirectory: () => true, isSymbolicLink: () => true }
              }
              return lstatSync(target)
            }
          }
        })
        const state = await manager[operation]()
        assert.equal(state.errorCode, 'DSH_RUNTIME_PATH_UNSAFE')
        assert.equal(executed, false)
        assert.equal(readFileSync(sentinel, 'utf8'), 'keep home')
        if (operation === 'remove') {
          assert.equal(existsSync(path.join(runtimeDirectory, 'current')), true)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
