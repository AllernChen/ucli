const ROLES = new Set(['user', 'assistant', 'tool', 'system'])
const TOOL_SUMMARY_LIMIT = 2000

function parseRecord(line) {
  if (line && typeof line === 'object') return line
  if (typeof line !== 'string' || !line.trim()) return null
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function approvedText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function contentText(content, allowedTypes = null) {
  if (typeof content === 'string') return approvedText(content)
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => {
      if (!part || typeof part !== 'object') return false
      return !allowedTypes || allowedTypes.has(part.type)
    })
    .map((part) => approvedText(part.text || part.content || part.message))
    .filter(Boolean)
    .join('\n')
}

function toolSummary(name, detail) {
  const title = approvedText(name) || '工具'
  const description = approvedText(detail)
  return description
    ? `${title}\n${description.slice(0, TOOL_SUMMARY_LIMIT)}`
    : title
}

function addItem(items, { id, role, text, timestamp }) {
  const safeText = approvedText(text)
  if (!ROLES.has(role) || !safeText) return
  items.push({
    id: String(id),
    role,
    text: safeText,
    timestamp: normalizeTimestamp(timestamp)
  })
}

function claudeToolInput(input) {
  if (!input || typeof input !== 'object') return ''
  return approvedText(input.command || input.file_path || input.path)
}

function claudeToolResult(content) {
  if (typeof content === 'string') return approvedText(content)
  return contentText(content, new Set(['text']))
}

export function parseClaudeHistory(lines = []) {
  const items = []

  for (const [recordIndex, line] of Array.from(lines).entries()) {
    const record = parseRecord(line)
    if (!record) continue
    const baseId = record.uuid || record.message?.id || `claude-${recordIndex}`
    const timestamp = record.timestamp || record.message?.timestamp

    if (record.type === 'system' && record.subtype === 'init') {
      const model = approvedText(record.model)
      addItem(items, {
        id: `${baseId}:system`,
        role: 'system',
        text: model ? `Claude Code · ${model}` : 'Claude Code',
        timestamp
      })
      continue
    }

    if (record.type !== 'user' && record.type !== 'assistant') continue
    const parts = Array.isArray(record.message?.content) ? record.message.content : []
    const text = contentText(parts, new Set(['text']))
    addItem(items, {
      id: `${baseId}:${record.type}`,
      role: record.type,
      text,
      timestamp
    })

    for (const [partIndex, part] of parts.entries()) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'tool_use') {
        addItem(items, {
          id: part.id || `${baseId}:tool-use:${partIndex}`,
          role: 'tool',
          text: toolSummary(part.name, claudeToolInput(part.input)),
          timestamp
        })
      } else if (part.type === 'tool_result') {
        addItem(items, {
          id: part.tool_use_id
            ? `${part.tool_use_id}:result`
            : `${baseId}:tool-result:${partIndex}`,
          role: 'tool',
          text: toolSummary(part.is_error ? '工具错误' : '工具结果', claudeToolResult(part.content)),
          timestamp
        })
      }
    }
  }

  return items
}

const CODEX_USER_TEXT_TYPES = new Set(['input_text', 'text'])
const CODEX_ASSISTANT_TEXT_TYPES = new Set(['output_text', 'text'])

function codexMessageText(content, role) {
  const allowed = role === 'user' ? CODEX_USER_TEXT_TYPES : CODEX_ASSISTANT_TEXT_TYPES
  return contentText(content, allowed)
}

export function parseCodexHistory(lines = []) {
  const items = []

  for (const [recordIndex, line] of Array.from(lines).entries()) {
    const record = parseRecord(line)
    if (!record) continue
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload
      : null
    const baseId = payload?.id || payload?.call_id || record.id || `codex-${recordIndex}`
    const timestamp = record.timestamp || payload?.timestamp

    if (record.type === 'session_meta' && payload) {
      const model = approvedText(payload.model)
      addItem(items, {
        id: `${baseId}:system`,
        role: 'system',
        text: model ? `Codex · ${model}` : 'Codex',
        timestamp
      })
      continue
    }

    if (record.type === 'response_item' && payload?.type === 'message') {
      const role = payload.role
      if (role === 'user' || role === 'assistant') {
        addItem(items, {
          id: `${baseId}:${role}`,
          role,
          text: codexMessageText(payload.content, role),
          timestamp
        })
      }
      continue
    }

    if (record.type === 'event_msg' && payload) {
      const role = payload.type === 'user_message'
        ? 'user'
        : payload.type === 'assistant_message' || payload.type === 'agent_message'
          ? 'assistant'
          : null
      if (role) {
        addItem(items, {
          id: `${baseId}:${role}`,
          role,
          text: typeof payload.message === 'string'
            ? payload.message
            : codexMessageText(payload.content, role),
          timestamp
        })
      }
      continue
    }

    const tool = record.type === 'response_item' && payload
      ? payload
      : record
    if (tool.type === 'function_call' || tool.type === 'tool_call') {
      addItem(items, {
        id: tool.call_id || tool.id || `${baseId}:tool-call`,
        role: 'tool',
        text: toolSummary(tool.name || tool.function?.name, tool.arguments),
        timestamp
      })
    } else if (tool.type === 'function_call_output' || tool.type === 'tool_result') {
      addItem(items, {
        id: `${tool.call_id || tool.id || baseId}:result`,
        role: 'tool',
        text: toolSummary('工具结果', tool.output || tool.content),
        timestamp
      })
    }
  }

  return items
}

export function parseOpenCodeHistory(source) {
  const items = []
  const messages = Array.isArray(source?.messages) ? source.messages : []

  for (const [messageIndex, message] of messages.entries()) {
    const info = message?.info && typeof message.info === 'object' ? message.info : {}
    const role = info.role
    if (role !== 'user' && role !== 'assistant') continue
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const baseId = info.id || `opencode-${messageIndex}`
    const timestamp = info.time?.created

    addItem(items, {
      id: `${baseId}:${role}`,
      role,
      text: contentText(parts, new Set(['text'])),
      timestamp
    })

    for (const [partIndex, part] of parts.entries()) {
      if (!part || part.type !== 'tool') continue
      const state = part.state && typeof part.state === 'object' ? part.state : {}
      const status = approvedText(state.status)
      const output = approvedText(state.output)
      const detail = [status, output].filter(Boolean).join('\n')
      addItem(items, {
        id: part.id || `${baseId}:tool:${partIndex}`,
        role: 'tool',
        text: toolSummary(part.tool, detail),
        timestamp
      })
    }
  }

  return items
}

export function historyPage(items, { before = null, limit = 100 } = {}) {
  const safeItems = Array.isArray(items) ? items : []
  const numericLimit = Number(limit)
  const safeLimit = Math.max(
    1,
    Math.min(200, Number.isFinite(numericLimit) ? Math.trunc(numericLimit) : 100)
  )
  const numericBefore = Number(before)
  const end = before == null || !Number.isFinite(numericBefore)
    ? safeItems.length
    : Math.max(0, Math.min(safeItems.length, Math.trunc(numericBefore)))
  const start = Math.max(0, end - safeLimit)

  return {
    items: safeItems.slice(start, end),
    nextBefore: start > 0 ? start : null,
    complete: start === 0
  }
}
