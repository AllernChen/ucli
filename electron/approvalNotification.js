export function shouldShowApprovalNotification(windowRef) {
  if (!windowRef || windowRef.isDestroyed()) return false
  return !windowRef.isVisible() || windowRef.isMinimized() || !windowRef.isFocused()
}

export function operationTypeForTool(tool) {
  if (tool === 'Bash') return '执行命令'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return '修改文件'
  if (['WebSearch', 'WebFetch'].includes(tool)) return '访问网络'
  if (tool === 'AskUserQuestion') return '回答问题'
  if (tool === 'ExitPlanMode') return '确认执行方案'
  return tool || '需要确认'
}

function sessionName(session, fallbackSessionId) {
  if (session?.name) return session.name
  const id = session?.id || fallbackSessionId
  if (session?.adapterId && id) return `${session.adapterId} · ${id.slice(0, 8)}`
  return session?.adapterId || id?.slice(0, 8) || '当前会话'
}

export function describeApprovalNotification(request, session) {
  const name = sessionName(session, request?.sessionId)
  return {
    title: 'UCLI 等待确认',
    body: `会话：${name}\n操作：${operationTypeForTool(request?.tool)}`
  }
}

export function describeSessionAttentionNotification(attention, session) {
  return {
    title: attention?.kind === 'complete' ? 'UCLI 任务已完成' : 'UCLI 等待确认',
    body: `会话：${sessionName(session)}\n操作：${attention?.operation || '需要确认'}`
  }
}

export function advanceSessionNotification(previous, key, now = Date.now(), cooldownMs = 5000) {
  if (previous?.key === key && now - previous.at < cooldownMs) {
    return { state: previous, deliver: false }
  }
  return { state: { key, at: now }, deliver: true }
}

export function advanceTaskCompletion(previousTurns, nextTurns) {
  const next = Number(nextTurns)
  if (!Number.isFinite(next) || next < 0) {
    return { turns: previousTurns, completed: false }
  }
  if (previousTurns === null) {
    return next > 0
      ? { turns: next, completed: false }
      : { turns: null, completed: false }
  }
  if (next <= previousTurns) return { turns: previousTurns, completed: false }
  return { turns: next, completed: true }
}

export function describeTaskCompletionNotification(session) {
  return describeSessionAttentionNotification({
    kind: 'complete',
    operation: '任务完成'
  }, session)
}
