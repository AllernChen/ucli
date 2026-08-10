const ACTIVE_STATUSES = new Set(['running', 'idle', 'waiting', 'starting'])
const INTERRUPTIBLE_STATUSES = new Set(['running', 'idle', 'waiting'])

export function deriveSessionMaintenanceState(session = {}) {
  const exists = Boolean(session.id)
  const canRestart = exists && session.canStart !== false
  return {
    canInterrupt: exists && INTERRUPTIBLE_STATUSES.has(session.status),
    canStop: exists && ACTIVE_STATUSES.has(session.status),
    canRestart,
    canRemove: exists,
    stopBeforeRestart: canRestart && session.status !== 'offline'
  }
}
