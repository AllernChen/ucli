import assert from 'node:assert/strict'
import test from 'node:test'

import {
  profileBadges,
  profileEndpointLabel,
  profileRuntimeNotice,
  profileSecretLabel,
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
