import assert from 'node:assert/strict'
import test from 'node:test'

import {
  profileBadges,
  profileEndpointLabel,
  profileOriginLabel,
  profileRuntimeNotice,
  profileSecretLabel,
  serviceProfileAvailabilityPresentation,
  serviceProfileLabel,
  serviceModelLabel,
  profileStatusPresentation
} from '../src/profilePresentation.js'

test('profile presentation explains every actionable runtime state', () => {
  assert.deepEqual(profileStatusPresentation('ready'), { label: '可用', color: 'green', action: null })
  assert.equal(profileStatusPresentation('drifted').label, '文件已被外部修改')
  assert.equal(profileStatusPresentation('drifted').action, 'review-drift')
  assert.equal(profileStatusPresentation('missing_file').action, 'repair')
  assert.equal(profileStatusPresentation('missing_provider').label, '引用的 Provider 不存在')
  assert.equal(profileStatusPresentation('secret_unavailable').label, '密钥不可用')
})

test('server profile presentation identifies organization ownership and explicit availability states', () => {
  assert.equal(profileOriginLabel({ sourceKind: 'server', organizationName: 'Example organization' }), '组织提供 · Example organization')
  assert.equal(profileStatusPresentation('unreachable').label, '服务端暂时不可达')
  assert.equal(profileStatusPresentation('disabled').label, '服务端授权已停用')
  assert.equal(profileStatusPresentation('expired').label, '服务端授权已到期')
  assert.equal(profileStatusPresentation('deleted').label, '服务端授权已删除')
  assert.equal(profileRuntimeNotice({ sourceKind: 'server', status: 'unreachable' }), '组织提供的档案当前不可用')
})

test('profile presentation shows hostname and masked secret only', () => {
  assert.equal(profileEndpointLabel('https://api.example.com/v1'), 'api.example.com')
  assert.equal(profileEndpointLabel('not-a-url'), '未设置')
  assert.equal(profileSecretLabel({ hasSecret: true, secretSuffix: '1234' }), '已安全保存 ···· 1234')
  assert.equal(profileSecretLabel({ hasSecret: false }), '未保存密钥')
})

test('profile presentation describes defaults and restart truthfully', () => {
  assert.deepEqual(profileBadges({ isAppDefault: true, isProjectDefault: true }), ['应用默认', '项目默认'])
  assert.equal(profileRuntimeNotice({ restartRequired: true }), '档案将在重启会话后生效')
  assert.equal(profileRuntimeNotice({ profileStatus: 'drifted' }), '当前档案不可启动，请先处理配置问题')
})

test('service model labels retain the exact model ID without duplicating identical display names', () => {
  assert.equal(serviceModelLabel({ id: 'responses-a', displayName: 'Responses A' }), 'Responses A · responses-a')
  assert.equal(serviceModelLabel({ id: 'responses-a', displayName: 'responses-a' }), 'responses-a')
  assert.equal(serviceModelLabel({ id: 'responses-a', displayName: '' }), 'responses-a')
})

test('service profile presentation uses safe service fields only', () => {
  assert.equal(serviceProfileLabel({ serverOrigin: 'https://api.example.com', organization: { name: 'Research' } }), 'api.example.com · Research')
  assert.equal(serviceProfileLabel({ serverOrigin: 'not-a-url', organization: {} }), '未设置服务')
  assert.deepEqual(serviceProfileAvailabilityPresentation('ready'), { label: '可用', color: 'green' })
  assert.deepEqual(serviceProfileAvailabilityPresentation('disabled'), { label: '服务端授权已停用', color: 'red' })
})
