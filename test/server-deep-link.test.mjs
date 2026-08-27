import assert from 'node:assert/strict'
import test from 'node:test'

import { createDeepLinkReceiver } from '../electron/serverConnection/deepLink.js'

const valid = (secret = 'opaque-secret') => `ucli://connect?server=https%3A%2F%2Fserver.example.test#link=${secret}`

test('deep links wait for readiness and never expose the original URL to the consumer', async () => {
  const accepted = []
  const receiver = createDeepLinkReceiver({
    acceptConnection: async (connection) => accepted.push(connection)
  })

  assert.equal(receiver.acceptArgv(['ucli.exe', valid()]), true)
  assert.deepEqual(accepted, [])
  await receiver.setReady()
  assert.deepEqual(accepted, [{ serverOrigin: 'https://server.example.test', linkSecret: 'opaque-secret' }])
})

test('second-instance argv accepts exactly one valid connection URL', async () => {
  const accepted = []
  const receiver = createDeepLinkReceiver({ acceptConnection: async (connection) => accepted.push(connection), ready: true })

  assert.equal(receiver.acceptArgv(['ucli.exe', valid('one')]), true)
  assert.equal(receiver.acceptArgv(['ucli.exe', valid('two'), valid('three')]), false)
  assert.equal(receiver.acceptArgv(['ucli.exe', '--flag']), false)
  await receiver.flush()
  assert.deepEqual(accepted.map(({ linkSecret }) => linkSecret), ['one'])
})

test('macOS open-url links queue before ready and invalid URLs are ignored', async () => {
  const accepted = []
  const receiver = createDeepLinkReceiver({ acceptConnection: async (connection) => accepted.push(connection) })

  assert.equal(receiver.acceptOpenUrl(valid('mac-secret')), true)
  assert.equal(receiver.acceptOpenUrl('https://server.example.test/connect?link=query-secret#link=fragment-secret'), false)
  await receiver.setReady()
  assert.deepEqual(accepted.map(({ linkSecret }) => linkSecret), ['mac-secret'])
})
