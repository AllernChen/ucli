import assert from 'node:assert/strict'
import test from 'node:test'

import { isProxy, reactive } from 'vue'
import { buildSkillInstallRequest } from '../src/skillsPresentation.js'

test('manual install request converts reactive targets into cloneable plain data', () => {
  const draft = reactive({
    targets: ['claude', 'codex', 'opencode', 'ucode'],
    scopeType: 'user',
    projectPath: ''
  })

  const request = buildSkillInstallRequest({
    source: { type: 'local', path: 'F:\\skills\\demo.zip' },
    targetAdapterIds: draft.targets,
    scopeType: draft.scopeType,
    projectPath: draft.projectPath
  })

  assert.equal(isProxy(draft.targets), true)
  assert.equal(isProxy(request.targetAdapterIds), false)
  assert.deepEqual(structuredClone(request), {
    source: { type: 'local', path: 'F:\\skills\\demo.zip' },
    targetAdapterIds: ['claude', 'codex', 'opencode', 'ucode'],
    scopeType: 'user',
    projectPath: ''
  })
})
