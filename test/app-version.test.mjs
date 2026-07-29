import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import config from '../electron.vite.config.mjs'

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('sidebar version is injected from the package version during renderer build', () => {
  assert.ok(config.renderer.define, 'renderer build must define app version metadata')
  assert.equal(
    config.renderer.define.__UCLI_VERSION__,
    JSON.stringify(packageJson.version)
  )
  assert.match(appSource, /const appVersion = __UCLI_VERSION__/)
  assert.match(appSource, /\{\{ appVersion \}\}/)
  assert.doesNotMatch(appSource, /v0\.3\.1/)
})

test('header does not show fixed CLI provider tags', () => {
  assert.doesNotMatch(appSource, /<a-tag color="purple">Claude Code<\/a-tag>/)
  assert.doesNotMatch(appSource, /<a-tag color="green">Codex<\/a-tag>/)
})
