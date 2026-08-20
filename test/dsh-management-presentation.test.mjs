import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDshManagementController,
  presentDshManagement
} from '../src/dshManagementPresentation.js'

const missing = Object.freeze({
  installed: false, compatible: false, version: '', health: 'missing'
})

function state(overrides = {}) {
  return {
    revision: 1,
    supportedVersion: '0.1.0-rc.6',
    managed: missing,
    system: missing,
    selected: null,
    action: 'install',
    busy: false,
    errorCode: null,
    ...overrides
  }
}

test('DSH management presents seven stable states with at most one fixed action', () => {
  const fixtures = [
    [state(), 'missing', '安装 DSH', 'installRuntime'],
    [state({
      managed: { installed: true, compatible: true, version: '0.1.0-rc.6', health: 'healthy' },
      selected: 'managed', action: 'remove'
    }), 'healthy', '已安装 0.1.0-rc.6', 'removeRuntime'],
    [state({
      managed: { installed: true, compatible: false, version: '0.1.0-rc.5', health: 'unhealthy' },
      action: 'upgrade'
    }), 'upgradeable', '升级到 0.1.0-rc.6', 'upgradeRuntime'],
    [state({
      managed: { installed: true, compatible: false, version: '0.1.0-rc.6', health: 'unhealthy' },
      action: 'repair'
    }), 'repairable', '修复安装', 'repairRuntime'],
    [state({
      managed: { installed: true, compatible: false, version: '9.9.9', health: 'unhealthy' },
      action: null
    }), 'unsupported', '版本不兼容', null],
    [state({ busy: true }), 'busy', '请先停止 DSH Web', null],
    [state({ errorCode: 'DSH_RUNTIME_ROLLBACK_FAILED', action: null }),
      'rollback-failed', '安装回滚失败', null]
  ]

  for (const [snapshot, status, label, method] of fixtures) {
    const view = presentDshManagement(snapshot)
    assert.equal(view.status, status)
    assert.equal(view.label, label)
    assert.equal(view.action?.method || null, method)
    assert.ok(view.action === null || Object.keys(view.action).sort().join(',') ===
      'confirm,confirmText,danger,label,method')
  }
})

test('DSH management exposes bounded managed and system rows without paths or raw errors', () => {
  const view = presentDshManagement(state({
    revision: 7,
    managed: {
      installed: true,
      compatible: true,
      version: '0.1.0-rc.6',
      health: 'healthy',
      path: 'C:\\Users\\private\\managed',
      error: 'spawn failed at C:\\Users\\private'
    },
    system: {
      installed: true,
      compatible: false,
      version: '0.0.9',
      health: 'unhealthy',
      command: 'C:\\secret\\dsh.cmd'
    },
    selected: 'managed',
    action: 'remove',
    rawError: 'token=secret'
  }))

  assert.equal(view.revision, 7)
  assert.equal(view.supportedVersion, '0.1.0-rc.6')
  assert.equal(view.selected, 'managed')
  assert.deepEqual(view.rows, [
    {
      source: 'managed', label: 'UCLI 管理', installed: true,
      compatible: true, version: '0.1.0-rc.6', health: 'healthy', selected: true
    },
    {
      source: 'system', label: '系统安装', installed: true,
      compatible: false, version: '0.0.9', health: 'unhealthy', selected: false
    }
  ])
  assert.doesNotMatch(JSON.stringify(view), /Users|private|secret|command|path|rawError|error/u)
})

test('DSH management never interpolates untrusted runtime versions into labels', () => {
  const upgrade = presentDshManagement(state({
    supportedVersion: 'C:\\private\\dsh.exe --token secret',
    action: 'upgrade'
  }))
  assert.equal(upgrade.label, '升级 DSH')
  assert.doesNotMatch(JSON.stringify(upgrade), /private|token|secret|dsh\.exe/u)

  const healthy = presentDshManagement(state({
    managed: {
      installed: true, compatible: true,
      version: 'C:\\private\\dsh.exe', health: 'healthy'
    },
    selected: 'managed',
    action: 'remove'
  }))
  assert.equal(healthy.label, '已安装')
  assert.doesNotMatch(JSON.stringify(healthy), /private|dsh\.exe/u)
})

test('runtime mutations use fixed zero-argument methods, refetch, and apply latest revision only', async () => {
  let actionArgumentCount = -1
  let reads = 0
  const controller = createDshManagementController({
    getState: async () => {
      reads += 1
      return state({ revision: reads, action: reads === 1 ? 'install' : null })
    },
    actions: {
      installRuntime(...args) {
        actionArgumentCount = args.length
      }
    }
  })

  await controller.mutate('installRuntime')
  assert.equal(actionArgumentCount, 0)
  assert.equal(reads, 1, 'every mutation refetches canonical state')
  assert.equal(controller.current().revision, 1)
  await assert.rejects(controller.mutate('runArbitraryCommand'), /DSH_ACTION_INVALID/)

  const pending = []
  const racing = createDshManagementController({
    getState: () => new Promise(resolve => pending.push(resolve)),
    actions: {}
  })
  const older = racing.refresh()
  const newer = racing.refresh()
  pending[1](state({ revision: 9 }))
  await newer
  pending[0](state({ revision: 8 }))
  await older
  assert.equal(racing.current().revision, 9)

  const mutationStartedEarlier = racing.refresh()
  const refreshStartedLater = racing.refresh()
  pending[3](state({ revision: 10 }))
  await refreshStartedLater
  pending[2](state({ revision: 11 }))
  await mutationStartedEarlier
  assert.equal(racing.current().revision, 11, 'canonical revision outranks request start order')
})

test('resolved runtime error states fail install, repair and remove after canonical refetch', async () => {
  const cases = [
    ['installRuntime', 'DSH_RUNTIME_INSTALL_FAILED'],
    ['repairRuntime', 'DSH_RUNTIME_INSTALL_FAILED'],
    ['removeRuntime', 'DSH_RUNTIME_REMOVE_FAILED']
  ]

  for (const [method, errorCode] of cases) {
    let reads = 0
    const canonicalRevision = cases.findIndex(item => item[0] === method) + 20
    const controller = createDshManagementController({
      getState: async () => {
        reads += 1
        return state({ revision: canonicalRevision, action: null })
      },
      actions: {
        [method]: async () => state({ revision: 999, errorCode, action: null })
      }
    })

    await assert.rejects(controller.mutate(method), /DSH_ACTION_FAILED/)
    assert.equal(reads, 1, `${method} still refetches canonical state`)
    assert.equal(controller.current().revision, canonicalRevision)
  }
})

test('resolved mutation error cannot make an older action result win over a newer canonical revision', async () => {
  let releaseAction
  let reads = 0
  const controller = createDshManagementController({
    getState: async () => state({ revision: ++reads === 1 ? 30 : 31, action: null }),
    actions: {
      repairRuntime: () => new Promise(resolve => {
        releaseAction = () => resolve(state({
          revision: 999,
          errorCode: 'DSH_RUNTIME_INSTALL_FAILED',
          action: null
        }))
      })
    }
  })

  const mutation = controller.mutate('repairRuntime')
  await controller.refresh()
  assert.equal(controller.current().revision, 30)
  releaseAction()
  await assert.rejects(mutation, /DSH_ACTION_FAILED/)
  assert.equal(controller.current().revision, 31)
})
