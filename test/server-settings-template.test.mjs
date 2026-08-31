import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'

const panel = readFileSync(new URL('../src/components/settings/ServerConnectionPanel.vue', import.meta.url), 'utf8')
const dialog = readFileSync(new URL('../src/components/serverConnection/RegistrationConfirmDialog.vue', import.meta.url), 'utf8')
const skillsCenter = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')

test('server connection settings components compile and cover public lifecycle states', () => {
  assert.deepEqual(parseSfc(panel, { filename: 'ServerConnectionPanel.vue' }).errors, [])
  assert.deepEqual(parseSfc(dialog, { filename: 'RegistrationConfirmDialog.vue' }).errors, [])
  assert.deepEqual(parseSfc(skillsCenter, { filename: 'SkillsCenter.vue' }).errors, [])
  for (const status of ['disconnected', 'connecting', 'connected', 'unreachable', 'PERSISTENCE_PENDING', 'expiring', 'disabled', 'expired', 'deleted', 'account_inactive', 'org_inactive']) {
    assert.match(panel, new RegExp(status))
  }
  for (const label of ['授权到期', '最近同步', '粘贴连接', '便携版']) assert.match(panel, new RegExp(label))
})

test('connection and catalog errors are rendered by their owning surfaces', () => {
  assert.match(panel, /connection\.connectionError/)
  assert.match(panel, /connection\.modelCatalogError/)
  assert.match(panel, /connection\.skillsCatalogError/)
  assert.doesNotMatch(panel, /connection\.error/)
  assert.match(skillsCenter, /serverConnection\.skillsCatalogError/)
  assert.doesNotMatch(skillsCenter, /serverConnection\.error/)
})

test('registration dialog renders independent link and authorization status and cancels on close', () => {
  for (const label of ['服务端', '组织', '成员', '链接状态', '链接有效期', '授权状态', '授权有效期', '服务器时间']) assert.match(dialog, new RegExp(label))
  assert.match(dialog, /link\.value\.status === 'AVAILABLE'/)
  assert.match(dialog, /authorization\.value\.status === 'AVAILABLE'/)
  assert.match(dialog, /@cancel="cancel"/)
  assert.match(panel, /disconnectConfirmation/)
  assert.match(dialog, /:closable="!connection\.busy"/)
  assert.match(dialog, /:mask-closable="!connection\.busy"/)
  assert.match(dialog, /:keyboard="!connection\.busy"/)
  assert.match(dialog, /connection\.connectionError\?\.message/)
  assert.doesNotMatch(dialog, /connection\.error/)
})

test('connection templates do not retain an invitation secret or full input URL', () => {
  assert.doesNotMatch(panel, /localStorage|sessionStorage/)
  assert.doesNotMatch(dialog, /linkSecret|connectionUrl|fullInvite/i)
  assert.match(panel, /linkInput\.value = ''/)
})

test('the application root initializes the singleton connection store and disposes it once', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /useServerConnectionStore/)
  assert.match(app, /void serverConnection\.initialize\(\)\.catch\(\(\) => \{\}\)/)
  assert.match(app, /serverConnection\.dispose\(\)/)
})
