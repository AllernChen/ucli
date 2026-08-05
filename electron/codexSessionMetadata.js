export function parseCodexSessionMetadata(record) {
  if (record?.type !== 'session_meta' || !record.payload) return null
  const payload = record.payload
  const sessionId = payload.id || payload.session_id || null
  return {
    sessionId,
    forkedFromId: payload.forked_from_id || null,
    parentThreadId: payload.parent_thread_id || null,
    cwd: payload.cwd || '',
    timestamp: payload.timestamp || record.timestamp || '',
    isSubagent: payload.thread_source === 'subagent' || Boolean(payload.source?.subagent)
  }
}
