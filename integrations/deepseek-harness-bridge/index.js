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

export const internals = {
  createConnection,
  setTimeout,
  clearTimeout,
  loadCreateUserMessage: () => import('@deepseek-ai/dsh-llm/message')
    .then((module) => module.createUserMessage),
  loadSandboxPolicy: () => import('@deepseek-ai/dsh-sandbox-policy')
    .then(({ effectiveSandboxMode, setSandboxMode }) => ({ effectiveSandboxMode, setSandboxMode }))
}

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
    let state = 'initializing'
    let stopped = false
    let helloTimer = null
    let permissionSequence = 0
    let controlEpoch = 0
    let createUserMessagePromise
    let sandboxPolicy
    const subscriptions = []
    const permissionSubscriptions = []
    const rootIds = new Set()
    const pendingPermissions = new Map()
    const liveCallIds = new Set()
    const cancelledPermissionIds = new Set()
    const cancelledPermissionQueue = []
    const pendingControls = new Map()
    const seenControlIds = new Set()
    const seenControlQueue = []
    const sandboxPinning = new Set()
    const planSnapshots = new Map()
    const resultSnapshots = new Map()

    const cleanupSubscriptions = () => {
      for (const dispose of subscriptions.splice(0).reverse()) {
        try { dispose() } catch { /* disposal remains fail-closed */ }
      }
    }
    const cleanupPermissionSubscriptions = () => {
      for (const dispose of permissionSubscriptions.splice(0).reverse()) {
        try { dispose() } catch { /* disposal remains fail-closed */ }
      }
    }
    const settlePermission = (requestId, decision) => {
      const pending = pendingPermissions.get(requestId)
      if (!pending) return false
      pendingPermissions.delete(requestId)
      internals.clearTimeout(pending.timer)
      pending.signal?.removeEventListener('abort', pending.abort)
      pending.resolve(decision)
      return true
    }
    const sendCancel = (requestId) => {
      if (state !== 'active' || !socket || socket.destroyed) return
      try { socket.write(encodeBridgeFrame({ type: 'cancel', requestId })) } catch { /* already denied */ }
    }
    const rememberCancelledPermission = (requestId) => {
      cancelledPermissionIds.add(requestId)
      cancelledPermissionQueue.push(requestId)
      if (cancelledPermissionQueue.length > 1_024) {
        cancelledPermissionIds.delete(cancelledPermissionQueue.shift())
      }
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      controlEpoch += 1
      state = 'closed'
      if (helloTimer !== null) {
        internals.clearTimeout(helloTimer)
        helloTimer = null
      }
      for (const requestId of [...pendingPermissions.keys()]) {
        settlePermission(requestId, {
          kind: 'deny', reason: 'UCLI permission bridge disconnected'
        })
      }
      liveCallIds.clear()
      cancelledPermissionIds.clear()
      cancelledPermissionQueue.length = 0
      for (const pending of pendingControls.values()) pending.controller.abort()
      pendingControls.clear()
      seenControlIds.clear()
      seenControlQueue.length = 0
      planSnapshots.clear()
      resultSnapshots.clear()
      cleanupSubscriptions()
      socket?.removeAllListeners()
      socket?.destroy()
      socket = undefined
    }
    const send = (frame) => {
      if (state !== 'active' || !socket || socket.destroyed) throw new Error('bridge inactive')
      if (frame.type === 'plan-snapshot') planSnapshots.set(frame.nativeSessionId, frame.markdown)
      if (frame.type === 'result-snapshot') resultSnapshots.set(frame.nativeSessionId, frame.markdown)
      socket.write(encodeSemanticFrame(frame), (error) => {
        if (error) stop()
      })
    }
    const sendControlResponse = (frame) => {
      if (state !== 'active' || !socket || socket.destroyed) return
      try {
        socket.write(encodeBridgeFrame(frame), (error) => { if (error) stop() })
      } catch {
        stop()
      }
    }
    const projector = createProjector(send)
    const rootSessionId = (agent) => String(agent?.session?.id ?? agent?.id ?? '')
    const isContinuation = (agent) => agent?.session?.header?.origin === 'subagent'
    const semanticRoots = () => ctx.agents.roots().filter((agent) => !isContinuation(agent))
    const rememberRoot = (agent) => {
      rootIds.add(rootSessionId(agent))
      projector.ready(agent)
    }
    const currentlyRoot = (agent) => semanticRoots()
      .some((root) => root === agent || root.id === agent?.id)
    const lookupAgent = (id) => ctx.agents.get?.(id) ?? ctx.agents.list()
      .find((agent) => agent?.id === id || agent?.session?.id === id)
    const semanticRootFor = (agent) => {
      if (!agent) throw new Error('agent unavailable')
      let current = agent
      const seen = new Set()
      for (let depth = 0; depth < 32; depth += 1) {
        const id = rootSessionId(current)
        if (!id || seen.has(id)) throw new Error('agent lineage invalid')
        if (current?.id !== current?.session?.id || lookupAgent(current.id) !== current) {
          throw new Error('agent identity invalid')
        }
        seen.add(id)
        if (isContinuation(current)) {
          const parentId = current.session?.header?.parentSession
          if (typeof parentId !== 'string' || parentId.length === 0) throw new Error('agent lineage unavailable')
          current = lookupAgent(parentId)
          if (!current) throw new Error('agent lineage unavailable')
          continue
        }
        const roots = semanticRoots().filter((root) => root === current || root.id === current.id)
        if (roots.length === 1) return roots[0]
        const owners = ctx.agents.list().filter((candidate) => (
          candidate !== current && ctx.agents.isOwnedBy?.(current.id, candidate)
        ))
        if (owners.length !== 1) throw new Error('agent lineage ambiguous')
        current = owners[0]
      }
      throw new Error('agent lineage too deep')
    }
    const pinSandbox = (agent) => {
      if (!sandboxPolicy || !agent?.session) throw new Error('sandbox policy unavailable')
      const sessionId = rootSessionId(agent)
      if (!sessionId || sandboxPinning.has(sessionId)) return
      if (sandboxPolicy.effectiveSandboxMode(agent.session.events ?? []) === 'workspace-write') return
      sandboxPinning.add(sessionId)
      try { sandboxPolicy.setSandboxMode(agent.session, 'workspace-write') }
      finally { sandboxPinning.delete(sessionId) }
    }
    const guard = (listener) => (...args) => {
      try { listener(...args) } catch { stop() }
    }
    const normalizeExecutionInput = (value) => {
      if (isPlainBridgeObject(value)) return jsonSize(value)
      let raw
      try { raw = JSON.stringify(value) } catch { raw = undefined }
      if (typeof raw !== 'string') throw new Error('invalid tool input')
      return jsonSize({ raw: truncateUtf8(raw, MAX_INPUT) })
    }
    const requestPermission = (params, signal) => {
      if (state !== 'active' || !socket || socket.destroyed) {
        return Promise.resolve({ kind: 'deny', reason: 'UCLI permission bridge disconnected' })
      }
      permissionSequence += 1
      const requestId = `plugin-rpc:${permissionSequence}`
      return new Promise((resolve) => {
        const finish = (decision) => settlePermission(requestId, decision)
        const abort = () => {
          if (!finish({ kind: 'deny', reason: 'UCLI permission request cancelled' })) return
          rememberCancelledPermission(requestId)
          sendCancel(requestId)
        }
        const timer = internals.setTimeout(() => {
          if (!finish({ kind: 'deny', reason: 'UCLI permission request timed out' })) return
          rememberCancelledPermission(requestId)
          sendCancel(requestId)
        }, 30_000)
        pendingPermissions.set(requestId, { resolve, timer, signal, abort })
        if (signal?.aborted) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
        try {
          socket.write(encodeBridgeFrame({
            type: 'request', requestId, method: 'permission.decide', params
          }), (error) => {
            if (error && finish({ kind: 'deny', reason: 'UCLI permission bridge disconnected' })) stop()
          })
        } catch {
          finish({ kind: 'deny', reason: 'UCLI permission bridge disconnected' })
          stop()
        }
      })
    }
    const permissionGate = async function (exec, next) {
      if (state !== 'active' || stopped || !socket || socket.destroyed) {
        return { kind: 'deny', reason: 'UCLI permission bridge disconnected' }
      }
      let downstream
      try { downstream = await next() } catch {
        return { kind: 'deny', reason: 'DSH permission policy unavailable' }
      }
      if (downstream?.kind === 'deny') return downstream
      if (downstream?.kind !== 'allow' && downstream?.kind !== 'ask') {
        return { kind: 'deny', reason: 'DSH permission policy unavailable' }
      }
      const input = normalizeExecutionInput(exec?.arguments)
      if (Object.hasOwn(input, 'sandbox_permissions')) {
        return { kind: 'deny', reason: 'DSH sandbox escalation is not allowed by UCLI' }
      }
      const callId = safeString(String(exec?.callId ?? ''), 256, SAFE_ID)
      const rootCallId = safeString(String(exec?.rootCallId ?? exec?.callId ?? ''), 256, SAFE_ID)
      const toolName = safeName(exec?.name)
      if (!callId || !rootCallId || !toolName) return { kind: 'deny', reason: 'Invalid DSH tool execution' }
      if (toolName === 'run_code' && exec?.parent === undefined) {
        return downstream.kind === 'allow'
          ? { kind: 'allow' }
          : { kind: 'deny', reason: 'Code Mode wrapper approval is not delegated' }
      }
      const actorId = safeString(String(exec?.agent?.id ?? ''), 256, SAFE_ID)
      if (!actorId) return { kind: 'deny', reason: 'Invalid DSH tool actor' }
      const liveCallKey = `${actorId}:${callId}`
      if (liveCallIds.has(liveCallKey)) return { kind: 'deny', reason: 'Duplicate DSH tool call identity' }
      liveCallIds.add(liveCallKey)
      try {
        const root = semanticRootFor(exec?.agent)
        const frame = {
          actor: {
            nativeSessionId: nativeSessionId(root.session?.id),
            agentId: nativeSessionId(exec.agent?.id ?? exec.agent?.session?.id),
            subagent: exec.agent !== root
          },
          call: { callId, rootCallId, nested: exec?.parent !== undefined },
          tool: { name: toolName },
          input,
          approvalRequired: downstream.kind === 'ask'
        }
        const cwd = sessionCwd(root.session)
        if (cwd !== undefined) frame.cwd = cwd
        const decision = await requestPermission(frame, exec?.signal)
        if (decision.kind === 'allow') return { kind: 'allow' }
        return { kind: 'deny', reason: decision.reason || 'Denied by UCLI' }
      } catch {
        return { kind: 'deny', reason: 'UCLI permission actor unavailable' }
      } finally {
        liveCallIds.delete(liveCallKey)
      }
    }
    const approvalAnswerer = async function (_request, _next) {
      return 'rejected'
    }
    const controlRoots = (nativeId) => semanticRoots()
      .filter((agent) => (
        rootSessionId(agent) === nativeId && agent?.id === agent?.session?.id
      ))
    const exactControlParams = (params, keys) => exactKeys(params, keys)
    const handleControlRequest = async (frame, epoch, signal) => {
      if (
        !exactKeys(frame, ['method', 'params', 'requestId', 'type']) ||
        frame.type !== 'request' || !SAFE_ID.test(frame.requestId || '') ||
        !isPlainBridgeObject(frame.params)
      ) {
        stop()
        return
      }
      const fail = (code) => sendControlResponse({
        type: 'response', requestId: frame.requestId,
        error: { code, message: 'DSH bridge control failed' }
      })
      try {
        if (stopped || state !== 'active' || epoch !== controlEpoch || signal.aborted) return
        if (frame.method === 'turn.send') {
          if (
            !exactControlParams(frame.params, ['nativeSessionId', 'text']) ||
            !SAFE_ID.test(frame.params.nativeSessionId || '') ||
            safeString(frame.params.text, MAX_EVENT_FIELD_BYTES) === undefined
          ) return fail('DSH_BRIDGE_REQUEST_INVALID')
          const roots = controlRoots(frame.params.nativeSessionId)
          if (roots.length === 0) return fail('DSH_ROOT_AGENT_NOT_FOUND')
          if (roots.length > 1) return fail('DSH_ROOT_AGENT_AMBIGUOUS')
          if (!createUserMessagePromise) {
            createUserMessagePromise = Promise.resolve().then(() => internals.loadCreateUserMessage())
          }
          let createUserMessage
          try { createUserMessage = await createUserMessagePromise } catch {
            return fail('DSH_BRIDGE_RUNTIME_UNAVAILABLE')
          }
          if (stopped || state !== 'active' || epoch !== controlEpoch || signal.aborted) return
          if (typeof createUserMessage !== 'function') return fail('DSH_BRIDGE_RUNTIME_UNAVAILABLE')
          const freshRoots = controlRoots(frame.params.nativeSessionId)
          if (freshRoots.length === 0) return fail('DSH_ROOT_AGENT_NOT_FOUND')
          if (freshRoots.length > 1) return fail('DSH_ROOT_AGENT_AMBIGUOUS')
          const message = createUserMessage({
            content: [{ type: 'text', text: frame.params.text }],
            source: { kind: 'user' }
          })
          if (stopped || state !== 'active' || epoch !== controlEpoch || signal.aborted) return
          try { freshRoots[0].followup(message) } catch { return fail('DSH_TURN_SEND_FAILED') }
          sendControlResponse({
            type: 'response', requestId: frame.requestId, result: { accepted: true }
          })
          return
        }
        if (frame.method === 'turn.interrupt') {
          if (
            !exactControlParams(frame.params, ['nativeSessionId']) ||
            !SAFE_ID.test(frame.params.nativeSessionId || '')
          ) return fail('DSH_BRIDGE_REQUEST_INVALID')
          const roots = controlRoots(frame.params.nativeSessionId)
          if (roots.length === 0) return fail('DSH_ROOT_AGENT_NOT_FOUND')
          if (roots.length > 1) return fail('DSH_ROOT_AGENT_AMBIGUOUS')
          try { roots[0].cancel({ kind: 'user' }) } catch { return fail('DSH_TURN_INTERRUPT_FAILED') }
          sendControlResponse({
            type: 'response', requestId: frame.requestId, result: { accepted: true }
          })
          return
        }
        if (frame.method === 'snapshot.plan' || frame.method === 'snapshot.result') {
          if (
            !exactControlParams(frame.params, ['nativeSessionId']) ||
            !SAFE_ID.test(frame.params.nativeSessionId || '')
          ) return fail('DSH_BRIDGE_REQUEST_INVALID')
          const snapshots = frame.method === 'snapshot.plan' ? planSnapshots : resultSnapshots
          const markdown = snapshots.get(frame.params.nativeSessionId)
          if (markdown === undefined) return fail('DSH_SNAPSHOT_UNAVAILABLE')
          sendControlResponse({
            type: 'response', requestId: frame.requestId, result: { markdown }
          })
          return
        }
        fail('DSH_BRIDGE_REQUEST_METHOD_UNSUPPORTED')
      } catch {
        fail('DSH_BRIDGE_REQUEST_INVALID')
      }
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
          pinSandbox(payload.agent)
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
        ctx.on('session/disposed', guard((session) => {
          projector.sessionDisposed(session)
          planSnapshots.delete(String(session?.id))
          resultSnapshots.delete(String(session?.id))
        })),
        ctx.on('session/event', guard((session, event) => {
          if (event?.type === 'sandbox/mode') {
            const agent = lookupAgent(String(session?.id ?? ''))
            if (!agent || agent.session !== session) throw new Error('sandbox session unavailable')
            pinSandbox(agent)
          }
          if (rootIds.has(String(session?.id))) projector.sessionEvent(session, event)
        }))
      )
      try {
        for (const agent of ctx.agents.list()) pinSandbox(agent)
        for (const agent of semanticRoots()) rememberRoot(agent)
      } catch {
        stop()
      }
    }
    const decoder = new BridgeFrameDecoder((frame) => {
      try {
        if (state === 'awaiting-ack') {
          if (
            !exactKeys(frame, ['type', 'protocolVersion']) ||
            frame.type !== 'hello-ack' || frame.protocolVersion !== PROTOCOL_VERSION
          ) return stop()
          subscribe()
          return
        }
        if (state !== 'active') return stop()
        if (frame.type === 'response') {
          if (
            !exactKeys(frame, ['requestId', 'result', 'type']) ||
            !isPlainBridgeObject(frame.result) ||
            !exactKeys(frame.result, frame.result.reason === undefined ? ['kind'] : ['kind', 'reason']) ||
            !['allow', 'deny'].includes(frame.result.kind) ||
            (frame.result.reason !== undefined && safeString(frame.result.reason, 4_096) === undefined)
          ) return stop()
          if (settlePermission(frame.requestId, frame.result)) return
          if (cancelledPermissionIds.delete(frame.requestId)) return
          stop()
          return
        }
        if (frame.type === 'cancel') {
          if (!exactKeys(frame, ['requestId', 'type']) || !SAFE_ID.test(frame.requestId || '')) {
            return stop()
          }
          const pending = pendingControls.get(frame.requestId)
          if (!pending) {
            if (seenControlIds.has(frame.requestId)) return
            return stop()
          }
          pendingControls.delete(frame.requestId)
          pending.controller.abort()
          return
        }
        if (frame.type === 'request') {
          if (
            !SAFE_ID.test(frame.requestId || '') || seenControlIds.has(frame.requestId) ||
            pendingControls.has(frame.requestId) ||
            pendingControls.size >= 64
          ) return stop()
          seenControlIds.add(frame.requestId)
          seenControlQueue.push(frame.requestId)
          if (seenControlQueue.length > 1_024) {
            seenControlIds.delete(seenControlQueue.shift())
          }
          const epoch = controlEpoch
          const controller = new AbortController()
          const pending = { controller, epoch }
          pendingControls.set(frame.requestId, pending)
          void handleControlRequest(frame, epoch, controller.signal).finally(() => {
            if (pendingControls.get(frame.requestId) === pending) pendingControls.delete(frame.requestId)
          })
          return
        }
        stop()
      } catch {
        stop()
      }
    })
    const connect = () => {
      if (stopped) return
      state = 'connecting'
      try { socket = internals.createConnection(endpoint) } catch { return stop() }
      socket.once('connect', () => {
        if (stopped) return
        state = 'awaiting-ack'
        helloTimer = internals.setTimeout(stop, 10_000)
        try {
          socket.write(encodeBridgeFrame({
            type: 'hello', protocolVersion: PROTOCOL_VERSION, token,
            bridgeVersion: BRIDGE_VERSION, profileName, surface: 'tui',
            capabilities: DSH_BRIDGE_CAPABILITIES
          }), (error) => { if (error) stop() })
        } catch { stop() }
      })
      socket.on('data', (chunk) => {
        try { decoder.push(chunk) } catch { stop() }
      })
      socket.once('error', stop)
      socket.once('close', stop)
    }
    permissionSubscriptions.push(
      ctx.on('tools/pre-execute', permissionGate, { prepend: true }),
      ctx.on('approval/request', approvalAnswerer, { prepend: true })
    )
    Promise.resolve()
      .then(() => internals.loadSandboxPolicy())
      .then((loaded) => {
        if (stopped) return
        if (
          !loaded || typeof loaded.effectiveSandboxMode !== 'function' ||
          typeof loaded.setSandboxMode !== 'function'
        ) throw new Error('sandbox policy unavailable')
        sandboxPolicy = loaded
        for (const agent of ctx.agents.list()) pinSandbox(agent)
        connect()
      })
      .catch(stop)
    return () => {
      stop()
      cleanupPermissionSubscriptions()
    }
  })
}
