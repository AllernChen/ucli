import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { baseParse, NodeTypes } from '@vue/compiler-dom'
import { parse } from '@vue/compiler-sfc'

function loadTemplate(file) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  return { source, ast: baseParse(descriptor.template.content) }
}

function findElements(node, predicate, matches = []) {
  if (node.type === NodeTypes.ELEMENT && predicate(node)) matches.push(node)
  for (const child of node.children || []) findElements(child, predicate, matches)
  return matches
}

function staticText(node) {
  return (node.children || [])
    .filter((child) => child.type === NodeTypes.TEXT)
    .map((child) => child.content)
    .join('')
    .trim()
}

function directive(node, name, argument = null) {
  return node.props.find((prop) =>
    prop.type === NodeTypes.DIRECTIVE &&
    prop.name === name &&
    (argument === null || prop.arg?.content === argument)
  )
}

function attribute(node, name) {
  return node.props.find((prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === name)?.value?.content
}

test('each populated Codex pane exposes the session diagnostics entry', () => {
  const { ast } = loadTemplate('../src/views/SessionDetail.vue')
  const buttons = findElements(ast, (node) => node.tag === 'a-button')
  const diagnosticButton = buttons.find((node) => staticText(node) === '诊断')

  assert.ok(diagnosticButton)
  assert.equal(directive(diagnosticButton, 'if')?.exp?.content, 'pane.sessionId && isCodexSession(pane.sessionId)')
  assert.equal(directive(diagnosticButton, 'on')?.exp?.content, 'openSessionDiagnostics(i)')

  const modal = findElements(ast, (node) => node.tag === 'SessionDiagnosticsModal')[0]
  assert.ok(modal)
  assert.equal(directive(modal, 'model')?.arg?.content, 'open')
  assert.equal(directive(modal, 'bind')?.arg?.content, 'session-id')
})

test('session diagnostics modal renders the safe binding contract and gates repair', () => {
  const { source, ast } = loadTemplate('../src/components/SessionDiagnosticsModal.vue')
  const descriptions = findElements(ast, (node) => node.tag === 'a-descriptions-item')
  const labels = descriptions.map((node) => attribute(node, 'label'))

  assert.deepEqual(labels, [
    'UCLI 会话 ID',
    '当前绑定',
    '解析结果',
    '项目目录',
    '父子链'
  ])

  const buttons = findElements(ast, (node) => node.tag === 'a-button')
  const repair = buttons.find((node) => staticText(node) === '修复绑定')
  assert.ok(repair)
  assert.equal(directive(repair, 'bind', 'disabled')?.exp?.content, '!diagnostic?.repairAvailable')
  assert.equal(directive(repair, 'on')?.exp?.content, 'repairBinding')
  assert.equal(findElements(ast, (node) => Boolean(directive(node, 'html'))).length, 0)
  assert.doesNotMatch(source, /rolloutPath|transcript|prompt|messageBody/)
})
