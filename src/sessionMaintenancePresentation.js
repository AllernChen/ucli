const ACTIVE_STATUSES = new Set(['running', 'idle', 'waiting', 'starting'])
const INTERRUPTIBLE_STATUSES = new Set(['running', 'idle', 'waiting'])

export function deriveSessionCapabilityState(session = {}) {
  const capabilities = session.capabilities
  const validShape = Boolean(
    capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) &&
    ['terminal', 'web'].includes(capabilities.surface) &&
    ['ucli', 'native'].includes(capabilities.permissionOwner) &&
    ['ucli', 'native'].includes(capabilities.historyOwner) &&
    ['ucli', 'native'].includes(capabilities.statsOwner) &&
    typeof capabilities.gateway === 'boolean' &&
    typeof capabilities.bridge === 'boolean'
  )
  const coherentOwnership = validShape && (
    capabilities.surface === 'terminal'
      ? capabilities.permissionOwner === 'ucli' && capabilities.historyOwner === 'ucli' && capabilities.statsOwner === 'ucli'
      : capabilities.permissionOwner === 'native' && capabilities.historyOwner === 'native'
  )
  const validDshContract = session.adapterId !== 'deepseek-harness' || (validShape && (
    capabilities.surface === 'terminal'
      ? capabilities.gateway === true && capabilities.bridge === true
      : capabilities.gateway === false && capabilities.bridge === false
  ))
  const known = Boolean(validShape && coherentOwnership && validDshContract)
  if (!known) {
    return {
      known: false,
      terminal: false,
      web: false,
      ucliPermission: false,
      ucliHistory: false,
      ucliStats: false,
      gateway: false
    }
  }
  return {
    known: true,
    terminal: capabilities.surface === 'terminal',
    web: capabilities.surface === 'web',
    ucliPermission: capabilities.permissionOwner === 'ucli',
    ucliHistory: capabilities.historyOwner === 'ucli',
    ucliStats: capabilities.statsOwner === 'ucli',
    gateway: capabilities.gateway === true
  }
}

export function deriveSessionMaintenanceState(session = {}) {
  const exists = Boolean(session.id)
  const canRestart = exists && session.canStart !== false
  const capabilities = deriveSessionCapabilityState(session)
  return {
    canInterrupt: exists && capabilities.terminal && capabilities.ucliPermission && INTERRUPTIBLE_STATUSES.has(session.status),
    canStop: exists && ACTIVE_STATUSES.has(session.status),
    canRestart,
    canRemove: exists,
    stopBeforeRestart: canRestart && session.status !== 'offline'
  }
}

export function deriveSessionMaintenanceCopy(session = {}) {
  const capabilities = deriveSessionCapabilityState(session)
  if (capabilities.web) {
    return {
      stopTitle: '停止 Web 主机',
      stopHelp: '停止整个 DSH Web 主机，会话转为离线',
      restartTitle: '重启 Web 主机',
      restartHelp: '停止整个 DSH Web 主机后重新启动'
    }
  }
  if (capabilities.terminal && session.capabilities?.bridge === true) {
    return {
      stopTitle: '停止 TUI 进程',
      stopHelp: '停止整个 DSH TUI 进程，会话转为离线',
      restartTitle: '重启 TUI 会话',
      restartHelp: '停止现有 TUI 进程后恢复同一会话'
    }
  }
  return {
    stopTitle: '停止进程',
    stopHelp: '停止整个 CLI 进程，会话转为离线',
    restartTitle: '重启会话',
    restartHelp: '停止现有进程后恢复同一会话'
  }
}
