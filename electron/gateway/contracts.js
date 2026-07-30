export const GATEWAY_EVENT = Object.freeze({
  TURN_STARTED: 'turn_started',
  DECISION_REQUIRED: 'decision_required',
  TURN_COMPLETED: 'turn_completed',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_FAILED: 'turn_failed',
  SESSION_STOPPED: 'session_stopped'
})

export const GATEWAY_EVENT_TYPES = Object.freeze(Object.values(GATEWAY_EVENT))

export const GATEWAY_DECISION_KINDS = Object.freeze([
  'permission',
  'question',
  'plan_review',
  'terminal_prompt'
])

export const GATEWAY_RESPONSE_MODES = Object.freeze([
  'single',
  'multi',
  'free_text',
  'plan_review'
])

const TURN_EVENT_TYPES = new Set([
  GATEWAY_EVENT.TURN_STARTED,
  GATEWAY_EVENT.DECISION_REQUIRED,
  GATEWAY_EVENT.TURN_COMPLETED,
  GATEWAY_EVENT.TURN_INTERRUPTED,
  GATEWAY_EVENT.TURN_FAILED
])

function contractError(message, code) {
  return Object.assign(new TypeError(message), { code })
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw contractError('Gateway decision is required', 'INVALID_GATEWAY_DECISION')
  }
  if (!isNonEmptyString(decision.decisionId)) {
    throw contractError('Gateway decisionId is required', 'INVALID_GATEWAY_DECISION')
  }
  if (!GATEWAY_DECISION_KINDS.includes(decision.kind)) {
    throw contractError('Unsupported Gateway decision kind', 'INVALID_GATEWAY_DECISION')
  }
  if (!isNonEmptyString(decision.title) || typeof decision.summary !== 'string') {
    throw contractError('Gateway decision title and summary are required', 'INVALID_GATEWAY_DECISION')
  }
  if (!Array.isArray(decision.options)) {
    throw contractError('Gateway decision options are required', 'INVALID_GATEWAY_DECISION')
  }
  for (const option of decision.options) {
    if (!isNonEmptyString(option?.id) || !isNonEmptyString(option?.label)) {
      throw contractError('Gateway decision options require id and label', 'INVALID_GATEWAY_DECISION')
    }
  }
  if (!GATEWAY_RESPONSE_MODES.includes(decision.responseMode)) {
    throw contractError('Unsupported Gateway response mode', 'INVALID_GATEWAY_DECISION')
  }
  return decision
}

export function validateGatewayEvent(event) {
  if (!event || typeof event !== 'object' || !GATEWAY_EVENT_TYPES.includes(event.type)) {
    throw contractError('Unsupported Gateway event type', 'INVALID_GATEWAY_EVENT')
  }
  if (!isNonEmptyString(event.sessionId)) {
    throw contractError('Gateway sessionId is required', 'INVALID_GATEWAY_EVENT')
  }
  if (!Number.isFinite(event.occurredAt)) {
    throw contractError('Gateway occurredAt is required', 'INVALID_GATEWAY_EVENT')
  }
  if (TURN_EVENT_TYPES.has(event.type) && !isNonEmptyString(event.turnId)) {
    throw contractError('Gateway turnId is required', 'INVALID_GATEWAY_EVENT')
  }
  if (event.type === GATEWAY_EVENT.DECISION_REQUIRED) {
    validateDecision(event.decision)
  }
  return event
}
