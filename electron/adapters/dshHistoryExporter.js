export function createDshHistoryExporter({
  getSessionUrl,   // (sessionId) => string | null  —— surfaceState.url
  dshClient,       // { listSessions, exportSession }
  selectLaunch,    // () => { source, launch, home } | null
  launchWeb,       // (runtime, cwd) => controller（有 .ready / .state.url / .stop()）
  parseHistory     // (text) => items
} = {}) {
  return async function exportHistory(session, { start, endExclusive } = {}) {
    const url = getSessionUrl(session.id)
    const collect = async (activeUrl) => {
      const nativeSessions = await dshClient.listSessions(activeUrl)
      if (!nativeSessions) return null
      const matched = nativeSessions.filter((s) =>
        typeof s.updatedAt === 'number' && s.updatedAt >= start)
      const items = []
      for (const s of matched) {
        const text = await dshClient.exportSession(activeUrl, s.sessionId)
        if (text) items.push(...parseHistory(text.split(/\r?\n/)))
      }
      return { items, sourceKind: 'export', sourceTruncated: false }
    }
    if (typeof url === 'string' && url) return collect(url)
    const selected = await selectLaunch()
    if (!selected) return null
    let controller = null
    try {
      controller = launchWeb(selected, session.cwd)
      await controller.ready
      return await collect(controller.state.url)
    } catch {
      return null
    } finally {
      if (controller) await controller.stop().catch(() => {})
    }
  }
}
