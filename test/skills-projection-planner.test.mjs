import assert from 'node:assert/strict'
import test from 'node:test'

import { listSkillProjectionCapabilities } from '../electron/skills/adapters.js'
import {
  planSkillCliStateChange,
  projectionStateRevision
} from '../electron/skills/projectionPlanner.js'

const ADAPTER_IDS = ['claude', 'codex', 'opencode', 'ucode', 'deepseek-harness']

function capabilities() {
  return listSkillProjectionCapabilities({
    scopeType: 'project', projectPath: 'F:\\fixtures\\project', home: 'F:\\fixtures\\home', env: {}
  })
}

function snapshot(overrides = {}) {
  return {
    package: { id: 'package-1', contentSha256: 'a'.repeat(64) },
    scope: { type: 'project', key: 'project-1' },
    compatibility: Object.fromEntries(ADAPTER_IDS.map((adapterId) => [adapterId, { compatible: true }])),
    capabilities: capabilities(),
    installations: [],
    desiredStates: [],
    ...overrides
  }
}

function direct(adapterId, overrides = {}) {
  return {
    id: `installation-${adapterId}`,
    targetAdapterId: adapterId,
    enabled: true,
    status: 'ready',
    deployedSha256: 'a'.repeat(64),
    targetPath: `F:\\irrelevant\\${adapterId}`,
    updatedAt: 100,
    ...overrides
  }
}

function desired(adapterId, desiredState, overrides = {}) {
  return {
    adapterId,
    desiredState,
    enforcementStatus: 'satisfied',
    reasonCode: null,
    updatedAt: 100,
    ...overrides
  }
}

test('projection capabilities expose existing coverage but do not claim untested inherited exclusions', () => {
  const entries = capabilities()

  assert.deepEqual(entries.map(({ adapterId, covers, canExcludeInherited, isolationReasonCode }) => ({
    adapterId, covers, canExcludeInherited, isolationReasonCode
  })), [
    { adapterId: 'claude', covers: ['claude', 'opencode', 'ucode'], canExcludeInherited: false, isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED' },
    { adapterId: 'codex', covers: ['codex', 'opencode', 'ucode', 'deepseek-harness'], canExcludeInherited: false, isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED' },
    { adapterId: 'opencode', covers: ['opencode', 'ucode'], canExcludeInherited: false, isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED' },
    { adapterId: 'ucode', covers: ['ucode'], canExcludeInherited: false, isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED' },
    { adapterId: 'deepseek-harness', covers: ['deepseek-harness'], canExcludeInherited: false, isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED' }
  ])
})

test('plans strict CLI state changes from trusted snapshots', () => {
  const cases = [
    {
      name: 'direct enable creates a direct projection and records the explicit intent',
      state: snapshot(),
      changes: [{ adapterId: 'opencode', desiredState: 'enabled' }],
      classification: 'direct',
      steps: [['ensure_direct', 'opencode'], ['set_desired', 'opencode', 'enabled']]
    },
    {
      name: 'direct disable removes a direct projection and records the explicit intent',
      state: snapshot({
        installations: [direct('opencode')],
        desiredStates: [desired('opencode', 'enabled'), desired('ucode', 'inherit')]
      }),
      changes: [{ adapterId: 'opencode', desiredState: 'disabled' }],
      classification: 'direct',
      steps: [['disable_direct', 'opencode'], ['set_desired', 'opencode', 'disabled']]
    },
    {
      name: 'provider disable creates a direct projection for an enabled consumer before disabling the provider',
      state: snapshot({
        installations: [direct('codex')],
        desiredStates: [
          desired('codex', 'enabled'), desired('opencode', 'enabled'),
          desired('ucode', 'inherit'), desired('deepseek-harness', 'inherit')
        ]
      }),
      changes: [{ adapterId: 'codex', desiredState: 'disabled' }],
      classification: 'migration_required',
      steps: [
        ['ensure_direct', 'opencode'],
        ['disable_direct', 'codex'],
        ['set_desired', 'codex', 'disabled']
      ]
    },
    {
      name: 'provider and consumer disable removes the provider without creating a replacement',
      state: snapshot({
        installations: [direct('codex')],
        desiredStates: [
          desired('codex', 'enabled'), desired('opencode', 'enabled'),
          desired('ucode', 'inherit'), desired('deepseek-harness', 'inherit')
        ]
      }),
      changes: [
        { adapterId: 'codex', desiredState: 'disabled' },
        { adapterId: 'opencode', desiredState: 'disabled' }
      ],
      classification: 'direct',
      steps: [
        ['disable_direct', 'codex'],
        ['set_desired', 'codex', 'disabled'],
        ['set_desired', 'opencode', 'disabled']
      ]
    },
    {
      name: 'inherited consumer disable remains blocked while its provider stays enabled',
      state: snapshot({
        installations: [direct('codex')],
        desiredStates: [
          desired('codex', 'enabled'), desired('opencode', 'inherit'),
          desired('ucode', 'inherit'), desired('deepseek-harness', 'inherit')
        ]
      }),
      changes: [{ adapterId: 'opencode', desiredState: 'disabled' }],
      classification: 'blocked',
      reasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED',
      steps: []
    },
    {
      name: 'an already satisfied direct state is a noop',
      state: snapshot({
        installations: [direct('codex')],
        desiredStates: [
          desired('codex', 'enabled'), desired('opencode', 'inherit'),
          desired('ucode', 'inherit'), desired('deepseek-harness', 'inherit')
        ]
      }),
      changes: [{ adapterId: 'codex', desiredState: 'enabled' }],
      classification: 'noop',
      steps: []
    },
    {
      name: 'an incompatible target is blocked before planning writes',
      state: snapshot({
        compatibility: {
          ...snapshot().compatibility,
          opencode: { compatible: false }
        }
      }),
      changes: [{ adapterId: 'opencode', desiredState: 'enabled' }],
      classification: 'blocked',
      reasonCode: 'SKILL_INCOMPATIBLE',
      steps: []
    },
    {
      name: 'a drifted projection blocks the requested state change',
      state: snapshot({
        installations: [direct('codex', { status: 'drifted' })],
        desiredStates: [desired('codex', 'enabled')]
      }),
      changes: [{ adapterId: 'codex', desiredState: 'disabled' }],
      classification: 'blocked',
      reasonCode: 'SKILL_DRIFTED',
      steps: []
    },
    {
      name: 'a recovery-required desired state blocks destructive planning',
      state: snapshot({
        installations: [direct('codex')],
        desiredStates: [desired('codex', 'enabled', { enforcementStatus: 'recovery_required' })]
      }),
      changes: [{ adapterId: 'codex', desiredState: 'disabled' }],
      classification: 'blocked',
      reasonCode: 'SKILL_PROJECTION_RECOVERY_REQUIRED',
      steps: []
    }
  ]

  for (const item of cases) {
    const plan = planSkillCliStateChange(item.state, item.changes)
    assert.equal(plan.classification, item.classification, item.name)
    assert.equal(plan.reasonCode, item.reasonCode || null, item.name)
    assert.deepEqual(plan.steps.map(({ type, adapterId, desiredState }) => [type, adapterId, desiredState].filter((value) => value !== undefined)), item.steps, item.name)
    assert.equal(plan.revision, projectionStateRevision(item.state), item.name)
  }
})

test('incomplete desired-state coverage blocks provider disable before an inherited consumer can be lost', () => {
  const plan = planSkillCliStateChange(snapshot({
    installations: [direct('codex')],
    desiredStates: [desired('codex', 'enabled')]
  }), [{ adapterId: 'codex', desiredState: 'disabled' }])

  assert.equal(plan.classification, 'blocked')
  assert.equal(plan.reasonCode, 'SKILL_CLI_DESIRED_STATE_INVALID')
  assert.deepEqual(plan.steps, [])
})

test('projection planner rejects forged capability contracts instead of trusting caller claims', () => {
  const base = snapshot()
  const invalidCapabilities = [
    {
      name: 'unknown adapter',
      state: snapshot({
        compatibility: { ...base.compatibility, untrusted: { compatible: true } },
        capabilities: [...base.capabilities, {
          adapterId: 'untrusted', directRoot: 'F:\\untrusted', covers: ['untrusted'],
          canExcludeInherited: false, isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED'
        }]
      })
    },
    {
      name: 'mismatched coverage',
      state: snapshot({
        capabilities: base.capabilities.map((item) => item.adapterId === 'codex'
          ? { ...item, covers: ['codex'] }
          : item)
      })
    },
    {
      name: 'forged inherited exclusion',
      state: snapshot({
        capabilities: base.capabilities.map((item) => item.adapterId === 'opencode'
          ? { ...item, canExcludeInherited: true, isolationReasonCode: null }
          : item)
      })
    }
  ]

  for (const item of invalidCapabilities) {
    assert.throws(() => projectionStateRevision(item.state), {
      code: 'SKILL_PROJECTION_PLAN_INVALID'
    }, item.name)
  }
})

test('projection revisions include trusted semantic state and exclude timestamps and paths', () => {
  const original = snapshot({
    installations: [direct('codex')],
    desiredStates: [desired('codex', 'enabled')]
  })
  const nonSemanticChanges = snapshot({
    ...original,
    capabilities: original.capabilities.map((item) => ({ ...item, directRoot: `F:\\other\\${item.adapterId}` })),
    installations: [direct('codex', { targetPath: 'F:\\other\\codex', updatedAt: 200 })],
    desiredStates: [desired('codex', 'enabled', { updatedAt: 200 })]
  })
  const semanticChange = snapshot({
    ...original,
    desiredStates: [desired('codex', 'disabled')]
  })

  assert.equal(projectionStateRevision(nonSemanticChanges), projectionStateRevision(original))
  assert.notEqual(projectionStateRevision(semanticChange), projectionStateRevision(original))
})
