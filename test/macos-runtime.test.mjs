import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { applyMacLoginPath } from '../electron/macEnvironment.js'

const require = createRequire(import.meta.url)
const { ensureNodePtySpawnHelpersExecutable } = require('../scripts/fix-node-pty-permissions.cjs')

test('macOS GUI restores PATH from the login shell', () => {
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }
  const calls = []

  const pathValue = applyMacLoginPath({
    platform: 'darwin',
    env,
    run: (file, args) => {
      calls.push({ file, args })
      return {
        status: 0,
        stdout: 'shell startup text\n__UCLI_PATH__/Users/test/.npm-global/bin:/usr/bin:/bin\n'
      }
    }
  })

  assert.equal(pathValue, '/Users/test/.npm-global/bin:/usr/bin:/bin')
  assert.equal(env.PATH, pathValue)
  assert.equal(calls[0].file, '/bin/zsh')
  assert.deepEqual(calls[0].args.slice(0, 2), ['-ilc', 'printf "__UCLI_PATH__%s\\n" "$PATH"'])
})

test('macOS GUI keeps its current PATH if login shell discovery fails', () => {
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }
  const pathValue = applyMacLoginPath({
    platform: 'darwin',
    env,
    run: () => ({ status: 1, stdout: '' })
  })

  assert.equal(pathValue, '/usr/bin:/bin')
  assert.equal(env.PATH, '/usr/bin:/bin')
})

test('macOS packaging makes node-pty spawn helpers executable', async (t) => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), 'ucli-node-pty-'))
  t.after(() => rm(appRoot, { recursive: true, force: true }))
  const helper = path.join(
    appRoot,
    'node_modules',
    'node-pty',
    'prebuilds',
    'darwin-x64',
    'spawn-helper'
  )
  await mkdir(path.dirname(helper), { recursive: true })
  await writeFile(helper, 'helper')
  await chmod(helper, 0o644)

  const changed = ensureNodePtySpawnHelpersExecutable({ appRoot, platform: 'darwin' })

  assert.deepEqual(changed, [helper])
  assert.equal((await stat(helper)).mode & 0o111, 0o111)
})
