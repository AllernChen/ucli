import assert from 'node:assert/strict'
import test from 'node:test'

import { selectSummaryExecution } from '../src/summaryExecutionSelection.js'

const claude = {
  id: 'claude',
  installed: true,
  safeForSummary: true,
  summaryExecutorAvailable: false
}
const managedBearer = {
  id: 'profile-mimo',
  adapterId: 'claude',
  kind: 'managed',
  status: 'ready',
  connectionMode: 'bearer'
}

test('missing global defaults fall back to a usable managed summary profile', () => {
  assert.deepEqual(selectSummaryExecution({
    settings: {},
    tools: [claude],
    profiles: [managedBearer]
  }), {
    useDefaults: false,
    executorId: 'claude',
    profileId: 'profile-mimo',
    model: null
  })
})

test('unusable global defaults fall back while usable defaults remain selected', () => {
  assert.deepEqual(selectSummaryExecution({
    settings: { defaultExecutorId: 'codex', defaultProfileId: null, defaultModel: 'old' },
    tools: [
      { id: 'codex', installed: true, safeForSummary: false, summaryExecutorAvailable: false },
      claude
    ],
    profiles: [managedBearer]
  }), {
    useDefaults: false,
    executorId: 'claude',
    profileId: 'profile-mimo',
    model: null
  })

  assert.deepEqual(selectSummaryExecution({
    settings: {
      defaultExecutorId: 'claude',
      defaultProfileId: 'profile-mimo',
      defaultModel: 'mimo-v2.5-pro'
    },
    tools: [claude],
    profiles: [managedBearer]
  }), {
    useDefaults: true,
    executorId: 'claude',
    profileId: 'profile-mimo',
    model: 'mimo-v2.5-pro'
  })
})
