import assert from 'node:assert/strict'
import test from 'node:test'

import { RegistrationAttemptStore } from '../electron/serverConnection/registrationAttempts.js'

const origin = 'http://10.44.100.100'
const secret = 'one-time-link-secret'

test('registration attempts expose a renderer-safe DTO without the link secret', () => {
  const store = new RegistrationAttemptStore({ now: () => 100 })

  const created = store.create({ serverOrigin: origin, linkSecret: secret })

  assert.match(created.attemptId, /^[0-9a-f-]{36}$/i)
  assert.equal(created.serverOrigin, origin)
  assert.equal(created.preview, null)
  assert.equal(store.getSecret(created.attemptId), secret)
  assert.equal(JSON.stringify(created).includes(secret), false)
  assert.equal(JSON.stringify(store.getPublic(created.attemptId)).includes(secret), false)
})

test('registration attempts remove the secret after fifteen minutes', () => {
  let clock = 0
  const store = new RegistrationAttemptStore({ now: () => clock })
  const { attemptId } = store.create({ serverOrigin: origin, linkSecret: secret })

  clock = 15 * 60_000
  store.sweep()

  assert.equal(store.getPublic(attemptId), null)
  assert.equal(store.getSecret(attemptId), null)
})

test('registration attempts allow only one redeem to begin at a time', () => {
  const store = new RegistrationAttemptStore()
  const { attemptId } = store.create({ serverOrigin: origin, linkSecret: secret })

  assert.equal(store.beginRedeem(attemptId), true)
  assert.equal(store.beginRedeem(attemptId), false)
})

test('registration attempts recover only the ambiguous redeem for the same attempt within ten minutes', () => {
  let clock = 0
  const store = new RegistrationAttemptStore({ now: () => clock })
  const { attemptId } = store.create({ serverOrigin: origin, linkSecret: secret })
  assert.equal(store.beginRedeem(attemptId), true)
  assert.equal(store.markRedeemAmbiguous(attemptId), true)

  clock = 10 * 60_000 - 1
  assert.equal(store.beginRedeem(attemptId), true)
  assert.equal(store.beginRedeem('other-attempt'), false)
})

test('registration attempts discard an ambiguous redeem after its ten-minute recovery window', () => {
  let clock = 0
  const store = new RegistrationAttemptStore({ now: () => clock })
  const { attemptId } = store.create({ serverOrigin: origin, linkSecret: secret })
  assert.equal(store.beginRedeem(attemptId), true)
  assert.equal(store.markRedeemAmbiguous(attemptId), true)

  clock = 10 * 60_000
  assert.equal(store.beginRedeem(attemptId), false)
  assert.equal(store.getSecret(attemptId), null)
})

test('registration attempts do not chain a second ambiguous redeem recovery', () => {
  const store = new RegistrationAttemptStore()
  const { attemptId } = store.create({ serverOrigin: origin, linkSecret: secret })
  assert.equal(store.beginRedeem(attemptId), true)
  assert.equal(store.markRedeemAmbiguous(attemptId), true)
  assert.equal(store.beginRedeem(attemptId), true)

  assert.equal(store.markRedeemAmbiguous(attemptId), false)
  assert.equal(store.getSecret(attemptId), null)
})

test('finishing or cancelling an attempt removes its in-memory secret', () => {
  const store = new RegistrationAttemptStore()
  const finished = store.create({ serverOrigin: origin, linkSecret: secret }).attemptId
  const cancelled = store.create({ serverOrigin: origin, linkSecret: secret }).attemptId

  assert.equal(store.finish(finished), true)
  assert.equal(store.cancel(cancelled), true)
  assert.equal(store.getSecret(finished), null)
  assert.equal(store.getSecret(cancelled), null)
})
