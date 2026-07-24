import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOpenCodeSessionList } from '../electron/openCodeSessions.js'

test('OpenCode session list is filtered by Windows working directory', () => {
  const result = parseOpenCodeSessionList(JSON.stringify([
    {
      id: 'ses_old',
      title: 'Other project',
      created: 100,
      updated: 200,
      directory: 'F:\\projects\\other'
    },
    {
      id: 'ses_ucli',
      title: 'UCLI task',
      created: 300,
      updated: 400,
      directory: 'F:/projects/ucli/'
    }
  ]), 'F:\\projects\\ucli')

  assert.deepEqual(result, [{
    sessionId: 'ses_ucli',
    name: 'UCLI task',
    startedAt: 300,
    updatedAt: 400
  }])
})

test('OpenCode session discovery accepts empty CLI output', () => {
  assert.deepEqual(parseOpenCodeSessionList('', 'F:\\projects\\ucli'), [])
})
