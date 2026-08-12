import assert from 'node:assert/strict'
import test from 'node:test'

import config from '../electron.vite.config.mjs'

function matchesExternal(external, dependency) {
  return external.some((matcher) => {
    if (typeof matcher === 'string') return matcher === dependency
    if (matcher instanceof RegExp) return matcher.test(dependency)
    if (typeof matcher === 'function') return matcher(dependency)
    return false
  })
}

test('the CommonJS main bundle includes ESM-only parse5 instead of externalizing it', () => {
  const resolved = {}
  const plugin = config.main.plugins.find((candidate) => candidate.name === 'vite:externalize-deps')

  assert.ok(plugin, 'main build must apply dependency externalization policy')
  plugin.config(resolved)

  const external = resolved.build.rollupOptions.external
  assert.equal(matchesExternal(external, 'parse5'), false)
})
