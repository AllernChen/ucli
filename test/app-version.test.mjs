import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import config from '../electron.vite.config.mjs'

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const profileCenterSource = readFileSync(new URL('../src/views/ProfileCenter.vue', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('release package version is 0.8.3', () => {
  assert.equal(packageJson.version, '0.8.3')
})

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

test('profile center derives user-visible version labels from the package version', () => {
  assert.match(profileCenterSource, /const appVersion = __UCLI_VERSION__/)
  assert.doesNotMatch(profileCenterSource, /0\.8\.1/)
})

test('header does not show fixed CLI provider tags', () => {
  assert.doesNotMatch(appSource, /<a-tag color="purple">Claude Code<\/a-tag>/)
  assert.doesNotMatch(appSource, /<a-tag color="green">Codex<\/a-tag>/)
})

test('workbench route hides the global layout header while other routes retain it', () => {
  assert.match(appSource, /<a-layout-header v-if="!isWorkbenchRoute" class="header">/)
  assert.match(appSource, /const isWorkbenchRoute = computed\(\(\) => route\.path\.startsWith\('\/session'\)\)/)
})
