export class GatewayRouteStore {
  constructor(db) {
    this.db = db
  }

  listSessionRoutes() {
    return this.db.listGatewaySessionRoutes()
  }

  upsertSessionRoute(route) {
    return this.db.upsertGatewaySessionRoute(route)
  }

  setRelayEnabled(sessionId, relayEnabled) {
    return this.db.upsertGatewaySessionRoute({
      sessionId,
      relayEnabled: Boolean(relayEnabled)
    })
  }

  saveMessageRoute(route) {
    return this.db.saveGatewayMessageRoute({
      messageId: route?.messageId,
      sessionId: route?.sessionId,
      relayTaskId: route?.relayTaskId,
      decisionId: route?.decisionId,
      routeKind: route?.routeKind,
      channelFingerprint: route?.channelFingerprint,
      active: route?.active,
      createdAt: route?.createdAt
    })
  }

  resolveMessageRoute(messageId, channelFingerprint) {
    return this.db.resolveGatewayMessageRoute(messageId, channelFingerprint)
  }

  deactivateSession(sessionId) {
    this.db.deactivateGatewayRoutesForSession(sessionId)
  }

  deactivateFingerprint(channelFingerprint) {
    this.db.deactivateGatewayRoutesForFingerprint(channelFingerprint)
  }

  saveDecisionAudit(record) {
    return this.db.saveGatewayDecisionAudit({
      id: record?.id,
      sessionId: record?.sessionId,
      decisionId: record?.decisionId,
      kind: record?.kind,
      verdict: record?.verdict,
      source: record?.source,
      resolvedAt: record?.resolvedAt
    })
  }
}
