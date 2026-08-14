const PORT_METHODS = Object.freeze([
  'listSessions',
  'getSession',
  'sendTurn',
  'interrupt',
  'respondDecision',
  'getDecisionContext',
  'getLatestPlanSnapshot',
  'getLatestResultSnapshot',
  'subscribeGatewayEvents'
])

export function describeGatewaySessionEligibility(session) {
  if (session?.adapterId !== 'deepseek-harness') {
    return { eligible: true, reason: null }
  }
  const capabilities = session.capabilities
  if (
    capabilities?.surface === 'web' ||
    session?.adapterConfig?.surfacePreference === 'web'
  ) {
    return { eligible: false, reason: 'DSH_WEB_GATEWAY_UNSUPPORTED' }
  }
  if (
    capabilities?.surface !== 'terminal' ||
    capabilities?.gateway !== true ||
    capabilities?.bridge !== true ||
    session.bridgeLive !== true
  ) {
    return { eligible: false, reason: 'DSH_BRIDGE_DISCONNECTED' }
  }
  return { eligible: true, reason: null }
}

export function createGatewaySessionOperations({ getEntry, getSession }) {
  const eligibleEntry = (sessionId) => {
    const entry = getEntry(sessionId)
    if (!entry?.adapter) return { entry: null, reason: 'session_offline' }
    const eligibility = describeGatewaySessionEligibility(getSession(sessionId))
    return eligibility.eligible
      ? { entry, reason: null }
      : { entry: null, reason: eligibility.reason }
  }
  return Object.freeze({
    async sendTurn(sessionId, text) {
      const { entry, reason } = eligibleEntry(sessionId)
      if (!entry) return { accepted: false, reason }
      await entry.adapter.sendTurn(text)
      entry.status = 'running'
      entry._gatewayTurnActive = true
      return { accepted: true }
    },
    async interrupt(sessionId) {
      const { entry, reason } = eligibleEntry(sessionId)
      if (!entry) return { accepted: false, reason }
      await entry.adapter.interrupt()
      return { accepted: true }
    },
    async respondDecision(sessionId, decisionId, response) {
      const { entry, reason } = eligibleEntry(sessionId)
      if (!entry) return { accepted: false, reason }
      return entry.adapter.respondDecision(decisionId, response)
    },
    getDecisionContext(sessionId, decisionId) {
      return getEntry(sessionId)?.adapter?.getDecisionContext(decisionId) || null
    },
    getLatestPlanSnapshot(sessionId, decisionId) {
      return getEntry(sessionId)?.adapter?.getLatestPlanSnapshot(decisionId) || null
    },
    getLatestResultSnapshot(sessionId, turnId) {
      return getEntry(sessionId)?.adapter?.getLatestResultSnapshot(turnId) || null
    }
  })
}

export function createGatewayPort(implementation) {
  const port = {}
  for (const method of PORT_METHODS) {
    if (typeof implementation?.[method] !== 'function') {
      throw Object.assign(new TypeError(`Gateway port requires ${method}`), {
        code: 'INVALID_GATEWAY_PORT'
      })
    }
    port[method] = implementation[method]
  }
  return Object.freeze(port)
}

export { PORT_METHODS }
