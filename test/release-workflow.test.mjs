import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

test('release workflow uses Actions versions backed by the Node 24 runtime', () => {
  assert.match(workflow, /actions\/checkout@v7/)
  assert.match(workflow, /actions\/setup-node@v7/)
  assert.match(workflow, /actions\/upload-artifact@v7/)
  assert.match(workflow, /actions\/download-artifact@v8/)
})

test('release publishing is idempotent for an existing tag release', () => {
  assert.match(workflow, /gh release view "\$\{GITHUB_REF_NAME\}"/)
  assert.match(workflow, /gh release upload "\$\{GITHUB_REF_NAME\}" release\/\* --clobber/)
  assert.match(workflow, /gh release create "\$\{GITHUB_REF_NAME\}"/)
})

test('macOS release targets arm64 so the published U-Code binary can run', () => {
  assert.match(workflow, /os: macos-26\s+[\s\S]*verify_command: npm run verify:release -- --platform darwin --arch arm64/)
  assert.doesNotMatch(workflow, /macos-26-intel|--platform darwin --arch x64/)
})
