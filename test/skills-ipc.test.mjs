import assert from 'node:assert/strict'
import test from 'node:test'

import { registerSkillsIpc } from '../electron/skills/ipc.js'

function registry() {
  const handlers = new Map()
  return {
    handlers,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler) } }
  }
}

test('Skills IPC registers the complete management surface', () => {
  const { handlers, ipcMain } = registry()
  registerSkillsIpc({ ipcMain, service: {} })
  assert.deepEqual([...handlers.keys()].sort(), [
    'skills:adopt',
    'skills:apply-cli-state-change',
    'skills:apply-to-adapter',
    'skills:check-updates',
    'skills:get-affected-sessions',
    'skills:get-state',
    'skills:inspect-source',
    'skills:install',
    'skills:install-many',
    'skills:preview-cli-state-change',
    'skills:preview-update',
    'skills:remove-installation',
    'skills:remove-package',
    'skills:resolve-cli-state-recovery',
    'skills:resolve-drift',
    'skills:restart-sessions',
    'skills:set-enabled',
    'skills:update'
  ])
})

test('Skills IPC accepts only a package id for guarded CLI-state recovery and sanitizes failures', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerSkillsIpc({
    ipcMain,
    service: {
      resolveCliStateRecovery(packageId) {
        calls.push(packageId)
        if (packageId === 'throws') throw Object.assign(new Error('recovery F:\\private\\journal'), { code: 'SKILL_PROJECTION_RECOVERY_REQUIRED', recoveryPath: 'F:\\private\\journal' })
        return { id: packageId }
      }
    }
  })

  assert.deepEqual(await handlers.get('skills:resolve-cli-state-recovery')({}, 'package-1'), { id: 'package-1' })
  await assert.rejects(
    handlers.get('skills:resolve-cli-state-recovery')({}, { packageId: 'package-2', targetPath: 'F:\\attacker' }),
    (error) => error.code === 'SKILL_IPC_INVALID'
  )
  const error = await handlers.get('skills:resolve-cli-state-recovery')({}, 'throws').then(() => null, (caught) => caught)
  assert.equal(error?.code, 'SKILL_PROJECTION_RECOVERY_REQUIRED')
  assert.equal(error?.recoveryPath, undefined)
  assert.equal(error?.message.includes('private'), false)
  assert.deepEqual(calls, ['package-1', 'throws'])
})

test('Skills IPC rebuilds bounded CLI state requests without renderer-controlled targets or provenance', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerSkillsIpc({
    ipcMain,
    service: {
      previewCliStateChange(request) { calls.push(request); return 'preview' },
      applyCliStateChange(request) { calls.push(request); return 'applied' }
    }
  })
  const request = {
    packageId: 'package-1', scopeType: 'project', scopeKey: 'F:\\demo',
    changes: [{ adapterId: 'codex', desiredState: 'disabled' }],
    targetPath: 'F:\\attacker', serverOrigin: 'https://attacker.invalid',
    organizationId: 'attacker-org', artifactSha256: 'f'.repeat(64)
  }

  assert.equal(await handlers.get('skills:preview-cli-state-change')({}, request), 'preview')
  assert.equal(await handlers.get('skills:apply-cli-state-change')({}, {
    ...request, expectedRevision: 'a'.repeat(64)
  }), 'applied')
  assert.deepEqual(calls, [
    {
      packageId: 'package-1', scopeType: 'project', scopeKey: 'F:\\demo',
      changes: [{ adapterId: 'codex', desiredState: 'disabled' }]
    },
    {
      packageId: 'package-1', scopeType: 'project', scopeKey: 'F:\\demo',
      changes: [{ adapterId: 'codex', desiredState: 'disabled' }],
      expectedRevision: 'a'.repeat(64)
    }
  ])
})

test('Skills IPC rejects invalid CLI state changes before invoking the service', async () => {
  const { handlers, ipcMain } = registry()
  let invoked = false
  registerSkillsIpc({ ipcMain, service: { previewCliStateChange() { invoked = true } } })
  const request = {
    packageId: 'package-1', scopeType: 'user', scopeKey: '*',
    changes: [{ adapterId: 'codex', desiredState: 'enabled' }]
  }

  for (const invalid of [
    { ...request, scopeKey: 'F:\\not-user' },
    { ...request, changes: [] },
    { ...request, changes: Array.from({ length: 6 }, () => ({ adapterId: 'codex', desiredState: 'enabled' })) },
    { ...request, changes: [{ adapterId: 'codex', desiredState: 'enabled' }, { adapterId: 'codex', desiredState: 'disabled' }] },
    { ...request, changes: [{ adapterId: 'unknown', desiredState: 'enabled' }] },
    { ...request, changes: [{ adapterId: 'codex', desiredState: 'toggle' }] }
  ]) {
    await assert.rejects(
      handlers.get('skills:preview-cli-state-change')({}, invalid),
      (error) => error.code === 'SKILL_IPC_INVALID'
    )
  }
  await assert.rejects(
    handlers.get('skills:apply-cli-state-change')({}, { ...request, expectedRevision: 'not-a-revision' }),
    (error) => error.code === 'SKILL_IPC_INVALID'
  )
  assert.equal(invoked, false)
})

test('Skills IPC exposes package removal and only the trusted state recovery action', async () => {
  const { handlers, ipcMain } = registry()
  const removed = []
  registerSkillsIpc({
    ipcMain,
    service: {
      removePackage(packageId) { removed.push(packageId); return true },
      applyCliStateChange() {
        throw Object.assign(new Error('Migration recovery is required'), {
          code: 'SKILL_PROJECTION_ROLLBACK_FAILED',
          recoveryAction: 'retry_apply_codex', recoveryPath: 'F:\\secret\\projection'
        })
      }
    }
  })

  assert.equal(await handlers.get('skills:remove-package')({}, 'package-1'), true)
  assert.deepEqual(removed, ['package-1'])
  const error = await handlers.get('skills:apply-cli-state-change')({}, {
    packageId: 'package-1', scopeType: 'user', scopeKey: '*',
    changes: [{ adapterId: 'codex', desiredState: 'disabled' }], expectedRevision: 'a'.repeat(64)
  }).then(() => null, (caught) => caught)
  assert.equal(error?.recoveryAction, 'retry_apply_codex')
  assert.equal(error?.recoveryPath, undefined)
})

test('Skills IPC validates apply-to-adapter ids before invoking the service', async () => {
  const { handlers, ipcMain } = registry()
  let invoked = false
  registerSkillsIpc({ ipcMain, service: { applyToAdapter() { invoked = true } } })

  await assert.rejects(
    handlers.get('skills:apply-to-adapter')({}, { packageId: 'package-1', targetAdapterId: 'unknown' }),
    (error) => error.code === 'SKILL_IPC_INVALID'
  )
  assert.equal(invoked, false)
})

test('Skills IPC forwards a valid apply-to-adapter request intact', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerSkillsIpc({
    ipcMain,
    service: {
      applyToAdapter(packageId, targetAdapterId) {
        calls.push([packageId, targetAdapterId])
        return 'applied'
      }
    }
  })

  const result = await handlers.get('skills:apply-to-adapter')({}, {
    packageId: 'package-1',
    targetAdapterId: 'ucode'
  })

  assert.equal(result, 'applied')
  assert.deepEqual(calls, [['package-1', 'ucode']])
})

test('Skills IPC preserves only the trusted migration recovery action', async () => {
  const { handlers, ipcMain } = registry()
  registerSkillsIpc({
    ipcMain,
    service: {
      applyToAdapter() {
        throw Object.assign(new Error('Migration recovery is required'), {
          code: 'SKILL_PROJECTION_ROLLBACK_FAILED',
          recoveryAction: 'retry_apply_codex',
          recoveryPath: 'F:\\secret\\projection'
        })
      }
    }
  })

  const error = await handlers.get('skills:apply-to-adapter')({}, {
    packageId: 'package-1', targetAdapterId: 'codex'
  }).then(() => null, (caught) => caught)
  assert.equal(error?.code, 'SKILL_PROJECTION_ROLLBACK_FAILED')
  assert.equal(error?.recoveryAction, 'retry_apply_codex')
  assert.equal(error?.recoveryPath, undefined)
})

test('Skills IPC allows DSH targets without forwarding renderer-controlled roots', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerSkillsIpc({
    ipcMain,
    service: {
      install(request) { calls.push(['install', request]); return 'installed' },
      applyToAdapter(packageId, adapterId) { calls.push(['apply', packageId, adapterId]); return 'applied' }
    }
  })

  await handlers.get('skills:install')({}, {
    source: { type: 'local', path: 'F:\\skills\\demo' },
    targetAdapterIds: ['deepseek-harness'],
    scopeType: 'user',
    root: 'F:\\attacker-root',
    targetPath: 'F:\\attacker-target',
    DSH_HOME: 'F:\\attacker-home'
  })
  await handlers.get('skills:apply-to-adapter')({}, {
    packageId: 'package-1', targetAdapterId: 'deepseek-harness', root: 'F:\\attacker-root'
  })

  assert.deepEqual(calls, [
    ['install', {
      source: { type: 'local', path: 'F:\\skills\\demo' },
      targetAdapterIds: ['deepseek-harness'], scopeType: 'user', projectPath: ''
    }],
    ['apply', 'package-1', 'deepseek-harness']
  ])
})

test('Skills IPC validates install scope before invoking the service', async () => {
  const { handlers, ipcMain } = registry()
  let invoked = false
  registerSkillsIpc({ ipcMain, service: { install() { invoked = true } } })
  await assert.rejects(
    handlers.get('skills:install')({}, {
      source: { type: 'local', path: 'F:\\skills\\demo' },
      targetAdapterIds: ['codex'],
      scopeType: 'project'
    }),
    (error) => error.code === 'SKILL_IPC_INVALID'
  )
  assert.equal(invoked, false)
})

test('Skills IPC validates and forwards install inspection context', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerSkillsIpc({
    ipcMain,
    service: {
      inspectSource(source, context) {
        calls.push([source, context])
        return 'preview'
      }
    }
  })
  const source = { type: 'local', path: 'F:\\skills\\demo' }
  const context = {
    targetAdapterIds: ['codex'],
    scopeType: 'project',
    projectPath: 'F:\\project'
  }

  const result = await handlers.get('skills:inspect-source')({}, source, context)

  assert.equal(result, 'preview')
  assert.deepEqual(calls, [[source, context]])
  await assert.rejects(
    handlers.get('skills:inspect-source')({}, source, {
      targetAdapterIds: ['unknown'],
      scopeType: 'user'
    }),
    (error) => error.code === 'SKILL_IPC_INVALID'
  )
})

test('Skills IPC validates and forwards a bounded batch install request', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerSkillsIpc({
    ipcMain,
    service: { installMany(requests) { calls.push(requests); return 'installed-many' } }
  })
  const request = (subdir) => ({
    source: {
      type: 'git', url: 'https://github.com/example/skills.git',
      refType: 'default', ref: '', subdir
    },
    expectedRevision: 'collection123',
    targetAdapterIds: ['codex'], scopeType: 'user'
  })

  const result = await handlers.get('skills:install-many')({}, [
    request('skills/first'), request('skills/second')
  ])

  assert.equal(result, 'installed-many')
  assert.deepEqual(calls[0].map((item) => item.source.subdir), ['skills/first', 'skills/second'])
  assert.deepEqual(calls[0].map((item) => item.expectedRevision), ['collection123', 'collection123'])
  await assert.rejects(
    handlers.get('skills:install-many')({}, []),
    (error) => error.code === 'SKILL_IPC_INVALID'
  )
})

test('Skills IPC forwards a generic Git source intact for hostname detection', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerSkillsIpc({
    ipcMain,
    service: {
      inspectSource(source) {
        calls.push(source)
        return 'preview'
      }
    }
  })

  const source = {
    type: 'git',
    url: 'https://gitlab.com/example/skills.git',
    refType: 'branch',
    ref: 'main',
    subdir: ''
  }
  const result = await handlers.get('skills:inspect-source')({}, source, {
    targetAdapterIds: ['codex'], scopeType: 'user'
  })

  assert.equal(result, 'preview')
  assert.deepEqual(calls, [source])
})

test('Skills IPC sanitizes unexpected errors and never exposes source credentials', async () => {
  const { handlers, ipcMain } = registry()
  registerSkillsIpc({
    ipcMain,
    service: {
      inspectSource() {
        throw new Error('clone failed for https://secret@github.com/example/private.git; PATH=C:\\private')
      }
    }
  })
  await assert.rejects(
    handlers.get('skills:inspect-source')({}, { type: 'github', url: 'https://secret@github.com/example/private.git' }),
    (error) => error.code === 'SKILL_OPERATION_FAILED' && !error.message.includes('secret') && !error.message.includes('PATH=')
  )
})
