import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { symlinkOrSkip } from './helpers/fsCapabilities.mjs'

test('symlinkOrSkip creates the requested link when the platform capability is available', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-fs-capabilities-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'target.txt')
  const link = join(root, 'link.txt')
  writeFileSync(target, 'target')

  if (!symlinkOrSkip(t, target, link, 'file')) return

  assert.equal(lstatSync(link).isSymbolicLink(), true)
})

test('symlinkOrSkip preserves non-capability filesystem failures', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-fs-capabilities-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'target.txt')
  const missingParent = join(root, 'missing-parent')
  writeFileSync(target, 'target')
  mkdirSync(missingParent, { recursive: false })
  rmdirSync(missingParent)

  assert.throws(
    () => symlinkOrSkip(t, target, join(missingParent, 'link.txt'), 'file'),
    { code: 'ENOENT' }
  )
})
