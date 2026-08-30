import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claudeConnectionModePresentation,
  claudeInheritedAuthPresentation,
  profileRuntimeNotice
} from '../src/profilePresentation.js'
import { readFileSync } from 'node:fs'

test('Claude connection modes have clear non-technical labels and credential expectations', () => {
  assert.deepEqual(claudeConnectionModePresentation('subscription'), {
    label: 'Claude 登录态',
    secretLabel: null,
    requiresBaseUrl: false
  })
  assert.deepEqual(claudeConnectionModePresentation('api_key'), {
    label: 'Anthropic API Key',
    secretLabel: 'API Key',
    requiresBaseUrl: false
  })
  assert.deepEqual(claudeConnectionModePresentation('bearer'), {
    label: 'Bearer Token 网关',
    secretLabel: 'Bearer Token',
    requiresBaseUrl: true
  })
})

test('Claude inherited auth presentation exposes only the authentication kind', () => {
  assert.equal(claudeInheritedAuthPresentation('api_key'), '检测到继承的 API Key')
  assert.equal(claudeInheritedAuthPresentation('bearer'), '检测到继承的 Bearer Token')
  assert.equal(claudeInheritedAuthPresentation('cloud_provider'), '检测到云服务商路由')
  assert.equal(claudeInheritedAuthPresentation('login_or_unknown'), '使用 Claude 登录态或系统默认')
})

test('profile runtime notice explains model substitution and pending restart', () => {
  assert.equal(profileRuntimeNotice({ profileWarning: 'model_substituted' }), '实际模型已被 Claude 组织策略替换')
  assert.equal(profileRuntimeNotice({ restartRequired: true }), '档案将在重启会话后生效')
})

test('server profiles omit local-management controls', () => {
  const page = readFileSync(new URL('../src/views/ProfileCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /v-if="!isReadOnlyProfile\(profile\)"/)
  assert.match(page, /组织提供/)
})
