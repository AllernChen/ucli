import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { baseParse, NodeTypes } from '@vue/compiler-dom'

function templateAst(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { descriptor } = parseSfc(source)
  return baseParse(descriptor.template.content)
}

function hasClass(node, name) {
  return node.props?.some((prop) =>
    prop.type === NodeTypes.ATTRIBUTE &&
    prop.name === 'class' &&
    prop.value?.content.split(/\s+/).includes(name)
  )
}

function findElement(node, predicate) {
  if (node.type === NodeTypes.ELEMENT && predicate(node)) return node
  for (const child of node.children || []) {
    const match = findElement(child, predicate)
    if (match) return match
  }
  return null
}

function findElements(node, predicate, matches = []) {
  if (node.type === NodeTypes.ELEMENT && predicate(node)) matches.push(node)
  for (const child of node.children || []) findElements(child, predicate, matches)
  return matches
}

test('session workbench header exposes the compact Gateway control', () => {
  const sessionWorkbench = templateAst('../src/views/SessionDetail.vue')
  const sessionList = templateAst('../src/views/Workbench.vue')
  const header = findElement(sessionWorkbench, (node) => hasClass(node, 'detail-header'))

  assert.ok(header, 'session workbench must have its own header')
  assert.ok(
    findElement(header, (node) => node.tag === 'GatewayHeaderControl'),
    'Gateway control must be reachable from the /session workbench header'
  )
  assert.equal(
    findElement(sessionList, (node) => node.tag === 'GatewayHeaderControl'),
    null,
    'the session list must not masquerade as the workbench Gateway entry'
  )
})

test('header control contains only the global switch and phase/settings button', () => {
  const source = readFileSync(
    new URL('../src/components/gateway/GatewayHeaderControl.vue', import.meta.url),
    'utf8'
  )
  const ast = templateAst('../src/components/gateway/GatewayHeaderControl.vue')
  const switches = findElements(ast, (node) => node.tag === 'a-switch')
  const buttons = findElements(ast, (node) => node.tag === 'a-button')

  assert.equal(switches.length, 1, 'header must have exactly one global Gateway switch')
  assert.equal(buttons.length, 1, 'header must have exactly one phase/settings button')
  assert.ok(
    switches[0].props.some((prop) => prop.name === 'aria-label' && prop.value?.content.includes('Gateway')),
    'the sole switch must identify the global Gateway control'
  )
  assert.ok(
    buttons[0].children.some((child) =>
      child.type === NodeTypes.INTERPOLATION &&
      child.content.content === 'gatewayPhaseLabel(gateway.runtime.phase)'
    ),
    'the sole button must display the global runtime phase'
  )
  assert.equal(
    findElement(ast, (node) => node.tag === 'a-input' || node.tag === 'a-checkbox'),
    null,
    'header must not expose configuration fields or session relay selection controls'
  )
  assert.match(
    source,
    /router\.push\(\{ name: 'settings', query: \{ panel: 'gateway' \} \}\)/,
    'header phase button must open the Gateway settings panel'
  )
})
