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

test('header control contains only global switch, phase status, and settings navigation', () => {
  const source = readFileSync(
    new URL('../src/components/gateway/GatewayHeaderControl.vue', import.meta.url),
    'utf8'
  )
  assert.match(source, /aria-label="Gateway 总开关"/)
  assert.match(source, /gatewayPhaseLabel/)
  assert.match(source, /name: 'settings'.*panel: 'gateway'/s)
  assert.doesNotMatch(source, /App ID|App Secret|operatorOpenIds|relayEnabled/)
})
