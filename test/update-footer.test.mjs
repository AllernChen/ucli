import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'

const footer = readFileSync(new URL('../src/components/updates/UpdateSiderFooter.vue', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/components/settings/SoftwareUpdatePanel.vue', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')

test('update footer and settings panel compile and consume only the shared update store', () => {
  assert.deepEqual(parseSfc(footer, { filename: 'UpdateSiderFooter.vue' }).errors, [])
  assert.deepEqual(parseSfc(panel, { filename: 'SoftwareUpdatePanel.vue' }).errors, [])
  assert.match(footer, /useUpdatesStore/)
  assert.match(panel, /useUpdatesStore/)
  assert.doesNotMatch(footer, /from ['"]\.\.\/\.\.\/ipc\.js['"]|ipc\./)
  assert.doesNotMatch(panel, /from ['"]\.\.\/\.\.\/ipc\.js['"]|ipc\./)
})

test('expanded footer keeps version and provides explicit available, progress, and install actions', () => {
  assert.match(footer, /v\{\{ appVersion \}\}/)
  assert.match(footer, /v-if="updates\.status === 'available'"/)
  assert.match(footer, /updates\.availableVersion/)
  assert.match(footer, /updates\.download\(\)/)
  assert.match(footer, /v-if="updates\.status === 'downloading'"/)
  assert.match(footer, /<a-progress[\s\S]*:percent="updates\.progressPercent \?\? 0"/)
  assert.match(footer, /v-if="updates\.status === 'downloaded'"/)
  assert.match(footer, /updates\.install\(\)/)
  assert.match(footer, /updates\.status === 'error'/)
  assert.match(footer, /updateStatusLabel\(updates\.status\)/)
})

test('collapsed footer has an accessible detail trigger without downloading on popover open', () => {
  assert.match(footer, /collapsed/)
  assert.match(footer, /:aria-label="collapsedLabel"/)
  assert.match(footer, /appVersion[\s\S]*updateFooterLabel/)
  assert.match(footer, /progressPercent/)
  assert.match(footer, /settings[\s\S]*section:\s*'updates'/)
  assert.match(footer, /\.\.\.router\.currentRoute\.value\.query[\s\S]*section:\s*'updates'/)
  assert.doesNotMatch(footer, /@openChange="updates\.download|@update:open="updates\.download/)
  assert.doesNotMatch(footer, /onMounted\([\s\S]*updates\.download/)
})

test('collapsed popover explains installing and error states without unsafe actions', () => {
  assert.match(footer, /updates\.status === 'installing'[\s\S]{0,200}updateStatusLabel/)
  assert.match(footer, /updates\.status === 'error'[\s\S]{0,200}updateStatusLabel/)
  assert.doesNotMatch(footer, /updates\.status === 'error'[\s\S]{0,300}updates\.(download|install)\(\)/)
})

test('unsupported and error states never render as an available update action', () => {
  assert.match(footer, /actionable/)
  assert.match(footer, /\['available', 'downloading', 'downloaded', 'installing'\]/)
  assert.doesNotMatch(footer, /v-if="updates\.status === 'unsupported'"[\s\S]{0,300}updates\.download/)
  assert.doesNotMatch(footer, /v-if="updates\.status === 'error'"[\s\S]{0,300}updates\.download/)
})

test('App initializes one shared store and keeps approval indicator beside the update footer', () => {
  assert.match(app, /useUpdatesStore/)
  assert.match(app, /updates\.initialize\(\)/)
  assert.match(app, /<UpdateSiderFooter[\s\S]*:collapsed="navCollapsed"[\s\S]*:app-version="appVersion"/)
  assert.match(app, /<a-badge v-if="navCollapsed && waitingCount > 0"/)
  assert.match(app, /<a-tag v-else-if="waitingCount > 0"/)
})

test('Settings mounts the shared panel and owns no direct update subscription or state', () => {
  assert.equal((settings.match(/<SoftwareUpdatePanel\b/g) || []).length, 1)
  assert.doesNotMatch(settings, /ipc\.on\('update:state'/)
  assert.doesNotMatch(settings, /const updateState = ref/)
  assert.doesNotMatch(settings, /stopUpdateListener|loadUpdateState|runUpdateAction/)
})
