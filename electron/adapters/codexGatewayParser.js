import { parseCodexSessionMetadata } from '../codexSessionMetadata.js'

function parseRecord(line) {
  if (line && typeof line === 'object') return line
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function timestampOf(record) {
  const value = record?.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function recordsOf(lines) {
  return Array.from(lines || [], (line, index) => ({
    index,
    record: parseRecord(line)
  })).filter(({ record }) => record)
}

function nativeSessionIdOf(records) {
  const meta = records.find(({ record }) => record.type === 'session_meta')?.record
  return parseCodexSessionMetadata(meta)?.sessionId || null
}

function messageText(payload) {
  if (!Array.isArray(payload?.content)) return ''
  return payload.content
    .map((part) => typeof part === 'string'
      ? part
      : part?.text || part?.content || '')
    .filter(Boolean)
    .join('\n')
}

function planMarkdown(text) {
  const match = String(text || '').match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)
  return match?.[1]?.trim() || null
}

function titleOf(markdown, fallback) {
  return markdown?.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || fallback
}

function safeArguments(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function questionDecision(payload) {
  const input = safeArguments(payload.arguments)
  const questions = Array.isArray(input.questions) ? input.questions : []
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
    decisionId: payload.call_id,
    kind: 'question',
    title: questions[0]?.header || 'Codex question',
    summary: questions
      .map((question) => question?.question)
      .filter((question) => typeof question === 'string' && question.trim())
      .join('\n'),
    options,
    responseMode: questions.length > 1 || questions[0]?.multiSelect
      ? 'multi'
      : options.length
        ? 'single'
        : 'free_text',
    questions: structuredClone(questions)
  }
}

function permissionDecision(payload) {
  const rawInput = payload.arguments ?? payload.input
  const input = safeArguments(rawInput)
  const detail = typeof rawInput === 'string'
    ? rawInput
    : JSON.stringify(input)
  return {
    decisionId: payload.call_id,
    kind: 'permission',
    title: `Allow ${payload.name || 'Codex tool'}?`,
    summary: detail || payload.name || '',
    options: [
      { id: 'allow_once', label: '1. Allow once' },
      { id: 'allow_session', label: '2. Allow similar commands this session' },
      { id: 'deny', label: '3. Deny' }
    ],
    responseMode: 'single'
  }
}

function planDecision(messageId, markdown) {
  return {
    decisionId: `plan:${messageId}`,
    kind: 'plan_review',
    title: titleOf(markdown, 'Codex plan'),
    summary: markdown.slice(0, 1000),
    options: [
      { id: 'execute', label: 'Execute plan' },
      { id: 'reject', label: 'Reject' },
      { id: 'revise', label: 'Request changes' }
    ],
    responseMode: 'plan_review'
  }
}

function resolvedCallIds(records) {
  const resolved = new Set()
  for (const { record } of records) {
    const payload = record?.payload
    if (
      record.type === 'response_item' &&
      (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')
    ) {
      const id = payload.call_id || payload.id
      if (id) resolved.add(id)
    }
  }
  return resolved
}

export function parseCodexGatewayState(lines = [], previousCursor = 0) {
  const records = recordsOf(lines)
  const resolved = resolvedCallIds(records)
  const events = []
  let currentTurnId = null
  let currentDecision = null
  let latestAssistant = null

  for (const { index, record } of records) {
    const payload = record.payload || {}
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      currentTurnId = payload.turn_id || `codex-turn-${index}`
      currentDecision = null
      latestAssistant = null
      if (index >= previousCursor) {
        events.push({
          type: 'turn_started',
          sessionId: '',
          turnId: currentTurnId,
          occurredAt: timestampOf(record)
        })
      }
      continue
    }

    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      latestAssistant = {
        id: payload.id || `codex-message-${index}`,
        text: messageText(payload),
        occurredAt: timestampOf(record)
      }
      continue
    }

    if (
      record.type === 'response_item' &&
      (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
      payload.call_id &&
      !resolved.has(payload.call_id)
    ) {
      const decision = payload.name === 'request_user_input'
        ? questionDecision(payload)
        : permissionDecision(payload)
      currentDecision = decision
      if (currentTurnId && index >= previousCursor) {
        events.push({
          type: 'decision_required',
          sessionId: '',
          turnId: currentTurnId,
          occurredAt: timestampOf(record),
          decision
        })
      }
      continue
    }

    if (record.type !== 'event_msg' || !currentTurnId) continue

    if (payload.type === 'task_complete') {
      const markdown = planMarkdown(latestAssistant?.text)
      if (markdown) {
        const decision = planDecision(latestAssistant.id, markdown)
        currentDecision = decision
        if (index >= previousCursor) {
          events.push({
            type: 'decision_required',
            sessionId: '',
            turnId: currentTurnId,
            occurredAt: latestAssistant.occurredAt || timestampOf(record),
            decision
          })
        }
      } else if (index >= previousCursor) {
        events.push({
          type: 'turn_completed',
          sessionId: '',
          turnId: payload.turn_id || currentTurnId,
          occurredAt: timestampOf(record)
        })
      }
      continue
    }

    if (payload.type === 'turn_aborted' && index >= previousCursor) {
      events.push({
        type: 'turn_interrupted',
        sessionId: '',
        turnId: payload.turn_id || currentTurnId,
        occurredAt: timestampOf(record)
      })
    }
    if (payload.type === 'task_failed' && index >= previousCursor) {
      events.push({
        type: 'turn_failed',
        sessionId: '',
        turnId: payload.turn_id || currentTurnId,
        occurredAt: timestampOf(record),
        errorCode: payload.error_code || payload.error?.code || 'codex_task_failed'
      })
    }
  }

  return {
    events,
    cursor: Array.from(lines || []).length,
    currentDecision,
    nativeSessionId: nativeSessionIdOf(records)
  }
}

export function extractCodexPlanSnapshot(lines = [], decisionId) {
  const records = recordsOf(lines)
  for (const { record } of records) {
    const payload = record.payload || {}
    if (
      record.type !== 'response_item' ||
      payload.type !== 'message' ||
      payload.role !== 'assistant' ||
      `plan:${payload.id}` !== decisionId
    ) continue
    const markdown = planMarkdown(messageText(payload))
    if (!markdown) continue
    return {
      kind: 'plan_review',
      title: titleOf(markdown, 'Codex plan'),
      markdown,
      provider: 'codex',
      nativeSessionId: nativeSessionIdOf(records),
      capturedAt: timestampOf(record)
    }
  }
  return null
}

export function extractCodexResultSnapshot(lines = [], turnId) {
  const records = recordsOf(lines)
  let collecting = false
  let completed = false
  let capturedAt = 0
  const text = []

  for (const { index, record } of records) {
    const payload = record.payload || {}
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const id = payload.turn_id || `codex-turn-${index}`
      if (collecting && id !== turnId) break
      collecting = id === turnId
      continue
    }
    if (!collecting) continue
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const value = messageText(payload)
      if (value.trim() && !planMarkdown(value)) text.push(value)
    }
    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      completed = true
      capturedAt = timestampOf(record)
    }
  }

  if (!completed || !text.length) return null
  return {
    kind: 'result',
    title: 'Codex result',
    markdown: text.join('\n\n'),
    provider: 'codex',
    nativeSessionId: nativeSessionIdOf(records),
    turnId,
    capturedAt
  }
}

function optionIndex(decision, optionId) {
  return decision.options.findIndex((option) => option.id === optionId)
}

export function encodeCodexDecisionResponse(decision, response) {
  if (!decision || !response) return null

  if (decision.kind === 'plan_review') {
    if (response.action === 'execute') return ['Implement the approved plan.\r']
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
