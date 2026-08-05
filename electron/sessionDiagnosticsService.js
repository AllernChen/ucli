import {
  listCodexTranscriptSessionsInHome,
  readCodexSessionMetadataFromFile,
  resolveCodexTranscriptSessionInHome
} from './sessionDiscovery.js'

const SAFE_REPAIR_ERROR = '无法从本机 Codex 会话中安全修复绑定'

function normalizeCwd(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function baseDiagnostic(entry) {
  const session = entry.session
  return {
    schemaVersion: 1,
    sessionId: session.id,
    adapterId: session.adapterId,
    cwd: session.cwd || '',
    status: entry.status || 'unknown',
    storedNativeSessionId: session.cliSessionId || null,
    resolvedNativeSessionId: null,
    bindingState: 'unsupported',
    repairAvailable: false,
    lineage: []
  }
}

function buildLineage(rollouts, resolvedNativeSessionId) {
  const byId = new Map(rollouts.map((rollout) => [rollout.sessionId, rollout]))
  const lineage = []
  const visited = new Set()
  let current = byId.get(resolvedNativeSessionId)
  while (current && !visited.has(current.sessionId)) {
    visited.add(current.sessionId)
    lineage.unshift({
      sessionId: current.sessionId,
      forkedFromId: current.forkedFromId || null,
      startedAt: current.startedAt || null,
      updatedAt: current.updatedAt || null
    })
    current = current.forkedFromId ? byId.get(current.forkedFromId) : null
  }
  return lineage
}

export function createSessionDiagnosticsService({
  resolveSession,
  getCodexHome,
  persistBinding,
  publishBinding
}) {
  async function get(sessionId) {
    const entry = resolveSession(sessionId)
    if (!entry) throw new Error('会话不存在')

    const diagnostic = baseDiagnostic(entry)
    if (diagnostic.adapterId !== 'codex') return diagnostic
    if (!diagnostic.storedNativeSessionId) {
      diagnostic.bindingState = 'unbound'
      return diagnostic
    }

    const codexHome = getCodexHome()
    const resolved = resolveCodexTranscriptSessionInHome(
      codexHome,
      diagnostic.storedNativeSessionId
    )
    if (!resolved) {
      diagnostic.bindingState = 'missing'
      return diagnostic
    }

    diagnostic.resolvedNativeSessionId = resolved.sessionId
    const metadata = readCodexSessionMetadataFromFile(resolved.path)
    if (!metadata || normalizeCwd(metadata.cwd) !== normalizeCwd(diagnostic.cwd)) {
      diagnostic.bindingState = 'cwd_mismatch'
      return diagnostic
    }

    const rollouts = listCodexTranscriptSessionsInHome(codexHome, diagnostic.cwd)
    diagnostic.lineage = buildLineage(rollouts, resolved.sessionId)
    diagnostic.bindingState = resolved.sessionId === diagnostic.storedNativeSessionId
      ? 'current'
      : 'stale'
    diagnostic.repairAvailable = diagnostic.bindingState === 'stale'
    return diagnostic
  }

  async function repair(sessionId) {
    const before = await get(sessionId)
    if (before.bindingState === 'current') {
      return { changed: false, previousNativeSessionId: before.storedNativeSessionId, diagnostic: before }
    }
    if (!before.repairAvailable || !before.resolvedNativeSessionId) {
      throw new Error(SAFE_REPAIR_ERROR)
    }

    const entry = resolveSession(sessionId)
    const previousNativeSessionId = entry.session.cliSessionId || null
    const nativeSessionId = before.resolvedNativeSessionId
    entry.session.cliSessionId = nativeSessionId
    try {
      await persistBinding(sessionId, nativeSessionId)
    } catch (error) {
      entry.session.cliSessionId = previousNativeSessionId
      throw error
    }
    publishBinding(sessionId, nativeSessionId)
    return {
      changed: true,
      previousNativeSessionId,
      diagnostic: await get(sessionId)
    }
  }

  return { get, repair }
}
