import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { baseParse } from '@vue/compiler-dom'

const componentUrl = new URL(
  '../src/components/gateway/GatewayRelayToggle.vue',
  import.meta.url
)
const sessionCardUrl = new URL('../src/components/SessionCard.vue', import.meta.url)
const sessionDetailUrl = new URL('../src/views/SessionDetail.vue', import.meta.url)
const workbenchUrl = new URL('../src/views/Workbench.vue', import.meta.url)

test('GatewayRelayToggle exposes one accessible, store-backed session relay control', () => {
  const source = readFileSync(componentUrl, 'utf8')
  const { descriptor, errors } = parseSfc(source)

  assert.deepEqual(errors, [])
  assert.ok(descriptor.template, 'component must provide a template')
  assert.doesNotThrow(() => baseParse(descriptor.template.content))
  assert.match(source, /aria-label/)
  assert.match(source, /\$\{view\.label\}：\$\{sessionName \|\| '当前会话'\}/)
  assert.match(source, /gateway\.relayPendingFor\(props\.sessionId\)/)
  assert.match(source, /deriveGatewayRelayControl/)
  assert.match(source, /GatewayChannelIcon/)
  assert.doesNotMatch(source, /GlobalOutlined/)
  assert.match(source, /\.tone-default\s*\{\s*color:\s*#bfbfbf/)
  assert.match(source, /message\.error/)
  assert.match(source, /@click\.stop="toggleRelay"/)
  assert.doesNotMatch(source, /v-html/)
})

test('session cards and workbench panes use the shared relay control', () => {
  const sessionCard = readFileSync(sessionCardUrl, 'utf8')
  const sessionDetail = readFileSync(sessionDetailUrl, 'utf8')
  const workbench = readFileSync(workbenchUrl, 'utf8')

  assert.match(sessionCard, /<GatewayRelayToggle[^>]*:session-id="session\.id"/)
  assert.match(sessionDetail, /<GatewayRelayToggle[^>]*:session-id="pane\.sessionId"/)
  assert.doesNotMatch(sessionCard, /relaySwitching|relay-icon|toggleRelay/)
  assert.doesNotMatch(sessionDetail, /paneRelayOn|togglePaneRelay/)
  assert.match(workbench, /gateway\.init\(\)/)
})

test('the workbench session list exposes a read-only Gateway relay state', () => {
  const sessionDetail = readFileSync(sessionDetailUrl, 'utf8')

  assert.match(sessionDetail, /'session-relay-state'/)
  assert.match(sessionDetail, /relayView\(s\)\.label/)
  assert.match(sessionDetail, /deriveGatewayRelayControl/)
  assert.match(sessionDetail, /<GatewayChannelIcon/)
})
