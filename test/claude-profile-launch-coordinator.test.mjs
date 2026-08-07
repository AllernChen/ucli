import assert from 'node:assert/strict'
import test from 'node:test'

import {
  armClaudeProfileLaunch,
  claudeProfileLaunchStamp
} from '../electron/aiCliProfiles/claudeLaunchCoordinator.js'

function entryWith(stamp) {
  const calls = []
  return {
    calls,
    entry: {
      session: {
        adapterId: 'claude',
        profileId: stamp.profileId,
        profileRuntimeRevision: stamp.runtimeRevision
      },
      adapter: {
        setProfileLaunch(value) { calls.push(value) }
      },
      status: 'starting',
      _claudeProfileLaunchStamp: stamp
    }
  }
}

test('Claude launch coordinator reuses the compiled launch when profile stamp is unchanged', () => {
  const stamp = { profileId: 'profile-1', runtimeRevision: 101 }
  const { entry, calls } = entryWith(stamp)
  let prepareCount = 0

  const refreshed = armClaudeProfileLaunch({
    entry,
    desiredStamp: stamp,
    prepareRuntime() {
      prepareCount += 1
      throw new Error('must not decrypt again')
    }
  })

  assert.equal(refreshed, false)
  assert.equal(prepareCount, 0)
  assert.deepEqual(calls, [])
  assert.equal(entry.session.activeProfileId, 'profile-1')
  assert.equal(entry.status, 'launching')
})

test('Claude launch coordinator recompiles exactly once when profile or revision changes', () => {
  const { entry, calls } = entryWith({ profileId: 'profile-1', runtimeRevision: 101 })
  let prepareCount = 0

  const refreshed = armClaudeProfileLaunch({
    entry,
    desiredStamp: { profileId: 'profile-2', runtimeRevision: 202 },
    prepareRuntime() {
      prepareCount += 1
      return {
        session: {
          ...entry.session,
          profileId: 'profile-2',
          profileRuntimeRevision: 202
        },
        profileLaunch: {
          args: ['--model', 'sonnet'],
          env: {},
          settingSources: ['project', 'local']
        }
      }
    }
  })

  assert.equal(refreshed, true)
  assert.equal(prepareCount, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].settingSources, ['project', 'local'])
  assert.deepEqual(entry._claudeProfileLaunchStamp, claudeProfileLaunchStamp(entry.session))
  assert.equal(entry.session.activeProfileId, 'profile-2')
})
