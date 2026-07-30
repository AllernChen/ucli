import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('workbench header places the compact Gateway control before layout controls', () => {
  const workbench = readFileSync(
    new URL('../src/views/Workbench.vue', import.meta.url),
    'utf8'
  )
  const spacer = workbench.indexOf('class="spacer"')
  const gateway = workbench.indexOf('<GatewayHeaderControl')
  const expand = workbench.indexOf('@click="expandAll"')
  assert.ok(spacer >= 0 && gateway > spacer && expand > gateway)
})

test('header control contains only global switch, phase status, and settings navigation', () => {
  const source = readFileSync(
    new URL('../src/components/gateway/GatewayHeaderControl.vue', import.meta.url),
    'utf8'
  )
  assert.match(source, /aria-label="Gateway 总开关"/)
  assert.match(source, /gatewayPhaseLabel/)
  assert.match(source, /name: 'settings'.*panel: 'gateway'/s)
  assert.doesNotMatch(source, /App ID|App Secret|operatorOpenIds|relayEnabled/)
})
