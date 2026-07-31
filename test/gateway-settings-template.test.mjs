import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { baseParse, NodeTypes } from '@vue/compiler-dom'

function drawerAst() {
  const source = readFileSync(
    new URL('../src/components/gateway/GatewayConfigDrawer.vue', import.meta.url),
    'utf8'
  )
  const { descriptor } = parseSfc(source)
  return { source, ast: baseParse(descriptor.template.content) }
}

function findElements(node, predicate, matches = []) {
  if (node.type === NodeTypes.ELEMENT && predicate(node)) matches.push(node)
  for (const child of node.children || []) findElements(child, predicate, matches)
  return matches
}

function hasInterpolation(node, expression) {
  if (node.type === NodeTypes.INTERPOLATION && node.content.content === expression) {
    return true
  }
  return (node.children || []).some((child) => hasInterpolation(child, expression))
}

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

test('drawer renders each session relay status from the shared presentation label', () => {
  const { source, ast } = drawerAst()
  const sessionRows = findElements(ast, (node) => node.tag === 'a-list-item')
  const descriptions = sessionRows.flatMap((row) =>
    findElements(row, (node) => node.tag === 'a-list-item-meta')
  )

  assert.match(source, /deriveGatewayRelayControl/)
  assert.ok(
    descriptions.some((node) => hasInterpolation(node, 'relayView(item).label')),
    'each drawer row must expose a presentation-derived relay label, not relayEnabled as forwarding proof'
  )
  assert.match(source, /gateway\.relayPendingFor\(item\.id\)/)
})

test('drawer keeps re-sync available only for selected relay sessions', () => {
  const { ast } = drawerAst()
  const buttons = findElements(ast, (node) => node.tag === 'a-button')
  const resync = buttons.find((node) =>
    node.children.some((child) => child.type === NodeTypes.TEXT && child.content.includes('\u91cd\u65b0\u540c\u6b65'))
  )

  assert.ok(resync, 'selected sessions need a re-sync action')
  const disabled = resync.props.find((prop) => prop.type === NodeTypes.DIRECTIVE && prop.arg?.content === 'disabled')
  assert.equal(disabled?.exp?.content, '!item.relayEnabled')
})

test('drawer routes relay switch failures through a visible error handler', () => {
  const { source } = drawerAst()

  assert.match(source, /@change="\(enabled\) => toggleSessionRelay\(item\.id, enabled\)"/)
  assert.match(source, /async function toggleSessionRelay\(sessionId, enabled\)/)
  assert.match(source, /message\.error\(error\?\.message \|\| '会话转发状态更新失败'\)/)
})

test('drawer does not expose a raw session ID when a session has no display name', () => {
  const { source } = drawerAst()

  assert.match(source, /item\.name \|\| '当前会话'/)
  assert.doesNotMatch(source, /:aria-label="[^\n]*item\.id/)
})
