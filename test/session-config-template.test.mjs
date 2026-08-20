import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { baseParse, NodeTypes } from '@vue/compiler-dom'
import { parse as parseSfc } from '@vue/compiler-sfc'

function loadComponent(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { descriptor, errors } = parseSfc(source)
  assert.deepEqual(errors, [])
  assert.ok(descriptor.template)
  return { source, ast: baseParse(descriptor.template.content) }
}

function findElements(node, predicate, matches = []) {
  if (node.type === NodeTypes.ELEMENT && predicate(node)) matches.push(node)
  for (const child of node.children || []) findElements(child, predicate, matches)
  return matches
}

function textContent(node) {
  if (node.type === NodeTypes.TEXT) return node.content
  return (node.children || []).map(textContent).join('')
}

function hasDirective(node, name) {
  return node.props?.some((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === name)
}

function hasClass(node, className) {
  return node.props?.some((prop) =>
    prop.type === NodeTypes.ATTRIBUTE &&
    prop.name === 'class' &&
    prop.value?.content.split(/\s+/).includes(className)
  )
}

function attribute(node, name) {
  return node.props?.find((prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === name)?.value?.content
}

function directiveExpression(node, name) {
  return node.props?.find((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === name)?.exp?.content
}

test('session configuration modal contains configuration but no routine maintenance section', () => {
  const { ast } = loadComponent('../src/components/SessionConfigModal.vue')
  const headings = findElements(ast, (node) => node.tag === 'h3')
    .map((node) => textContent(node).trim())

  assert.deepEqual(headings, ['会话信息', '运行配置', '协作与诊断'])
  assert.equal(findElements(ast, (node) => node.tag === 'GatewayRelayToggle').length, 1)
  assert.equal(findElements(ast, (node) => node.tag === 'SessionDiagnosticsModal').length, 1)
})

test('session configuration modal exposes profile and Provider controls', () => {
  const { source, ast } = loadComponent('../src/components/SessionConfigModal.vue')
  const visibleText = textContent(ast)

  for (const label of [
    '保存会话信息',
    '系统 / 来源策略',
    '来源 Provider',
    '跟随当前',
    '显式指定',
    '会话诊断'
  ]) {
    assert.match(visibleText, new RegExp(label))
  }
  for (const handler of [
    'saveBasics',
    'setSessionProfile',
    'setCodexProviderPolicy'
  ]) {
    assert.match(source, new RegExp(handler))
  }
})

test('session settings never own layout or routine maintenance actions', () => {
  const { source } = loadComponent('../src/components/SessionConfigModal.vue')

  assert.doesNotMatch(source, /clearPane|compactPanes|关闭窗格|停止进程|移除 UCLI 记录/)
  assert.doesNotMatch(source, /function stopSession|function restartSession|function removeSession/)
})

test('session configuration modal does not expose secrets or render provider content as HTML', () => {
  const { source, ast } = loadComponent('../src/components/SessionConfigModal.vue')

  assert.doesNotMatch(source, /apiKey|bearerToken|secret/i)
  assert.equal(findElements(ast, (node) => hasDirective(node, 'html')).length, 0)
})

test('session configuration modal invalidates stale Codex runtime subscriptions', () => {
  const { source } = loadComponent('../src/components/SessionConfigModal.vue')

  assert.match(source, /runtimeSubscriptionVersion \+= 1/)
  assert.match(source, /subscriptionVersion !== runtimeSubscriptionVersion/)
  assert.match(source, /session\.value\?\.adapterId !== 'codex'/)
  assert.match(source, /aiProfiles\.load\(session\.value\?\.cwd \|\| ''\)\.catch/)
})

test('populated pane headers expose compact settings, viewing, maintenance, and close entry points', () => {
  const { source, ast } = loadComponent('../src/views/SessionDetail.vue')
  const paneHeader = findElements(ast, (node) => node.tag === 'div' && hasClass(node, 'pane-header'))[0]
  assert.ok(paneHeader)

  const buttons = findElements(paneHeader, (node) => node.tag === 'a-button')
  const staticLabels = buttons.map((node) => textContent(node).trim()).filter(Boolean)
  assert.equal(buttons.length, 6)
  assert.ok(buttons.some((node) => attribute(node, 'aria-label') === '在工作台定位'))
  assert.ok(buttons.some((node) => directiveExpression(node, 'on') === 'locateSession(pane.sessionId)'))
  assert.ok(buttons.some((node) => attribute(node, 'aria-label') === '会话产物'))
  assert.ok(buttons.some((node) => directiveExpression(node, 'on') === 'openArtifacts(pane.sessionId)'))
  assert.ok(buttons.some((node) => attribute(node, 'aria-label') === '配置会话'))
  assert.ok(buttons.some((node) => directiveExpression(node, 'on') === 'togglePaneHistory(i)'))
  assert.ok(buttons.some((node) => directiveExpression(node, 'on') === 'togglePaneFullscreen(i)'))
  assert.ok(buttons.some((node) => directiveExpression(node, 'on') === 'clearPane(i)'))
  assert.ok(staticLabels.includes('关闭'))
  assert.equal(staticLabels.includes('诊断'), false)
  assert.equal(findElements(paneHeader, (node) => node.tag === 'SessionMaintenanceActions').length, 1)
  assert.match(source, /@removed="handleConfiguredSessionRemoved"/)
  assert.doesNotMatch(source, /interruptPane/)
  assert.equal(findElements(paneHeader, (node) => node.tag === 'GatewayRelayToggle').length, 0)
  assert.equal(findElements(ast, (node) => node.tag === 'SessionConfigModal').length, 1)
})

test('pane information bar is read-only', () => {
  const { ast } = loadComponent('../src/views/SessionDetail.vue')
  const paneInfo = findElements(ast, (node) => node.tag === 'div' && hasClass(node, 'pane-info'))[0]

  assert.ok(paneInfo)
  assert.equal(findElements(paneInfo, (node) => node.tag === 'a-select').length, 0)
  assert.equal(findElements(paneInfo, (node) => node.tag === 'a-button').length, 0)
})

test('overview cards expose one configuration action without inline editors', () => {
  const { source, ast } = loadComponent('../src/components/SessionCard.vue')

  assert.equal(findElements(ast, (node) => node.tag === 'a-input').length, 0)
  assert.equal(findElements(ast, (node) => node.tag === 'GatewayRelayToggle').length, 0)
  assert.equal(findElements(ast, (node) => node.tag === 'SettingOutlined').length, 1)
  assert.match(source, /view\.needsAttention/)
  assert.match(source, /emit\('configure', props\.session\.id\)/)
  assert.doesNotMatch(source, /EditOutlined|updateName|startEdit/)
})

test('overview reuses a single session configuration modal for all cards', () => {
  const { source, ast } = loadComponent('../src/views/Workbench.vue')

  assert.match(source, /@configure="openSessionConfig"/)
  assert.match(source, /function openSessionConfig\(sessionId\)/)
  assert.equal(findElements(ast, (node) => node.tag === 'SessionConfigModal').length, 1)
})

test('pane maintenance menu distinguishes soft interrupt from process stop', () => {
  const { source, ast } = loadComponent('../src/components/SessionMaintenanceActions.vue')
  const visibleText = textContent(ast)

  assert.equal(findElements(ast, (node) => node.tag === 'a-dropdown').length, 1)
  for (const label of ['会话操作', '中断当前任务', '移除 UCLI 记录']) {
    assert.match(visibleText, new RegExp(label))
  }
  assert.match(visibleText, /只中断当前任务，CLI 进程继续运行/)
  assert.match(source, /copy\.stopTitle/)
  assert.match(source, /copy\.stopHelp/)
  assert.match(source, /copy\.restartTitle/)
  assert.match(source, /copy\.restartHelp/)
  assert.match(source, /deriveSessionMaintenanceCopy/)
  assert.match(source, /pendingAction/)
  assert.match(source, /sessions\.interrupt/)
  assert.match(source, /sessions\.stop/)
  assert.match(source, /sessions\.restart/)
  assert.match(source, /sessions\.deleteSession/)
  assert.match(source, /emit\('removed', sessionId\)/)
  assert.doesNotMatch(source, /clearPane|关闭窗格|v-html/)
})
