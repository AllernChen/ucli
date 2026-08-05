import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

const ORIGINAL_ID = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
const CURRENT_ID = '019fcac6-0c62-7da1-92ff-454e53dab197'

const repairCalls = []
globalThis.window = {
  ucli: {
    repairSessionBinding: async (sessionId) => {
      repairCalls.push(sessionId)
      return {
        changed: true,
        diagnostic: {
          sessionId,
          resolvedNativeSessionId: CURRENT_ID,
          bindingState: 'current'
        }
      }
    },
    getSessionDiagnostics: async () => ({ bindingState: 'current' })
  }
}

const { useSessionsStore } = await import('../src/stores/sessions.js?session-binding-store')

function createStore() {
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store.sessions.push({
    id: 'ucli-session',
    adapterId: 'codex',
    cliSessionId: ORIGINAL_ID,
    stats: { tokens: { input: 0, output: 0 } }
  })
  return store
}

test('native Codex /resume replaces an existing renderer binding on init', () => {
  const store = createStore()

  store._onEvent({
    sessionId: 'ucli-session',
    type: 'init',
    cliSessionId: CURRENT_ID,
    ts: 1
  })

  assert.equal(store.byId('ucli-session').cliSessionId, CURRENT_ID)
})

test('one-click repair applies the persisted resolved binding to the session summary', async () => {
  repairCalls.length = 0
  const store = createStore()

  const result = await store.repairBinding('ucli-session')

  assert.equal(result.changed, true)
  assert.equal(store.byId('ucli-session').cliSessionId, CURRENT_ID)
  assert.deepEqual(repairCalls, ['ucli-session'])
})
