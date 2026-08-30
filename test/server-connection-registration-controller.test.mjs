import assert from 'node:assert/strict'
import test from 'node:test'

import { createServerConnectionRegistrationController } from '../src/serverConnectionRegistrationController.js'

test('a loaded external registration attempt opens one root dialog and navigates safely to server settings', () => {
  let visible = false
  let navigation = null
  const controller = createServerConnectionRegistrationController({
    getAttempt: () => ({ attemptId: 'attempt-external', serverOrigin: 'https://server.example.test' }),
    setVisible: (value) => { visible = value },
    navigate: (target) => { navigation = target }
  })

  controller.presentCurrentAttempt()
  assert.equal(visible, true)
  assert.deepEqual(navigation, { name: 'settings', query: { section: 'server' } })
  assert.equal(JSON.stringify(navigation).includes('attempt-external'), false)
  assert.equal(JSON.stringify(navigation).includes('server.example.test'), false)
})
