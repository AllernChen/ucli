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
    'skills:apply-to-adapter',
    'skills:check-updates',
    'skills:get-affected-sessions',
    'skills:get-state',
    'skills:inspect-source',
    'skills:install',
    'skills:preview-update',
    'skills:remove-installation',
    'skills:resolve-drift',
    'skills:restart-sessions',
    'skills:set-enabled',
    'skills:update'
  ])
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
