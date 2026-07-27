import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

test('release publishing is idempotent for an existing tag release', () => {
  assert.match(workflow, /gh release view "\$\{GITHUB_REF_NAME\}"/)
  assert.match(workflow, /gh release upload "\$\{GITHUB_REF_NAME\}" release\/\* --clobber/)
  assert.match(workflow, /gh release create "\$\{GITHUB_REF_NAME\}"/)
})
