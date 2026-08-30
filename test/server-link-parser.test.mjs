import assert from 'node:assert/strict'
import test from 'node:test'

import { parseConnectionInput } from '../electron/serverConnection/linkParser.js'

test('parseConnectionInput accepts the two documented connection URL forms without changing the opaque secret', () => {
  const secret = 'Opaque-Case-Sensitive_%2F-Value'
  for (const [input, serverOrigin] of [
    [`http://10.44.100.100/connect#link=${secret}`, 'http://10.44.100.100'],
    [`ucli://connect?server=http%3A%2F%2F10.44.100.100#link=${secret}`, 'http://10.44.100.100'],
    [`ucli://connect/?server=http%3A%2F%2F10.44.100.100#link=${secret}`, 'http://10.44.100.100'],
    [`https://server.fixture.test/connect#link=${secret}`, 'https://server.fixture.test']
  ]) {
    assert.deepEqual(parseConnectionInput(input), {
      serverOrigin,
      linkSecret: secret
    })
  }
})

test('parseConnectionInput rejects connection URLs outside the strict secret boundary', () => {
  const invalidInputs = [
    '',
    'http://server.fixture.test/connect#link=',
    'http://server.fixture.test/connect#link=one&link=two',
    'http://server.fixture.test/connect#link=one&extra=two',
    'http://server.fixture.test/connect#token=old-token',
    'http://server.fixture.test/connect?link=query-secret#link=fragment-secret',
    'http://server.fixture.test/connect?token=query-token#link=fragment-secret',
    'http://attacker.example/connect#link=secret',
    'http://user:password@server.fixture.test/connect#link=secret',
    'ucli://user:password@connect?server=http%3A%2F%2Fserver.fixture.test#link=secret',
    'http://server.fixture.test/not-connect#link=secret',
    'ucli://not-connect?server=http%3A%2F%2Fserver.fixture.test#link=secret',
    'ucli://connect?server=http%3A%2F%2Fserver.fixture.test%2Fpath#link=secret',
    'ucli://connect?server=http%3A%2F%2Fserver.fixture.test%3Fquery%3Dvalue#link=secret',
    'ucli://connect?server=http%3A%2F%2Fserver.fixture.test%23fragment#link=secret',
    'ucli://connect?server=http%3A%2F%2Fserver.fixture.test%2F#link=secret',
    'ucli://connect?server=http%3A%2F%2Fattacker.example#link=secret',
    'ucli://connect?server=ftp%3A%2F%2Fserver.fixture.test#link=secret',
    'ftp://server.fixture.test/connect#link=secret'
  ]

  for (const input of invalidInputs) {
    assert.throws(() => parseConnectionInput(input), error => error?.code === 'CONNECTION_LINK_INVALID')
  }
})
