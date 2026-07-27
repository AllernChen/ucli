import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const appPath = fileURLToPath(new URL('../src/App.vue', import.meta.url))
const sessionDetailPath = fileURLToPath(new URL('../src/views/SessionDetail.vue', import.meta.url))

test('route changes keep the workbench terminal component alive', async () => {
  const [appSource, detailSource] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(sessionDetailPath, 'utf8')
  ])

  assert.match(appSource, /<keep-alive\s+include="SessionDetail">/)
  assert.match(detailSource, /defineOptions\(\{\s*name:\s*'SessionDetail'\s*\}\)/)
  assert.match(detailSource, /\bonActivated\(/)
  assert.match(detailSource, /\bonDeactivated\(/)
})
