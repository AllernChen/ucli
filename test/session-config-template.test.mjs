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

test('session configuration modal groups low-frequency controls into four sections', () => {
  const { ast } = loadComponent('../src/components/SessionConfigModal.vue')
  const headings = findElements(ast, (node) => node.tag === 'h3')
    .map((node) => textContent(node).trim())

  assert.deepEqual(headings, ['会话信息', '运行配置', '协作与诊断', '会话维护'])
  assert.equal(findElements(ast, (node) => node.tag === 'GatewayRelayToggle').length, 1)
  assert.equal(findElements(ast, (node) => node.tag === 'SessionDiagnosticsModal').length, 1)
})

test('session configuration modal exposes profile, Provider, and lifecycle controls', () => {
  const { source, ast } = loadComponent('../src/components/SessionConfigModal.vue')
  const visibleText = textContent(ast)

  for (const label of [
    '保存会话信息',
    '系统 / 来源策略',
    '来源 Provider',
    '跟随当前',
    '显式指定',
    '会话诊断',
    '停止进程',
    '重启会话',
    '移除 UCLI 记录'
  ]) {
    assert.match(visibleText, new RegExp(label))
  }
  for (const handler of [
    'saveBasics',
    'setSessionProfile',
    'setCodexProviderPolicy',
    'stopSession',
    'restartSession',
    'removeSession'
  ]) {
    assert.match(source, new RegExp(handler))
  }
})

test('dangerous session removal never masquerades as closing a pane', () => {
  const { source, ast } = loadComponent('../src/components/SessionConfigModal.vue')
  const visibleText = textContent(ast)

  assert.match(visibleText, /停止 CLI 进程并保留会话/)
  assert.match(visibleText, /源会话和用量统计会保留/)
  assert.doesNotMatch(source, /clearPane|compactPanes|关闭窗格/)
})

test('session configuration modal does not expose secrets or render provider content as HTML', () => {
  const { source, ast } = loadComponent('../src/components/SessionConfigModal.vue')

  assert.doesNotMatch(source, /apiKey|bearerToken|secret/i)
  assert.equal(findElements(ast, (node) => hasDirective(node, 'html')).length, 0)
})
