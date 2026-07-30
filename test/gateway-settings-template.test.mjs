import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('settings owns the Gateway summary card and route-driven drawer', () => {
  const source = readFileSync(
    new URL('../src/views/Settings.vue', import.meta.url),
    'utf8'
  )
  assert.match(source, /title="通信 Gateway"/)
  assert.match(source, /GatewayConfigDrawer/)
  assert.match(source, /route\.query\.panel/)
  assert.match(source, /router\.replace/)
})

test('Gateway drawer separates endpoint, sessions, and runtime without rendering content bodies', () => {
  const source = readFileSync(
    new URL('../src/components/gateway/GatewayConfigDrawer.vue', import.meta.url),
    'utf8'
  )
  for (const heading of ['通信端配置', 'AI CLI 会话', 'Gateway 运行状态']) {
    assert.match(source, new RegExp(heading))
  }
  for (const field of ['App ID', 'App Secret', '飞书会话绑定']) {
    assert.match(source, new RegExp(field))
  }
  assert.doesNotMatch(source, /目标 ID|Operator Open ID/)
  assert.match(source, /confirmBinding/)
  assert.match(source, /dismissBinding/)
  assert.match(source, /clearBinding/)
  assert.match(source, /confirmationCode/)
  assert.match(source, /targetHint/)
  assert.match(source, /operatorHint/)
  assert.match(source, /confirmBinding\(gateway\.runtime\.bindingCandidate\.id\)/)
  assert.match(source, /绑定 UCLI/)
  assert.match(source, /测试连接/)
  assert.match(source, /保存并应用/)
  assert.match(source, /重新同步/)
  assert.match(source, /Bot 身份/)
  assert.match(source, /item\.queueCount/)
  assert.match(source, /aria-label/)
  assert.doesNotMatch(source, /taskText|messageBody|commandBody|snapshotContent/)
})

test('drawer clears its write-only secret on test completion, close, and unmount', () => {
  const source = readFileSync(
    new URL('../src/components/gateway/GatewayConfigDrawer.vue', import.meta.url),
    'utf8'
  )
  assert.match(source, /finally\s*{[^}]*appSecret[^}]*=\s*''/s)
  assert.match(source, /function closeDrawer\(\)[\s\S]*appSecret[\s\S]*=\s*''/)
  assert.match(source, /onUnmounted\(\(\) =>[\s\S]*appSecret[\s\S]*=\s*''/)
})
