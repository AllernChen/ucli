import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import {
  isAllowedApplicationNavigation,
  isAllowedExternalUrl,
  openAllowedExternalUrl
} from '../electron/externalLinks.js'

test('allows absolute HTTP and HTTPS external URLs', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/path?source=terminal'), true)
  assert.equal(isAllowedExternalUrl('http://localhost:3000'), true)
})

test('rejects malformed and non-web external URLs', () => {
  assert.equal(isAllowedExternalUrl('file:///C:/secret.txt'), false)
  assert.equal(isAllowedExternalUrl('mailto:user@example.com'), false)
  assert.equal(isAllowedExternalUrl('not a url'), false)
})

test('does not invoke the external opener for a rejected URL', async () => {
  let calls = 0
  const openExternal = async () => { calls += 1 }
  const opened = await openAllowedExternalUrl('file:///C:/secret.txt', openExternal)
  const customProtocolOpened = await openAllowedExternalUrl('ucli://local-command', openExternal)

  assert.equal(opened, false)
  assert.equal(customProtocolOpened, false)
  assert.equal(calls, 0)
})

test('invokes the external opener for an allowed URL', async () => {
  let openedUrl = null
  const opened = await openAllowedExternalUrl('https://example.com', async (url) => { openedUrl = url })

  assert.equal(opened, true)
  assert.equal(openedUrl, 'https://example.com')
})

test('main window navigation stays on the current application document', () => {
  assert.equal(isAllowedApplicationNavigation(
    'file:///C:/UCLI/renderer/index.html#/stats',
    'file:///C:/UCLI/renderer/index.html#/stats?tab=summary'
  ), true)
  assert.equal(isAllowedApplicationNavigation(
    'http://localhost:5173/#/stats',
    'http://localhost:5173/#/session'
  ), true)
  assert.equal(isAllowedApplicationNavigation(
    'file:///C:/UCLI/renderer/index.html#/stats',
    'https://attacker.example/from-ai-markdown'
  ), false)
  assert.equal(isAllowedApplicationNavigation(
    'http://localhost:5173/#/stats',
    'http://localhost:5173/remote-document'
  ), false)
  assert.equal(isAllowedApplicationNavigation(
    'http://localhost:5173/#/stats',
    'http://user:password@localhost:5173/#/stats'
  ), false)

  const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
  assert.match(main, /webContents\.on\('will-navigate'/)
  assert.match(main, /event\.preventDefault\(\)/)
  assert.match(main, /isAllowedApplicationNavigation\(currentUrl, url\)/)
})
