function messagesOf(source) {
  return Array.isArray(source?.messages) ? source.messages : []
}

function messageText(message) {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .filter((text) => text.trim())
    .join('\n\n')
}

function titleOf(markdown, fallback) {
  return markdown?.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || fallback
}

function questionDecision(part, displayName = 'OpenCode') {
  const questions = Array.isArray(part?.state?.input?.questions)
    ? part.state.input.questions
    : []
  const options = []
  for (const [questionIndex, question] of questions.entries()) {
    for (const [optionIndex, option] of (question?.options || []).entries()) {
      if (typeof option?.label !== 'string' || !option.label.trim()) continue
      options.push({
        id: `q${questionIndex}:o${optionIndex}`,
        label: option.label,
        description: typeof option.description === 'string' ? option.description : ''
      })
    }
  }
  return {
    decisionId: part.id,
    kind: 'question',
    title: questions[0]?.header || `${displayName} question`,
    summary: questions
      .map((question) => question?.question)
      .filter((question) => typeof question === 'string' && question.trim())
      .join('\n'),
    options,
    responseMode: questions.length > 1 || questions[0]?.multiple
      ? 'multi'
      : options.length
        ? 'single'
        : 'free_text',
    questions: structuredClone(questions)
  }
}

function permissionDecision(part, displayName = 'OpenCode') {
  const detail = part?.state?.input ? JSON.stringify(part.state.input) : part?.tool || ''
  return {
    decisionId: part.state.permissionID,
    kind: 'permission',
    title: `Allow ${part.tool || `${displayName} tool`}?`,
    summary: detail,
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' }
    ],
    responseMode: 'single'
  }
}

function planDecision(message, displayName = 'OpenCode') {
  const markdown = messageText(message)
  return {
    decisionId: `plan:${message.info.id}`,
    kind: 'plan_review',
    title: titleOf(markdown, `${displayName} plan`),
    summary: markdown.slice(0, 1000),
    options: [
      { id: 'execute', label: 'Execute plan' },
      { id: 'reject', label: 'Reject' },
      { id: 'revise', label: 'Request changes' }
    ],
    responseMode: 'plan_review'
  }
}

function occurredAt(message, completed = false) {
  const time = message?.info?.time || {}
  const value = completed ? time.completed || time.updated || time.created : time.created
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function cursorSet(previousCursor) {
  return new Set(Array.isArray(previousCursor) ? previousCursor : [])
}

function eventKey(type, id, state = '') {
  return `${type}:${id || 'unknown'}:${state}`
}

export function parseOpenCodeGatewayState(source = {}, previousCursor = [], identity = {}) {
  const displayName = identity.displayName || 'OpenCode'
  const messages = messagesOf(source)
  const seen = cursorSet(previousCursor)
  const nextCursor = new Set(seen)
  const events = []
  let currentTurnId = null
  let currentDecision = null

  const pushNew = (key, event) => {
    nextCursor.add(key)
    if (!seen.has(key)) events.push(event)
  }

  for (const message of messages) {
    const info = message?.info || {}
    if (info.role === 'user' && info.id) {
      currentTurnId = info.id
      currentDecision = null
      pushNew(eventKey('turn', info.id), {
        type: 'turn_started',
        sessionId: '',
        turnId: currentTurnId,
        occurredAt: occurredAt(message)
      })
      continue
    }
    if (info.role !== 'assistant' || !currentTurnId) continue

    for (const part of (Array.isArray(message.parts) ? message.parts : [])) {
      if (part?.type !== 'tool') continue
      const status = part.state?.status
      if (status !== 'pending' && status !== 'running') continue
      let decision = null
      if (part.tool === 'question' && part.id) {
        decision = questionDecision(part, displayName)
      } else if (part.state?.permissionID) {
        decision = permissionDecision(part, displayName)
      }
      if (!decision) continue
      currentDecision = decision
      pushNew(eventKey('decision', decision.decisionId, status), {
        type: 'decision_required',
        sessionId: '',
        turnId: currentTurnId,
        occurredAt: occurredAt(message),
        decision
      })
    }

    if (info.finish !== 'stop') continue
    if (info.agent === 'plan') {
      const markdown = messageText(message)
      if (!markdown.trim()) continue
      const decision = planDecision(message, displayName)
      currentDecision = decision
      pushNew(eventKey('plan', info.id, info.time?.completed), {
        type: 'decision_required',
        sessionId: '',
        turnId: currentTurnId,
        occurredAt: occurredAt(message, true),
        decision
      })
    } else {
      pushNew(eventKey('complete', info.id, info.time?.completed), {
        type: 'turn_completed',
        sessionId: '',
        turnId: currentTurnId,
        occurredAt: occurredAt(message, true)
      })
    }
  }

  return {
    events,
    cursor: [...nextCursor],
    currentDecision,
    nativeSessionId: typeof source?.info?.id === 'string' ? source.info.id : null
  }
}

export function extractOpenCodePlanSnapshot(source = {}, decisionId, identity = {}) {
  const displayName = identity.displayName || 'OpenCode'
  const message = messagesOf(source).find((candidate) =>
    candidate?.info?.role === 'assistant' &&
    candidate.info.agent === 'plan' &&
    `plan:${candidate.info.id}` === decisionId
  )
  const markdown = messageText(message)
  if (!message || !markdown.trim()) return null
  return {
    kind: 'plan_review',
    title: titleOf(markdown, `${displayName} plan`),
    markdown,
    provider: identity.provider || 'opencode',
    nativeSessionId: source?.info?.id || null,
    capturedAt: occurredAt(message, true)
  }
}

export function extractOpenCodeResultSnapshot(source = {}, turnId, identity = {}) {
  const displayName = identity.displayName || 'OpenCode'
  const messages = messagesOf(source)
  const start = messages.findIndex((message) =>
    message?.info?.role === 'user' && message.info.id === turnId
  )
  if (start < 0) return null
  const text = []
  let completedAt = 0
  for (let index = start + 1; index < messages.length; index++) {
    const message = messages[index]
    if (message?.info?.role === 'user') break
    if (message?.info?.role !== 'assistant') continue
    const value = messageText(message)
    if (value.trim()) text.push(value)
    if (message.info.finish === 'stop' && message.info.agent !== 'plan') {
      completedAt = occurredAt(message, true)
    }
  }
  if (!completedAt || !text.length) return null
  return {
    kind: 'result',
    title: `${displayName} result`,
    markdown: text.join('\n\n'),
    provider: identity.provider || 'opencode',
    nativeSessionId: source?.info?.id || null,
    turnId,
    capturedAt: completedAt
  }
}

function optionIndex(decision, optionId) {
  return decision.options.findIndex((option) => option.id === optionId)
}

export function encodeOpenCodeDecisionResponse(decision, response) {
  if (!decision || !response) return null

  if (decision.kind === 'plan_review') {
    if (response.action === 'execute') {
      return ['\t', 'Implement the approved plan.\r']
    }
    if (response.action === 'reject') return []
    if (response.action === 'revise' && typeof response.text === 'string' && response.text.trim()) {
      return [response.text.trim() + '\r']
    }
    return null
  }

  if (decision.responseMode === 'free_text') {
    return typeof response.text === 'string' && response.text.trim()
      ? [response.text.trim() + '\r']
      : null
  }

  if (decision.responseMode === 'single') {
    const optionId = response.optionId || response.action
    const index = optionIndex(decision, optionId)
    if (index < 0) return null
    return [...Array(index).fill('\x1b[B'), '\r']
  }

  if (decision.responseMode === 'multi' && Array.isArray(response.optionIds)) {
    const indices = [...new Set(response.optionIds.map((id) => optionIndex(decision, id)))]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)
    if (!indices.length) return null
    const inputs = []
    let currentIndex = 0
    for (const index of indices) {
      inputs.push(...Array(index - currentIndex).fill('\x1b[B'), ' ')
      currentIndex = index
    }
    inputs.push('\r')
    return inputs
  }

  return null
}
