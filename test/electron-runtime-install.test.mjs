import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ensureElectronRuntime } from '../scripts/ensure-electron-runtime.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runtimeRelativePath() {
  if (process.platform === 'win32') return 'electron.exe'
  if (process.platform === 'darwin') return path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
  return 'electron'
}

async function createFakeElectronPackage(t) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ucli-electron-runtime-'))
  const electronDir = path.join(tempRoot, 'electron')
  const runtimePath = path.join(electronDir, 'dist', runtimeRelativePath())
  await mkdir(electronDir, { recursive: true })
  await writeFile(
    path.join(electronDir, 'install.js'),
    `
const fs = require('node:fs')
const path = require('node:path')
const relative = process.platform === 'win32'
  ? 'electron.exe'
  : process.platform === 'darwin'
    ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
    : 'electron'
const target = path.join(__dirname, 'dist', relative)
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, 'fixture-runtime')
`,
    'utf8',
  )
  t.after(() => rm(tempRoot, { recursive: true, force: true }))

  return { electronDir, runtimePath }
}

test('postinstall entrypoint prepares the Electron runtime in a clean dependency tree', async (t) => {
  const { electronDir, runtimePath } = await createFakeElectronPackage(t)

  ensureElectronRuntime({ electronDir })

  assert.equal(existsSync(runtimePath), true, 'postinstall must prepare the Electron runtime')
})

test('postinstall ignores environment attempts to execute an alternate Electron installer', async (t) => {
  const { electronDir, runtimePath } = await createFakeElectronPackage(t)

  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'ensure-electron-runtime.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      UCLI_ELECTRON_PACKAGE_DIR: electronDir,
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(runtimePath), false, 'external environment must not select executable installer code')
})
