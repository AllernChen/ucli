import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeSessionDetail } from '../src/sessionDetailStartup.js'

test('workbench restoration does not wait for optional profile inventory', async () => {
  let resolveProfiles
  const profileLoad = new Promise(resolve => { resolveProfiles = resolve })
  let workbenchLoads = 0

  const startup = initializeSessionDetail({
    sessions: {
      init: async () => {},
      loadWorkbench: async () => { workbenchLoads += 1 }
    },
    settings: { load: async () => {} },
    gateway: { init: async () => {} },
    aiProfiles: { load: () => profileLoad }
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workbenchLoads, 1)
  resolveProfiles()
  await startup
})

test('optional profile inventory failure does not reject workbench startup', async () => {
  let workbenchLoads = 0

  await initializeSessionDetail({
    sessions: {
      init: async () => {},
      loadWorkbench: async () => { workbenchLoads += 1 }
    },
    settings: { load: async () => {} },
    gateway: { init: async () => {} },
    aiProfiles: { load: async () => { throw new Error('PROFILE_OPERATION_FAILED') } }
  })

  assert.equal(workbenchLoads, 1)
})
