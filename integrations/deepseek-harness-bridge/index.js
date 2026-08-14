import { createConnection } from 'node:net'

import {
  BridgeFrameDecoder,
  DSH_BRIDGE_MAX_FRAME_BYTES,
  encodeBridgeFrame,
  isPlainBridgeObject
} from './framing.js'

export const name = 'ucli-dsh-bridge'
export const inject = ['agents', 'sessions']

export const DSH_BRIDGE_CAPABILITIES = Object.freeze({
  terminal: true,
  resume: true,
  permissions: true,
  stats: true,
  notifications: true,
  gateway: true,
  planSnapshot: true,
  resultSnapshot: true
})

export const internals = { createConnection, setTimeout, clearTimeout }

const PROTOCOL_VERSION = 1
const BRIDGE_VERSION = '0.11.0'
const SAFE_TOKEN = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[\x21-\x7e]{1,256}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const MAX_EVENT_FIELD_BYTES = 768 * 1024
const FRAME_RESERVE_BYTES = 4 * 1024
const MAX_PATH = 4_096
const MAX_COMMAND = 32_768
const MAX_INPUT = MAX_EVENT_FIELD_BYTES

function exactKeys(value, keys) {
  if (!isPlainBridgeObject(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function profileFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') return argv[index + 1]
    if (argument.startsWith('--profile=')) return argument.slice('--profile='.length)
  }
  return undefined
}

function safeString(value, maxBytes, pattern) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) return undefined
  if (pattern && !pattern.test(value)) return undefined
  if (/\0/u.test(value)) return undefined
  return value
}

function safeName(value, maxBytes = 256) {
  return safeString(value, maxBytes) !== undefined && !CONTROL_CHARACTERS.test(value)
    ? value
    : undefined
}

function safeProfileName(value) {
  if (safeName(value, 128) === undefined) return undefined
  if (value.includes('/') || value.includes('\\')) return undefined
  if (value === '.' || value === '..' || value === 'node_modules') return undefined
  return value
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  let end = low
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1
  return value.slice(0, end)
}

function nativeSessionId(value) {
  const id = typeof value === 'string' ? value : String(value ?? '')
  if (!SAFE_ID.test(id)) throw new Error('invalid session id')
  return id
}

function turnId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid turn id')
  return String(value)
}

function usageValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid usage')
  return value
}

function jsonSize(value) {
  let json
  try {
    json = JSON.stringify(value)
  } catch {
    throw new Error('invalid JSON value')
  }
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_INPUT) {
    throw new Error('JSON value exceeds bridge limit')
  }
  return value
}

function parseToolInput(value) {
  if (typeof value !== 'string') throw new Error('invalid tool arguments')
  const raw = truncateUtf8(value, MAX_INPUT)
  try {
    const parsed = JSON.parse(raw)
    if (!isPlainBridgeObject(parsed)) return { raw }
    return jsonSize(parsed)
  } catch {
    return jsonSize({ raw })
  }
}

function messageText(message) {
  if (!Array.isArray(message?.content)) throw new Error('invalid assistant message')
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text !== 'string') {
      throw new Error('invalid assistant text block')
    }
  }
  const text = message.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
  return truncateUtf8(text, MAX_EVENT_FIELD_BYTES)
}

function sessionCwd(session) {
  const cwd = session?.header?.cwd
  if (cwd === undefined) return undefined
  return safeString(cwd, MAX_PATH)
}

function modelFor(agent) {
  const model = agent?.options?.model
  if (model === undefined) return undefined
  return safeName(model)
}

function reasonStatus(reason) {
  const kind = reason?.kind
  return new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted']).has(kind)
    ? kind
    : 'error'
}

function encodeSemanticFrame(frame) {
  const targetBytes = DSH_BRIDGE_MAX_FRAME_BYTES - FRAME_RESERVE_BYTES
  let candidate = frame
  try {
    const encoded = encodeBridgeFrame(candidate)
    if (encoded.length <= targetBytes) return encoded
  } catch (error) {
    if (error?.code !== 'DSH_BRIDGE_FRAME_TOO_LARGE') throw error
  }
  if (isPlainBridgeObject(candidate.input)) {
    candidate = { ...candidate, input: { raw: '[input omitted: bridge frame limit]' } }
  }
  let fieldBytes = MAX_EVENT_FIELD_BYTES / 2
  while (fieldBytes >= 1024) {
    const reduced = { ...candidate }
    for (const field of ['text', 'markdown', 'command']) {
      if (typeof reduced[field] === 'string') reduced[field] = truncateUtf8(reduced[field], fieldBytes)
    }
    try {
      const encoded = encodeBridgeFrame(reduced)
      if (encoded.length <= targetBytes) return encoded
    } catch (error) {
      if (error?.code !== 'DSH_BRIDGE_FRAME_TOO_LARGE') throw error
    }
    fieldBytes = Math.floor(fieldBytes / 2)
  }
  throw new Error('semantic event exceeds bridge frame limit')
}

function createProjector(send) {
  const agents = new Map()
  const usageSamples = new Map()
  const countedTurns = new Set()
  const lastAssistant = new Map()

  const clearSessionState = (id) => {
    for (const key of [...usageSamples.keys()]) if (key.startsWith(`${id}:`)) usageSamples.delete(key)
    for (const key of [...countedTurns]) if (key.startsWith(`${id}:`)) countedTurns.delete(key)
    for (const key of [...lastAssistant.keys()]) if (key.startsWith(`${id}:`)) lastAssistant.delete(key)
  }

  const clearTurnState = (id, currentTurn) => {
    const prefix = `${id}:${currentTurn}`
    for (const key of [...usageSamples.keys()]) if (key.startsWith(`${prefix}:`)) usageSamples.delete(key)
    countedTurns.delete(prefix)
    lastAssistant.delete(prefix)
  }

  const rememberAgent = (agent) => {
    const id = nativeSessionId(agent?.session?.id ?? agent?.id)
    agents.set(id, agent)
    return id
  }

  const ready = (agent) => {
    const id = rememberAgent(agent)
    const frame = { type: 'session-ready', nativeSessionId: id }
    const cwd = sessionCwd(agent.session)
    const model = modelFor(agent)
    if (cwd !== undefined) frame.cwd = cwd
    if (model !== undefined) frame.model = model
    send(frame)
    if (agent.status === 'idle' || agent.status === 'running') {
      send({ type: 'agent-status', nativeSessionId: id, status: agent.status })
    }
  }

  const usage = (session, data, value) => {
    if (!isPlainBridgeObject(value)) throw new Error('invalid usage')
    const id = nativeSessionId(session.id)
    const source = `${id}:${turnId(data.turn)}:${String(data.step)}`
    const turn = `${id}:${turnId(data.turn)}`
    const inputTokens = usageValue(
      usageValue(value.inputTokens) +
      (value.cacheReadTokens === undefined ? 0 : usageValue(value.cacheReadTokens)) +
      (value.cacheWriteTokens === undefined ? 0 : usageValue(value.cacheWriteTokens))
    )
    const outputTokens = usageValue(value.outputTokens)
    const previous = usageSamples.get(source)
    if (previous && (inputTokens < previous.inputTokens || outputTokens < previous.outputTokens)) {
      throw new Error('usage sample regressed')
    }
    const inputDelta = inputTokens - (previous?.inputTokens ?? 0)
    const outputDelta = outputTokens - (previous?.outputTokens ?? 0)
    usageSamples.set(source, { inputTokens, outputTokens })
    if (previous && inputDelta === 0 && outputDelta === 0) return
    const frame = {
      type: 'usage',
      nativeSessionId: id,
      inputTokens: inputDelta,
      outputTokens: outputDelta,
      turns: countedTurns.has(turn) ? 0 : 1
    }
    countedTurns.add(turn)
    const model = modelFor(agents.get(id))
    if (model !== undefined) frame.model = model
    send(frame)
  }

  return {
    agentCreated({ agent }) {
      ready(agent)
    },
    agentDisposed({ agent }) {
      const id = nativeSessionId(agent?.session?.id ?? agent?.id)
      send({ type: 'agent-status', nativeSessionId: id, status: 'idle' })
      agents.delete(id)
    },
    agentStatus({ agent, status }) {
      if (status !== 'idle' && status !== 'running') throw new Error('invalid agent status')
      const id = rememberAgent(agent)
      send({ type: 'agent-status', nativeSessionId: id, status })
    },
    agentError({ agent }) {
      const id = rememberAgent(agent)
      send({
        type: 'attention',
        nativeSessionId: id,
        kind: 'question',
        operation: 'agent-error'
      })
    },
    sessionCreated(session) {
      nativeSessionId(session?.id)
    },
    sessionDisposed(session) {
      const id = nativeSessionId(session?.id)
      clearSessionState(id)
    },
    sessionEvent(session, event) {
      if (!isPlainBridgeObject(event) || !isPlainBridgeObject(event.data)) {
        throw new Error('invalid session event')
      }
      const id = nativeSessionId(session?.id)
      const data = event.data
      if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage') {
        usage(session, data, data.chunk.usage)
        return
      }
      if (event.type === 'assistant/message') {
        const text = messageText(data.message)
        const currentTurn = turnId(data.turn)
        lastAssistant.set(`${id}:${currentTurn}`, text)
        send({ type: 'assistant-committed', nativeSessionId: id, turnId: currentTurn, text })
        if (data.usage !== undefined) usage(session, data, data.usage)
        return
      }
      if (event.type === 'tool/call') {
        const requestId = safeString(String(data.callId ?? ''), 256, SAFE_ID)
        const tool = safeName(data.name)
        if (requestId === undefined || tool === undefined) throw new Error('invalid tool call')
        const input = parseToolInput(data.arguments)
        const frame = { type: 'tool-request', requestId, nativeSessionId: id, tool, input }
        const cwd = sessionCwd(session)
        if (cwd !== undefined) frame.cwd = cwd
        if (isPlainBridgeObject(input) && typeof input.command === 'string') {
          const command = safeString(truncateUtf8(input.command, MAX_COMMAND), MAX_COMMAND)
          if (command === undefined) throw new Error('invalid command')
          frame.command = command
        }
        send(frame)
        if (tool === 'exit_plan_mode' && isPlainBridgeObject(input) && typeof input.plan === 'string') {
          send({
            type: 'plan-snapshot',
            nativeSessionId: id,
            markdown: truncateUtf8(input.plan, MAX_EVENT_FIELD_BYTES)
          })
        }
        return
      }
      if (event.type === 'tool/result') {
        const sourceCallId = data.message?.source?.kind === 'tool'
          ? data.message.source.callId
          : undefined
        const resultBlock = Array.isArray(data.message?.content)
          ? data.message.content.find((block) => block?.type === 'tool-result')
          : undefined
        const blockCallId = resultBlock?.toolCallId
        if (sourceCallId !== blockCallId) throw new Error('mismatched tool result')
        const requestId = safeString(String(sourceCallId ?? ''), 256, SAFE_ID)
        if (requestId === undefined) throw new Error('invalid tool result')
        send({
          type: 'tool-result',
          requestId,
          nativeSessionId: id,
          status: data.error === undefined && resultBlock.isError !== true ? 'completed' : 'failed'
        })
        return
      }
      if (event.type === 'turn/end') {
        const currentTurn = turnId(data.turn)
        send({
          type: 'turn-complete',
          nativeSessionId: id,
          turnId: currentTurn,
          status: reasonStatus(data.reason)
        })
        const markdown = lastAssistant.get(`${id}:${currentTurn}`)
        if (markdown !== undefined) {
          send({ type: 'result-snapshot', nativeSessionId: id, markdown })
        }
        clearTurnState(id, currentTurn)
      }
    },
    ready
  }
}

export function apply(ctx, config = {}) {
  const endpoint = process.env.UCLI_DSH_BRIDGE_ENDPOINT
  const token = process.env.UCLI_DSH_BRIDGE_TOKEN
  const protocol = process.env.UCLI_DSH_BRIDGE_PROTOCOL
  if (!endpoint || !token || !protocol) return
  if (protocol !== String(PROTOCOL_VERSION) || !SAFE_TOKEN.test(token)) return
  const profileName = profileFromArgv(config.argv ?? process.argv)
  if (safeProfileName(profileName) === undefined) return

  ctx.effect(() => {
    let socket
    let state = 'connecting'
    let stopped = false
    let helloTimer = null
    const subscriptions = []
    const rootIds = new Set()

    const cleanupSubscriptions = () => {
      for (const dispose of subscriptions.splice(0).reverse()) {
        try { dispose() } catch { /* disposal remains fail-closed */ }
      }
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      state = 'closed'
      if (helloTimer !== null) {
        internals.clearTimeout(helloTimer)
        helloTimer = null
      }
      cleanupSubscriptions()
      socket?.removeAllListeners()
      socket?.destroy()
      socket = undefined
    }
    const send = (frame) => {
      if (state !== 'active' || !socket || socket.destroyed) throw new Error('bridge inactive')
      socket.write(encodeSemanticFrame(frame), (error) => {
        if (error) stop()
      })
    }
    const projector = createProjector(send)
    const rootSessionId = (agent) => String(agent?.session?.id ?? agent?.id ?? '')
    const rememberRoot = (agent) => {
      rootIds.add(rootSessionId(agent))
      projector.ready(agent)
    }
    const currentlyRoot = (agent) => ctx.agents.roots()
      .some((root) => root === agent || root.id === agent?.id)
    const guard = (listener) => (...args) => {
      try { listener(...args) } catch { stop() }
    }
    const subscribe = () => {
      if (state !== 'awaiting-ack' || stopped) return
      state = 'active'
      if (helloTimer !== null) {
        internals.clearTimeout(helloTimer)
        helloTimer = null
      }
      subscriptions.push(
        ctx.on('agent/created', guard((payload) => {
          if (currentlyRoot(payload.agent)) {
            rootIds.add(rootSessionId(payload.agent))
            projector.agentCreated(payload)
          }
        })),
        ctx.on('agent/disposed', guard((payload) => {
          if (rootIds.delete(rootSessionId(payload.agent))) projector.agentDisposed(payload)
        })),
        ctx.on('agent/status', guard((payload) => {
          if (rootIds.has(rootSessionId(payload.agent))) projector.agentStatus(payload)
        })),
        ctx.on('agent/error', guard((payload) => {
          if (rootIds.has(rootSessionId(payload.agent))) projector.agentError(payload)
        })),
        ctx.on('session/created', guard((session) => projector.sessionCreated(session))),
        ctx.on('session/disposed', guard((session) => projector.sessionDisposed(session))),
        ctx.on('session/event', guard((session, event) => {
          if (rootIds.has(String(session?.id))) projector.sessionEvent(session, event)
        }))
      )
      try {
        for (const agent of ctx.agents.roots()) rememberRoot(agent)
      } catch {
        stop()
      }
    }

    try {
      socket = internals.createConnection(endpoint)
    } catch {
      stop()
      return stop
    }
    const decoder = new BridgeFrameDecoder((frame) => {
      try {
        if (
          state !== 'awaiting-ack' ||
          !exactKeys(frame, ['type', 'protocolVersion']) ||
          frame.type !== 'hello-ack' ||
          frame.protocolVersion !== PROTOCOL_VERSION
        ) {
          stop()
          return
        }
        subscribe()
      } catch {
        stop()
      }
    })
    socket.once('connect', () => {
      if (stopped) return
      state = 'awaiting-ack'
      helloTimer = internals.setTimeout(stop, 10_000)
      try {
        socket.write(encodeBridgeFrame({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          token,
          bridgeVersion: BRIDGE_VERSION,
          profileName,
          surface: 'tui',
          capabilities: DSH_BRIDGE_CAPABILITIES
        }), (error) => {
          if (error) stop()
        })
      } catch {
        stop()
      }
    })
    socket.on('data', (chunk) => {
      try { decoder.push(chunk) } catch { stop() }
    })
    socket.once('error', stop)
    socket.once('close', stop)
    return stop
  })
}
