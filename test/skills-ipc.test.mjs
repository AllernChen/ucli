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
