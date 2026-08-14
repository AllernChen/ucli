import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { baseParse, NodeTypes } from '@vue/compiler-dom'
import { parse } from '@vue/compiler-sfc'

function templateElements(file) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const ast = baseParse(descriptor.template.content)
  const elements = []

  function visit(node) {
    if (node.type === NodeTypes.ELEMENT) elements.push(node)
    for (const child of node.children || []) visit(child)
  }
  visit(ast)
  return elements
}

function hasDirective(node, name) {
  return node.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === name)
}

function hasClass(node, className) {
  return node.props.some((prop) =>
    prop.type === NodeTypes.ATTRIBUTE &&
    prop.name === 'class' &&
    prop.value?.content.split(/\s+/).includes(className)
  )
}

test('session panes mount xterm and history only for authoritative terminal capabilities', () => {
  const elements = templateElements('../src/views/SessionDetail.vue')
  const terminal = elements.find((node) => node.tag === 'div' && hasClass(node, 'pane-terminal'))
  const history = elements.find((node) => node.tag === 'PaneHistory')

  assert.ok(terminal)
  assert.ok(history)
  assert.equal(hasDirective(terminal, 'show'), true)
  assert.equal(hasDirective(terminal, 'if'), true)
  assert.equal(hasDirective(history, 'show'), true)
  assert.equal(hasDirective(history, 'if'), true)
})

test('history templates never render provider content as HTML', () => {
  for (const file of [
    '../src/views/SessionDetail.vue',
    '../src/components/PaneHistory.vue'
  ]) {
    const elements = templateElements(file)
    assert.equal(elements.some((node) => hasDirective(node, 'html')), false)
  }
})
