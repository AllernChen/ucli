const RUNTIME_ACTIONS = Object.freeze({
  install: Object.freeze({
    method: 'installRuntime',
    label: '安装 DSH',
    confirm: true,
    confirmText: '确认安装由 UCLI 管理的 DSH 运行时？',
    danger: false
  }),
  upgrade: Object.freeze({
    method: 'upgradeRuntime',
    label: '升级 DSH',
    confirm: true,
    confirmText: '确认升级由 UCLI 管理的 DSH 运行时？',
    danger: false
  }),
  repair: Object.freeze({
    method: 'repairRuntime',
    label: '修复安装',
    confirm: true,
    confirmText: '确认修复由 UCLI 管理的 DSH 运行时？',
    danger: false
  }),
  remove: Object.freeze({
    method: 'removeRuntime',
    label: '卸载 DSH',
    confirm: true,
    confirmText: '确认卸载由 UCLI 管理的 DSH 运行时？',
    danger: true
  })
})

const RUNTIME_METHODS = new Set([
  'installRuntime', 'upgradeRuntime', 'repairRuntime', 'removeRuntime'
])

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
const HEALTH_VALUES = new Set(['missing', 'healthy', 'unhealthy'])

function safeVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : ''
}

function runtimeRow(source, runtime, selected) {
  const value = runtime && typeof runtime === 'object' ? runtime : {}
  return {
    source,
    label: source === 'managed' ? 'UCLI 管理' : '系统安装',
    installed: value.installed === true,
    compatible: value.compatible === true,
    version: safeVersion(value.version),
    health: HEALTH_VALUES.has(value.health) ? value.health : 'missing',
    selected: selected === source
  }
}

function statusFor(snapshot) {
  if (snapshot?.errorCode === 'DSH_RUNTIME_ROLLBACK_FAILED') {
    return ['rollback-failed', '安装回滚失败']
  }
  if (snapshot?.busy) return ['busy', '请先停止 DSH Web']
  if (snapshot?.action === 'upgrade') {
    const version = safeVersion(snapshot.supportedVersion)
    return ['upgradeable', version ? `升级到 ${version}` : '升级 DSH']
  }
  if (snapshot?.action === 'repair') return ['repairable', '修复安装']
  if (snapshot?.managed?.installed && snapshot.managed.compatible &&
      snapshot.managed.health === 'healthy') {
    const version = safeVersion(snapshot.managed.version)
    return ['healthy', version ? `已安装 ${version}` : '已安装']
  }
  if (snapshot?.action === 'install') return ['missing', '安装 DSH']
  return ['unsupported', '版本不兼容']
}

export function presentDshManagement(snapshot) {
  const [status, label] = statusFor(snapshot)
  const action = status === 'busy' || status === 'rollback-failed' || status === 'unsupported'
    ? null
    : RUNTIME_ACTIONS[snapshot?.action] || null

  const selected = snapshot?.selected === 'managed' || snapshot?.selected === 'system'
    ? snapshot.selected
    : null
  return {
    revision: Number.isSafeInteger(snapshot?.revision) && snapshot.revision >= 0
      ? snapshot.revision
      : 0,
    supportedVersion: safeVersion(snapshot?.supportedVersion),
    selected,
    status,
    label,
    action,
    rows: [
      runtimeRow('managed', snapshot?.managed, selected),
      runtimeRow('system', snapshot?.system, selected)
    ]
  }
}

export function createDshManagementController({ getState, actions = {}, onState = () => {} }) {
  if (typeof getState !== 'function') throw new Error('DSH_STATE_READER_INVALID')

  let requestRevision = 0
  let currentView = presentDshManagement(null)

  function accept(request, snapshot) {
    const next = presentDshManagement(snapshot)
    if (next.revision < currentView.revision ||
        (next.revision === currentView.revision && request !== requestRevision)) return currentView
    currentView = next
    onState(currentView)
    return currentView
  }

  async function readFor(request) {
    try {
      return accept(request, await getState())
    } catch {
      throw new Error('DSH_STATE_UNAVAILABLE')
    }
  }

  return Object.freeze({
    current: () => currentView,
    async refresh() {
      const request = ++requestRevision
      return readFor(request)
    },
    async mutate(method) {
      if (!RUNTIME_METHODS.has(method) || typeof actions[method] !== 'function') {
        throw new Error('DSH_ACTION_INVALID')
      }
      const request = ++requestRevision
      let mutationFailed = false
      try {
        const actionState = await actions[method]()
        mutationFailed = actionState?.errorCode != null ||
          actionState?.state?.errorCode != null ||
          actionState?.ok === false
      } catch {
        mutationFailed = true
      }

      let result
      try {
        result = await readFor(request)
      } catch {
        if (mutationFailed) throw new Error('DSH_ACTION_FAILED')
        throw new Error('DSH_STATE_UNAVAILABLE')
      }
      if (mutationFailed) throw new Error('DSH_ACTION_FAILED')
      return result
    }
  })
}
