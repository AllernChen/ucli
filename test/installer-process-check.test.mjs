import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const isWindows = process.platform === 'win32'
const powershell = isWindows
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : ''
const powershell32 = isWindows
  ? join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : ''
const processScript = fileURLToPath(new URL('../build/installer-process.ps1', import.meta.url))

async function createFixtureExecutable(directory) {
  await mkdir(directory, { recursive: true })
  const executable = join(directory, 'UcliProcessFixture.exe')
  await copyFile(process.execPath, executable)
  return executable
}

async function startFixture(directory) {
  const executable = await createFixtureExecutable(directory)
  const child = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return { child, executable }
}

function installerScriptArgs(action, targetPath, legacy = false) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', processScript,
    '-Action', action,
    '-TargetPath', targetPath
  ]
  if (legacy) args.push('-Legacy')
  return args
}

async function stopWithInstallerScript(targetPath, legacy = false) {
  await execFileAsync(powershell, installerScriptArgs('Stop', targetPath, legacy), { windowsHide: true })
}

async function findWithInstallerScript(targetPath, shellPath = powershell) {
  try {
    await execFileAsync(shellPath, installerScriptArgs('Find', targetPath), { windowsHide: true })
    return true
  } catch (error) {
    if (error?.code === 1) return false
    throw error
  }
}

async function waitForExit(child) {
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), 5000))
  ])
}

async function cleanupFixtures(fixtures, root) {
  for (const fixture of fixtures) {
    if (fixture.child.exitCode === null) fixture.child.kill('SIGKILL')
  }
  await Promise.all(fixtures.map((fixture) => waitForExit(fixture.child).catch(() => {})))
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('installer process stop is scoped to the target executable path', { skip: !isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-installer-process-'))
  const target = await startFixture(join(root, 'installed'))
  const portable = await startFixture(join(root, 'portable'))
  t.after(() => cleanupFixtures([target, portable], root))

  assert.equal(basename(target.executable), basename(portable.executable))
  await stopWithInstallerScript(target.executable)
  await waitForExit(target.child)
  assert.equal(portable.child.exitCode, null)
})

test('installer process find detects the executable at the selected install path', { skip: !isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-installer-find-target-'))
  const target = await startFixture(join(root, 'installed'))
  t.after(() => cleanupFixtures([target], root))

  assert.equal(await findWithInstallerScript(target.executable), true)
})

test('32-bit installer PowerShell detects the 64-bit executable path', {
  skip: !isWindows || process.arch !== 'x64' || !existsSync(powershell32)
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-installer-wow64-find-'))
  const target = await startFixture(join(root, 'installed'))
  t.after(() => cleanupFixtures([target], root))

  assert.equal(await findWithInstallerScript(target.executable, powershell32), true)
})

test('installer process find ignores a same-name portable executable at another path', { skip: !isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-installer-find-portable-'))
  const targetExecutable = await createFixtureExecutable(join(root, 'installed'))
  const portable = await startFixture(join(root, 'portable'))
  t.after(() => cleanupFixtures([portable], root))

  assert.equal(basename(targetExecutable), basename(portable.executable))
  assert.equal(await findWithInstallerScript(targetExecutable), false)
})

test('legacy upgrade stops every same-name process before invoking the old uninstaller', { skip: !isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-legacy-process-'))
  const target = await startFixture(join(root, 'installed'))
  const portable = await startFixture(join(root, 'portable'))
  t.after(() => cleanupFixtures([target, portable], root))

  await stopWithInstallerScript(target.executable, true)
  await Promise.all([waitForExit(target.child), waitForExit(portable.child)])
})

test('legacy upgrade drains a replacement process spawned during shutdown', { skip: !isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-legacy-replacement-'))
  const target = await startFixture(join(root, 'installed'))
  const fixtures = [target]
  t.after(() => cleanupFixtures(fixtures, root))

  const replacementStarted = new Promise((resolve, reject) => {
    target.child.once('exit', () => {
      const child = spawn(target.executable, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true
      })
      const replacement = { child, executable: target.executable }
      fixtures.push(replacement)
      child.once('spawn', () => resolve(replacement))
      child.once('error', reject)
    })
  })

  await stopWithInstallerScript(target.executable, true)
  const replacement = await replacementStarted
  await waitForExit(replacement.child)
})
