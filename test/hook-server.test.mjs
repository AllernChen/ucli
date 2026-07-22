import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

import { startHookServer } from '../electron/permission/hookServer.js'

function postJson(port, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/hook/pre-tool-use',
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(payload))
  })
}

test('permission hook server handles a request and closes cleanly', async () => {
  const server = await startHookServer()
  server.setHandler(async (payload) => ({ verdict: 'allow', reason: payload.tool }))

  const response = await postJson(server.port, { tool: 'Read' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { verdict: 'allow', reason: 'Read' })

  await server.close()
  await server.close()
})
