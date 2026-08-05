import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
const processScript = fileURLToPath(new URL('../build/installer-process.ps1', import.meta.url))

async function startFixture(directory) {
  await mkdir(directory, { recursive: true })
  const executable = join(directory, 'UcliProcessFixture.exe')
  await copyFile(process.execPath, executable)
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

async function stopWithInstallerScript(targetPath, legacy = false) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', processScript,
    '-Action', 'Stop',
    '-TargetPath', targetPath
  ]
  if (legacy) args.push('-Legacy')
  await execFileAsync(powershell, args, { windowsHide: true })
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

test('legacy upgrade stops every same-name process before invoking the old uninstaller', { skip: !isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-legacy-process-'))
  const target = await startFixture(join(root, 'installed'))
  const portable = await startFixture(join(root, 'portable'))
  t.after(() => cleanupFixtures([target, portable], root))

  await stopWithInstallerScript(target.executable, true)
  await Promise.all([waitForExit(target.child), waitForExit(portable.child)])
})
