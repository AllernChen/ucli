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

test('OpenCode session discovery normalizes Chinese Windows paths and rejects malformed output', () => {
  const result = parseOpenCodeSessionList(JSON.stringify([{
    id: 'ses_chinese', title: '中文目录', created: '2026-07-24T12:00:00Z', updated: '2026-07-24T13:00:00Z',
    directory: 'f:/Projects/示例项目\\'
  }]), 'F:\\PROJECTS\\示例项目\\')

  assert.equal(result[0].sessionId, 'ses_chinese')
  assert.deepEqual(parseOpenCodeSessionList('{not json}', 'F:\\projects\\ucli'), [])
})

test('OpenCode session discovery keeps the 30 most recently updated sessions', () => {
  const source = Array.from({ length: 35 }, (_, index) => ({
    id: `ses_${index}`,
    title: `Session ${index}`,
    created: index,
    updated: index,
    directory: 'F:/projects/ucli'
  }))

  const result = parseOpenCodeSessionList(JSON.stringify(source), 'F:\\projects\\ucli')
  assert.equal(result.length, 30)
  assert.equal(result[0].sessionId, 'ses_34')
  assert.equal(result.at(-1).sessionId, 'ses_5')
})
