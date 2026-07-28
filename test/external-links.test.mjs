import assert from 'node:assert/strict'
import test from 'node:test'

import { isAllowedExternalUrl, openAllowedExternalUrl } from '../electron/externalLinks.js'

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
  const opened = await openAllowedExternalUrl('file:///C:/secret.txt', async () => { calls += 1 })

  assert.equal(opened, false)
  assert.equal(calls, 0)
})

test('invokes the external opener for an allowed URL', async () => {
  let openedUrl = null
  const opened = await openAllowedExternalUrl('https://example.com', async (url) => { openedUrl = url })

  assert.equal(opened, true)
  assert.equal(openedUrl, 'https://example.com')
})
