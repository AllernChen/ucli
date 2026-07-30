import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  gatewayPhaseColor,
  gatewayPhaseLabel,
  gatewayTargetLabel,
  gatewayTooltip
} from '../src/gatewayPresentation.js'

test('Gateway presentation covers every runtime phase with safe Chinese labels', () => {
  assert.deepEqual(
    ['off', 'connecting', 'waiting_binding', 'connected', 'reconnecting', 'error']
      .map(gatewayPhaseLabel),
    ['已关闭', '连接中', '等待绑定', '已连接', '重连中', '连接异常']
  )
  assert.deepEqual(
    ['off', 'connecting', 'waiting_binding', 'connected', 'reconnecting', 'error']
      .map(gatewayPhaseColor),
    ['default', 'blue', 'orange', 'green', 'orange', 'red']
  )
})

test('Gateway target and tooltip expose bounded metadata rather than endpoint details', () => {
  assert.equal(
    gatewayTargetLabel({ target: { type: 'group', id: 'oc_1234567890' } }),
    '群聊 · oc_1…7890'
  )
  const tooltip = gatewayTooltip({
    selectedSessionCount: 2,
    readySessionCount: 1,
    errorMessage: 'Gateway 权限不足，请检查飞书应用权限。'
  })
  assert.match(tooltip, /已选择 2/)
  assert.match(tooltip, /可转发 1/)
  assert.match(tooltip, /Gateway 权限不足/)
})

test('unbound Gateway presentation explains that Feishu is waiting for binding', () => {
  assert.equal(gatewayPhaseLabel('waiting_binding'), '等待绑定')
  assert.equal(gatewayTargetLabel({ target: null }), '等待飞书绑定')
  assert.equal(
    gatewayTargetLabel({
      target: { type: 'group', id: 'oc_1234567890', name: '研发群' }
    }),
    '群聊 · 研发群'
  )
})

test('Gateway store never declares or assigns an App Secret field', () => {
  const source = readFileSync(
    new URL('../src/stores/gateway.js', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(source, /appSecret/)
  assert.match(source, /onGatewayState/)
  assert.match(source, /testGatewayDraft/)
  assert.match(source, /setSessionRelayEnabled/)
  assert.match(source, /requireApplied/)
  assert.match(source, /configuration_operation_in_progress/)
})
