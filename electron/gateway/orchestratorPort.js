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
