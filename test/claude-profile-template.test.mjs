import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../src/views/ProfileCenter.vue', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('../src/components/profiles/ClaudeProfileDrawer.vue', import.meta.url), 'utf8')

test('Claude profile editor offers login, API Key, and Bearer modes with honest warnings', () => {
  for (const label of ['Claude 登录态', 'Anthropic API Key', 'Bearer Token', 'Base URL']) {
    assert.match(drawer, new RegExp(label))
  }
  assert.match(drawer, /会覆盖当前 Claude 订阅登录用于本会话/)
  assert.match(drawer, /connectionMode === 'bearer'/)
  assert.match(drawer, /form\.connectionMode !== props\.profile\?\.connectionMode/)
  assert.match(drawer, /requiresBaseUrl/)
  assert.doesNotMatch(drawer, /fallback/i)
  assert.doesNotMatch(drawer, /读取 Claude 登录 token|显示密钥|查看密钥/)
})

test('profile center enables Claude profiles while OpenCode and U-Code remain system managed', () => {
  assert.match(page, /ClaudeProfileDrawer/)
  assert.match(page, /selectedCli === 'claude'/)
  assert.match(page, /visibleProfiles/)
  assert.match(page, /profile\.adapterId/)
  assert.match(page, /使用现有 Claude 登录态/)
  assert.match(page, /Anthropic 官方地址/)
  assert.match(page, /OpenCode.*0\.8\.1|0\.8\.1 沿用系统配置/s)
})
