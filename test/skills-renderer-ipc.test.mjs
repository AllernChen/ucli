import assert from 'node:assert/strict'
import test from 'node:test'

test('renderer Skills API forwards management requests through the preload bridge', async () => {
  const calls = []
  globalThis.window = {
    ucli: new Proxy({}, {
      get(_target, name) {
        return (...args) => {
          calls.push([name, ...args])
          return name
        }
      }
    })
  }
  try {
    const { ipc } = await import(`../src/ipc.js?skills=${Date.now()}`)
    assert.equal(ipc.getSkillsState({ projectPath: 'F:\\demo' }), 'getSkillsState')
    assert.equal(ipc.installSkill({ scopeType: 'user' }), 'installSkill')
    assert.equal(ipc.setSkillEnabled('install-1', false), 'setSkillEnabled')
    assert.equal(ipc.resolveSkillDrift('install-1', 'restore'), 'resolveSkillDrift')
    assert.equal(ipc.pickSkillArchive(), 'pickSkillArchive')
    assert.deepEqual(calls, [
      ['getSkillsState', { projectPath: 'F:\\demo' }],
      ['installSkill', { scopeType: 'user' }],
      ['setSkillEnabled', 'install-1', false],
      ['resolveSkillDrift', 'install-1', 'restore'],
      ['pickSkillArchive']
    ])
  } finally {
    delete globalThis.window
  }
})
