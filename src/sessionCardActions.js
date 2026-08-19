import { deriveSessionMaintenanceState, deriveSessionMaintenanceCopy } from './sessionMaintenancePresentation.js'

export function sessionCardActionItems(session) {
  const state = deriveSessionMaintenanceState(session)
  const copy = deriveSessionMaintenanceCopy(session)
  const items = []
  if (state.canStop) items.push({ key: 'stop', label: copy.stopTitle, danger: false })
  if (state.canRestart) items.push({ key: 'restart', label: copy.restartTitle, danger: false })
  items.push({ key: 'rename', label: '重命名', danger: false })
  if (state.canRemove) items.push({ key: 'delete', label: '删除', danger: true })
  return items
}
