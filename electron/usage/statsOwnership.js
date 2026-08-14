import { normalizeAdapterCapabilities } from '../adapters/adapterCapabilities.js'

export function sessionUsesUcliStats(session = {}) {
  if (!session.capabilities || typeof session.capabilities !== 'object' || Array.isArray(session.capabilities)) {
    return false
  }
  try {
    const capabilities = normalizeAdapterCapabilities(session.capabilities)
    return capabilities.surface === 'terminal' &&
      capabilities.permissionOwner === 'ucli' &&
      capabilities.historyOwner === 'ucli' &&
      capabilities.statsOwner === 'ucli'
  } catch {
    return false
  }
}

export function aggregateOwnedModelStats(rows = [], ownedSessionIds = new Set()) {
  const aggregates = new Map()
  for (const row of rows) {
    const sessionId = row.sessionId ?? row.session_id
    if (!ownedSessionIds.has(sessionId) || typeof row.model !== 'string' || !row.model) continue
    const aggregate = aggregates.get(row.model) || {
      model: row.model,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      cost_unavailable_count: 0,
      sessionIds: new Set()
    }
    aggregate.input_tokens += Number(row.inputTokens ?? row.input_tokens) || 0
    aggregate.output_tokens += Number(row.outputTokens ?? row.output_tokens) || 0
    const costAvailable = row.costAvailable ?? row.cost_available
    if (costAvailable === false || costAvailable === 0) aggregate.cost_unavailable_count += 1
    else aggregate.cost_usd += Number(row.costUsd ?? row.cost_usd) || 0
    aggregate.sessionIds.add(sessionId)
    aggregates.set(row.model, aggregate)
  }
  return [...aggregates.values()]
    .map(({ sessionIds, ...row }) => ({ ...row, session_count: sessionIds.size }))
    .sort((left, right) => right.input_tokens - left.input_tokens || left.model.localeCompare(right.model))
}
