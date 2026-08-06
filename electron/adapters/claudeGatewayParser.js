const USER_DECISION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

function parseRecord(line) {
  if (line && typeof line === 'object') return line
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function timestampOf(record) {
  const value = record?.timestamp || record?.message?.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function contentOf(record) {
  return Array.isArray(record?.message?.content) ? record.message.content : []
}

function hasUserText(record) {
  return contentOf(record).some((part) => part?.type === 'text' && part.text?.trim())
}

function resolvedToolUseIds(records) {
  const resolved = new Set()
  for (const { record } of records) {
    for (const part of contentOf(record)) {
      if (part?.type === 'tool_result' && part.tool_use_id) {
        resolved.add(part.tool_use_id)
      }
    }
  }
  return resolved
}

function nativeSessionIdOf(records) {
  return records.find(({ record }) => (
    record?.type === 'system' &&
    record?.subtype === 'init' &&
    typeof record.session_id === 'string'
  ))?.record.session_id || null
}

function actualModelOf(records) {
  return records.find(({ record }) => (
    record?.type === 'system' &&
    record?.subtype === 'init' &&
    typeof record.model === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:@/+~-]{0,255}$/.test(record.model)
  ))?.record.model || null
}

function questionDecision(toolUse) {
  const questions = Array.isArray(toolUse.input?.questions)
    ? toolUse.input.questions
    : []
  const options = []
  for (const [questionIndex, question] of questions.entries()) {
    for (const [optionIndex, option] of (question.options || []).entries()) {
      if (typeof option?.label !== 'string' || !option.label.trim()) continue
      options.push({
        id: `q${questionIndex}:o${optionIndex}`,
        label: option.label,
        description: typeof option.description === 'string' ? option.description : ''
      })
    }
  }
  const responseMode = questions.length > 1
    ? 'multi'
    : questions[0]?.multiSelect
      ? 'multi'
      : options.length
        ? 'single'
        : 'free_text'
  const summary = questions
    .map((question) => question?.question)
    .filter((question) => typeof question === 'string' && question.trim())
    .join('\n')

  return {
    decisionId: toolUse.id,
    kind: 'question',
    title: questions[0]?.header || 'Claude question',
    summary,
    options,
    responseMode,
    questions: structuredClone(questions)
  }
}

function planDecision(toolUse) {
  const markdown = typeof toolUse.input?.plan === 'string' ? toolUse.input.plan : ''
  const title = markdown.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || 'Claude plan'
  return {
    decisionId: toolUse.id,
    kind: 'plan_review',
    title,
    summary: markdown.slice(0, 1000),
    options: [
      { id: 'execute', label: '执行方案' },
      { id: 'reject', label: '拒绝' },
      { id: 'revise', label: '回复修改意见' }
    ],
    responseMode: 'plan_review'
  }
}

function decisionFromToolUse(toolUse) {
  if (!toolUse?.id || !USER_DECISION_TOOLS.has(toolUse.name)) return null
  return toolUse.name === 'ExitPlanMode'
    ? planDecision(toolUse)
    : questionDecision(toolUse)
}

function parsedRecords(lines) {
  return Array.from(lines || [], (line, index) => ({
    index,
    record: parseRecord(line)
  })).filter(({ record }) => record)
}

export function parseClaudeGatewayState(lines = [], previousCursor = 0) {
  const records = parsedRecords(lines)
  const resolved = resolvedToolUseIds(records)
  const events = []
  const completedTurnIds = new Set()
  let currentTurnId = null
  let currentDecision = null

  for (const { index, record } of records) {
    if (record.type === 'user' && hasUserText(record)) {
      currentTurnId = record.uuid || record.message?.id || `claude-turn-${index}`
      if (index >= previousCursor) {
        events.push({
          type: 'turn_started',
          sessionId: '',
          turnId: currentTurnId,
          occurredAt: timestampOf(record)
        })
      }
    }

    if (record.type === 'assistant') {
      for (const part of contentOf(record)) {
        if (part?.type !== 'tool_use' || resolved.has(part.id)) continue
        const decision = decisionFromToolUse(part)
        if (!decision) continue
        currentDecision = decision
        if (index >= previousCursor && currentTurnId) {
          events.push({
            type: 'decision_required',
            sessionId: '',
            turnId: currentTurnId,
            occurredAt: timestampOf(record),
            decision
          })
        }
      }

      if (
        record.message?.stop_reason === 'end_turn' &&
        currentTurnId &&
        !completedTurnIds.has(currentTurnId)
      ) {
        completedTurnIds.add(currentTurnId)
        if (index >= previousCursor) {
          events.push({
            type: 'turn_completed',
            sessionId: '',
            turnId: currentTurnId,
            occurredAt: timestampOf(record)
          })
        }
      }
    }

    if (record.type === 'result' && record.is_error && currentTurnId && index >= previousCursor) {
      const interrupted = /interrupt|cancel|abort/i.test(record.subtype || '')
      events.push({
        type: interrupted ? 'turn_interrupted' : 'turn_failed',
        sessionId: '',
        turnId: currentTurnId,
        occurredAt: timestampOf(record),
        errorCode: record.subtype || 'claude_error'
      })
    }
  }

  return {
    events,
    cursor: Array.from(lines || []).length,
    currentDecision,
    nativeSessionId: nativeSessionIdOf(records),
    actualModel: actualModelOf(records)
  }
}

export function extractClaudePlanSnapshot(lines = [], decisionId) {
  const records = parsedRecords(lines)
  const nativeSessionId = nativeSessionIdOf(records)
  for (const { record } of records) {
    if (record.type !== 'assistant') continue
    for (const part of contentOf(record)) {
      if (
        part?.type !== 'tool_use' ||
        part.id !== decisionId ||
        part.name !== 'ExitPlanMode' ||
        typeof part.input?.plan !== 'string' ||
        !part.input.plan.trim()
      ) continue
      const title = part.input.plan.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || 'Claude plan'
      return {
        kind: 'plan_review',
        title,
        markdown: part.input.plan,
        provider: 'claude',
        nativeSessionId,
        capturedAt: timestampOf(record)
      }
    }
  }
  return null
}

export function extractClaudeResultSnapshot(lines = [], turnId) {
  const records = parsedRecords(lines)
  const nativeSessionId = nativeSessionIdOf(records)
  let collecting = false
  let completed = false
  let capturedAt = 0
  const text = []

  for (const { index, record } of records) {
    if (record.type === 'user' && hasUserText(record)) {
      const id = record.uuid || record.message?.id || `claude-turn-${index}`
      if (collecting && id !== turnId) break
      collecting = id === turnId
      continue
    }
    if (!collecting || record.type !== 'assistant') continue
    for (const part of contentOf(record)) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        text.push(part.text)
      }
    }
    if (record.message?.stop_reason === 'end_turn') {
      completed = true
      capturedAt = timestampOf(record)
    }
  }

  if (!completed || !text.length) return null
  return {
    kind: 'result',
    title: 'Claude result',
    markdown: text.join('\n\n'),
    provider: 'claude',
    nativeSessionId,
    turnId,
    capturedAt
  }
}

function optionIndex(decision, optionId) {
  return decision.options.findIndex((option) => option.id === optionId)
}

export function encodeClaudeDecisionResponse(decision, response) {
  if (!decision || !response) return null

  if (decision.kind === 'plan_review') {
    if (response.action === 'execute') return ['\r']
    if (response.action === 'reject') return ['\x1b']
    if (response.action === 'revise' && typeof response.text === 'string' && response.text.trim()) {
      return ['\x1b', response.text.trim() + '\r']
    }
    return null
  }

  if (decision.responseMode === 'free_text') {
    return typeof response.text === 'string' && response.text.trim()
      ? [response.text.trim() + '\r']
      : null
  }

  if (decision.responseMode === 'single') {
    const index = optionIndex(decision, response.optionId)
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
