import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import config from '../electron.vite.config.mjs'

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const profileCenterSource = readFileSync(new URL('../src/views/ProfileCenter.vue', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const bridgePackage = JSON.parse(readFileSync(
  new URL('../integrations/deepseek-harness-bridge/package.json', import.meta.url),
  'utf8'
))

test('app metadata retains the quarantined 0.11.0 bridge package', () => {
  assert.equal(packageJson.version, '0.12.2')
  assert.equal(packageLock.version, '0.12.2')
  assert.equal(packageLock.packages[''].version, '0.12.2')
  assert.equal(bridgePackage.version, '0.11.0')
  assert.equal(packageJson.overrides['glob@10.4.5'], '10.5.0')
  assert.equal(packageJson.overrides['@xmldom/xmldom@0.8.14'], '0.8.15')
  assert.equal(packageJson.overrides['@xmldom/xmldom@0.9.11'], '0.9.12')
  assert.equal(packageJson.overrides['fast-uri@3.1.5'], '3.1.7')
  assert.equal(packageJson.overrides['qs@6.15.3'], '6.16.0')
})

test('sidebar version is injected from the package version during renderer build', () => {
  assert.ok(config.renderer.define, 'renderer build must define app version metadata')
  assert.equal(
    config.renderer.define.__UCLI_VERSION__,
    JSON.stringify(packageJson.version)
  )
  assert.match(appSource, /const appVersion = __UCLI_VERSION__/)
  assert.match(appSource, /:app-version="appVersion"/)
  const footerSource = readFileSync(new URL('../src/components/updates/UpdateSiderFooter.vue', import.meta.url), 'utf8')
  assert.match(footerSource, /v\{\{ appVersion \}\}/)
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
