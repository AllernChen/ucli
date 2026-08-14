import { randomBytes as cryptoRandomBytes, randomUUID as cryptoRandomUUID, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import { promises as defaultFsPromises } from 'node:fs'
import { createServer as defaultCreateServer } from 'node:net'
import { tmpdir as defaultTmpdir } from 'node:os'
import path from 'node:path'

import { normalizeDshSessionConfig } from './adapterSessionConfig.js'
import {
  BridgeFrameDecoder,
  DSH_BRIDGE_HANDSHAKE_TIMEOUT_MS,
  DSH_BRIDGE_PROTOCOL,
  createDshBridgeError,
  encodeBridgeFrame,
  isPlainBridgeObject
} from './dshBridgeProtocol.js'

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

export const DSH_BRIDGE_MAX_PENDING_REQUESTS = 64

const CAPABILITY_KEYS = Object.freeze(Object.keys(DSH_BRIDGE_CAPABILITIES))
const HELLO_KEYS = Object.freeze([
  'bridgeVersion',
  'capabilities',
  'profileName',
  'protocolVersion',
  'surface',
  'token',
  'type'
])
const REQUEST_METHODS = new Set([
  'turn.send',
  'turn.interrupt',
  'snapshot.plan',
  'snapshot.result'
])
const SEMANTIC_EVENT_TYPES = new Set([
  'session-ready',
  'agent-status',
  'assistant-committed',
  'tool-request',
  'tool-result',
  'usage',
  'turn-complete',
  'attention',
  'plan-snapshot',
  'result-snapshot'
])
const AGENT_STATUSES = new Set(['idle', 'running'])
const TOOL_RESULT_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const TURN_STATUSES = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted'])
const ATTENTION_KINDS = new Set(['approval', 'question'])
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const SAFE_REQUEST_ID = /^[\x21-\x7e]{1,256}$/u
const SAFE_SEMANTIC_ID = /^[\x21-\x7e]{1,256}$/u
const SEMANTIC_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const MAX_EVENT_FIELD_BYTES = 768 * 1024
const SAFE_REMOTE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u
const SAFE_RANDOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const SENSITIVE_CREDENTIAL_KEYS = new Set([
  'token',
  'bridgetoken',
  'apitoken',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'secret',
  'clientsecret',
  'password',
  'privatekey'
])

function bridgeError(code, message = code) {
  return createDshBridgeError(code, message)
}

function exactKeys(value, expected) {
  if (!isPlainBridgeObject(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key)
}

function exactRequiredOptionalKeys(value, required, optional = []) {
  if (!isPlainBridgeObject(value)) return false
  const allowed = new Set([...required, ...optional])
  const actual = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key))
}

function boundedUtf8(value, maxBytes, { allowNewlines = true } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) {
    return false
  }
  return allowNewlines || !/[\r\n]/u.test(value)
}

function boundedSemanticName(value, maxBytes = 256) {
  return boundedUtf8(value, maxBytes) && value.length > 0 && !SEMANTIC_CONTROL_CHARACTERS.test(value)
}

function boundedJson(value, maxBytes) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    return false
  }
  return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= maxBytes
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validateSemanticEvent(frame) {
  if (!SEMANTIC_EVENT_TYPES.has(frame.type)) return false
  const id = () => SAFE_SEMANTIC_ID.test(frame.nativeSessionId || '')
  switch (frame.type) {
    case 'session-ready':
      return exactRequiredOptionalKeys(frame, ['type', 'nativeSessionId'], ['cwd', 'model']) &&
        id() &&
        (frame.cwd === undefined || (boundedUtf8(frame.cwd, 4_096, { allowNewlines: false }))) &&
        (frame.model === undefined || boundedSemanticName(frame.model))
    case 'agent-status':
      return exactKeys(frame, ['nativeSessionId', 'status', 'type']) &&
        id() && AGENT_STATUSES.has(frame.status)
    case 'assistant-committed':
      return exactKeys(frame, ['nativeSessionId', 'text', 'turnId', 'type']) &&
        id() && SAFE_SEMANTIC_ID.test(frame.turnId || '') && boundedUtf8(frame.text, MAX_EVENT_FIELD_BYTES)
    case 'tool-request':
      return exactRequiredOptionalKeys(
        frame,
        ['type', 'requestId', 'nativeSessionId', 'tool', 'input'],
        ['cwd', 'command']
      ) &&
        id() && SAFE_SEMANTIC_ID.test(frame.requestId || '') && boundedSemanticName(frame.tool) &&
        isPlainBridgeObject(frame.input) && boundedJson(frame.input, MAX_EVENT_FIELD_BYTES) &&
        (frame.cwd === undefined || boundedUtf8(frame.cwd, 4_096, { allowNewlines: false })) &&
        (frame.command === undefined || boundedUtf8(frame.command, 32_768))
    case 'tool-result':
      return exactKeys(frame, ['nativeSessionId', 'requestId', 'status', 'type']) &&
        id() && SAFE_SEMANTIC_ID.test(frame.requestId || '') && TOOL_RESULT_STATUSES.has(frame.status)
    case 'usage':
      return exactRequiredOptionalKeys(
        frame,
        ['type', 'nativeSessionId', 'inputTokens', 'outputTokens', 'turns'],
        ['model']
      ) &&
        id() && nonNegativeSafeInteger(frame.inputTokens) &&
        nonNegativeSafeInteger(frame.outputTokens) && nonNegativeSafeInteger(frame.turns) &&
        (frame.model === undefined || boundedSemanticName(frame.model))
    case 'turn-complete':
      return exactKeys(frame, ['nativeSessionId', 'status', 'turnId', 'type']) &&
        id() && SAFE_SEMANTIC_ID.test(frame.turnId || '') && TURN_STATUSES.has(frame.status)
    case 'attention':
      return exactKeys(frame, ['kind', 'nativeSessionId', 'operation', 'type']) &&
        id() && ATTENTION_KINDS.has(frame.kind) && boundedSemanticName(frame.operation)
    case 'plan-snapshot':
    case 'result-snapshot':
      return exactKeys(frame, ['markdown', 'nativeSessionId', 'type']) &&
        id() && boundedUtf8(frame.markdown, MAX_EVENT_FIELD_BYTES)
    default:
      return false
  }
}

function isMissingPath(error) {
  return error?.code === 'ENOENT'
}

function isNonEmptyDirectory(error) {
  return error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST'
}

function expectedUid(getUid) {
  if (typeof getUid !== 'function') return null
  const uid = getUid()
  return Number.isInteger(uid) ? uid : null
}

function ownedByCurrentUser(stat, getUid) {
  const uid = expectedUid(getUid)
  return uid === null || stat.uid === uid
}

function unsafeEndpoint() {
  return bridgeError('DSH_BRIDGE_ENDPOINT_UNSAFE', 'Unsafe DSH bridge endpoint')
}

function validateDescriptor({ endpoint, socketRoot, tempDirectory }) {
  const expectedRoot = path.posix.resolve(tempDirectory, 'ucli-dsh')
  const resolvedRoot = path.posix.resolve(socketRoot || '')
  const resolvedEndpoint = path.posix.resolve(endpoint || '')
  if (
    resolvedRoot !== expectedRoot ||
    path.posix.dirname(resolvedEndpoint) !== expectedRoot ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sock$/u.test(path.posix.basename(resolvedEndpoint))
  ) {
    throw unsafeEndpoint()
  }
  return { expectedRoot, resolvedEndpoint }
}

async function assertPrivateRoot(expectedRoot, fsPromises, getUid, checkMode = true) {
  const stat = await fsPromises.lstat(expectedRoot)
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat, getUid)) {
    throw unsafeEndpoint()
  }
  const realRoot = path.posix.resolve(await fsPromises.realpath(expectedRoot))
  if (realRoot !== expectedRoot) throw unsafeEndpoint()
  if (checkMode && (!Number.isInteger(stat.mode) || (stat.mode & 0o777) !== 0o700)) {
    throw unsafeEndpoint()
  }
}

async function assertPrivateSocket(endpoint, fsPromises, getUid, checkMode = false) {
  const stat = await fsPromises.lstat(endpoint)
  if (stat.isSymbolicLink() || !stat.isSocket() || !ownedByCurrentUser(stat, getUid)) {
    throw unsafeEndpoint()
  }
  const realEndpoint = path.posix.resolve(await fsPromises.realpath(endpoint))
  if (realEndpoint !== endpoint) throw unsafeEndpoint()
  if (checkMode && (!Number.isInteger(stat.mode) || (stat.mode & 0o777) !== 0o600)) {
    throw unsafeEndpoint()
  }
}

async function prepareSocketRoot(descriptor, fsPromises, getUid) {
  const { expectedRoot } = validateDescriptor(descriptor)
  await fsPromises.mkdir(expectedRoot, { recursive: true, mode: 0o700 })
  await assertPrivateRoot(expectedRoot, fsPromises, getUid, false)
  await fsPromises.chmod(expectedRoot, 0o700)
  await assertPrivateRoot(expectedRoot, fsPromises, getUid, true)
}

export function createDshBridgeEndpoint({
  platform = process.platform,
  tempDirectory = defaultTmpdir(),
  randomId = cryptoRandomUUID(),
  sessionId: _sessionId
} = {}) {
  if (!SAFE_RANDOM_ID.test(randomId)) throw unsafeEndpoint()
  if (platform === 'win32') {
    return {
      endpoint: `\\\\.\\pipe\\ucli-dsh-${randomId}`,
      socketRoot: null
    }
  }

  const socketRoot = path.posix.resolve(tempDirectory, 'ucli-dsh')
  return {
    endpoint: path.posix.join(socketRoot, `${randomId}.sock`),
    socketRoot
  }
}

export async function removeDshBridgeEndpoint({
  endpoint,
  socketRoot,
  tempDirectory = defaultTmpdir(),
  platform = process.platform,
  fsPromises = defaultFsPromises,
  getUid = process.getuid
}) {
  if (platform === 'win32') return
  const { expectedRoot, resolvedEndpoint } = validateDescriptor({ endpoint, socketRoot, tempDirectory })

  try {
    await assertPrivateRoot(expectedRoot, fsPromises, getUid, true)
  } catch (error) {
    if (isMissingPath(error)) return
    throw error
  }

  try {
    await assertPrivateSocket(resolvedEndpoint, fsPromises, getUid, false)
  } catch (error) {
    if (!isMissingPath(error)) throw error
  }

  try {
    await fsPromises.unlink(resolvedEndpoint)
  } catch (error) {
    if (!isMissingPath(error)) throw error
  }
  try {
    await fsPromises.rmdir(expectedRoot)
  } catch (error) {
    if (!isMissingPath(error) && !isNonEmptyDirectory(error)) throw error
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  promise.catch(() => {})
  return { promise, resolve, reject, settled: false }
}

function tokensMatch(received, expected, timingSafeEqual) {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const receivedText = typeof received === 'string' ? received : ''
  const receivedBytes = Buffer.alloc(expectedBytes.length)
  Buffer.from(receivedText, 'utf8').copy(receivedBytes, 0, 0, expectedBytes.length)
  const equal = timingSafeEqual(receivedBytes, expectedBytes)
  return equal && Buffer.byteLength(receivedText, 'utf8') === expectedBytes.length
}

function hasExactCapabilities(capabilities) {
  if (!isPlainBridgeObject(capabilities)) return false
  const keys = Object.keys(capabilities).sort()
  return keys.length === CAPABILITY_KEYS.length &&
    CAPABILITY_KEYS.slice().sort().every((key, index) => keys[index] === key) &&
    CAPABILITY_KEYS.every((key) => capabilities[key] === DSH_BRIDGE_CAPABILITIES[key])
}

function validateHello(frame, token, profileName, timingSafeEqual) {
  if (frame.type !== 'hello' || !tokensMatch(frame.token, token, timingSafeEqual)) {
    throw bridgeError('DSH_BRIDGE_AUTH_FAILED', 'DSH bridge authentication failed')
  }
  if (frame.protocolVersion !== DSH_BRIDGE_PROTOCOL) {
    throw bridgeError('DSH_BRIDGE_PROTOCOL_UNSUPPORTED', 'Unsupported DSH bridge protocol')
  }
  if (
    !exactKeys(frame, HELLO_KEYS) ||
    typeof frame.bridgeVersion !== 'string' ||
    Buffer.byteLength(frame.bridgeVersion, 'utf8') === 0 ||
    Buffer.byteLength(frame.bridgeVersion, 'utf8') > 64 ||
    frame.profileName !== profileName ||
    frame.surface !== 'tui' ||
    !hasExactCapabilities(frame.capabilities)
  ) {
    throw bridgeError('DSH_BRIDGE_HELLO_INVALID', 'Invalid DSH bridge hello')
  }
}

function normalizeHello(frame) {
  return Object.freeze({
    bridgeVersion: frame.bridgeVersion,
    profileName: frame.profileName,
    surface: frame.surface,
    capabilities: Object.freeze({ ...frame.capabilities })
  })
}

function containsCredential(value, sensitiveValues) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (sensitiveValues.some((sensitiveValue) => current.includes(sensitiveValue))) return true
      continue
    }
    if (current === null || typeof current !== 'object') continue
    for (const [key, child] of Object.entries(current)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
      if (SENSITIVE_CREDENTIAL_KEYS.has(normalizedKey)) return true
      pending.push(child)
    }
  }
  return false
}

function validateResponse(frame) {
  if (frame.type !== 'response' || !SAFE_REQUEST_ID.test(frame.requestId || '')) return false
  const hasResult = Object.hasOwn(frame, 'result')
  const hasError = Object.hasOwn(frame, 'error')
  if (hasResult === hasError) return false
  if (hasResult) return exactKeys(frame, ['requestId', 'result', 'type'])
  return exactKeys(frame, ['error', 'requestId', 'type']) &&
    exactKeys(frame.error, ['code', 'message']) &&
    typeof frame.error.code === 'string' &&
    typeof frame.error.message === 'string'
}

function validatePermissionRequest(frame) {
  if (
    !exactKeys(frame, ['method', 'params', 'requestId', 'type']) ||
    frame.type !== 'request' || frame.method !== 'permission.decide' ||
    !SAFE_REQUEST_ID.test(frame.requestId || '') ||
    !exactRequiredOptionalKeys(
      frame.params,
      ['actor', 'call', 'tool', 'input', 'approvalRequired'],
      ['cwd']
    )
  ) return false
  const { actor, call, tool, input, cwd, approvalRequired } = frame.params
  return exactKeys(actor, ['agentId', 'nativeSessionId', 'subagent']) &&
    SAFE_SEMANTIC_ID.test(actor.nativeSessionId || '') &&
    SAFE_SEMANTIC_ID.test(actor.agentId || '') && typeof actor.subagent === 'boolean' &&
    exactKeys(call, ['callId', 'nested', 'rootCallId']) &&
    SAFE_SEMANTIC_ID.test(call.callId || '') && SAFE_SEMANTIC_ID.test(call.rootCallId || '') &&
    typeof call.nested === 'boolean' &&
    exactKeys(tool, ['name']) && boundedSemanticName(tool.name) &&
    isPlainBridgeObject(input) && boundedJson(input, MAX_EVENT_FIELD_BYTES) &&
    typeof approvalRequired === 'boolean' &&
    (cwd === undefined || boundedUtf8(cwd, 4_096, { allowNewlines: false }))
}

function validatePermissionDecision(value) {
  if (!exactRequiredOptionalKeys(value, ['kind'], ['reason'])) return false
  if (value.kind !== 'allow' && value.kind !== 'deny') return false
  return value.reason === undefined || boundedUtf8(value.reason, 4_096)
}

function validateOutboundRequestParams(method, params) {
  if (method === 'turn.send') {
    return exactKeys(params, ['nativeSessionId', 'text']) &&
      SAFE_SEMANTIC_ID.test(params.nativeSessionId || '') &&
      boundedUtf8(params.text, MAX_EVENT_FIELD_BYTES) && params.text.length > 0
  }
  if (method === 'turn.interrupt') {
    return exactKeys(params, ['nativeSessionId']) && SAFE_SEMANTIC_ID.test(params.nativeSessionId || '')
  }
  if (method === 'snapshot.plan' || method === 'snapshot.result') {
    return exactKeys(params, ['nativeSessionId']) && SAFE_SEMANTIC_ID.test(params.nativeSessionId || '')
  }
  return false
}

function sanitizeRemoteError(error) {
  const code = SAFE_REMOTE_ERROR_CODE.test(error.code)
    ? error.code
    : 'DSH_BRIDGE_REQUEST_FAILED'
  return bridgeError(code, 'DSH bridge request failed')
}

function closeNetServer(server) {
  return new Promise((resolve, reject) => {
    const complete = (error) => {
      if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') resolve()
      else reject(error)
    }
    try {
      server.close(complete)
    } catch (error) {
      complete(error)
    }
  })
}

async function closeNetServerAfterStartupFailure(server) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await closeNetServer(server)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function localErrorCode(error) {
  return typeof error?.code === 'string' && SAFE_REMOTE_ERROR_CODE.test(error.code)
    ? error.code
    : 'UNKNOWN'
}

function serverCloseError(error) {
  const result = bridgeError('DSH_BRIDGE_SERVER_CLOSE_FAILED', 'DSH bridge server close failed')
  result.closeCode = localErrorCode(error)
  return result
}

function startupCleanupError(startupError, closeError) {
  const result = bridgeError(
    'DSH_BRIDGE_STARTUP_CLEANUP_FAILED',
    'DSH bridge startup failed and server close failed'
  )
  result.startupCode = localErrorCode(startupError)
  result.closeCode = localErrorCode(closeError)
  return result
}

export async function createDshBridgeServer({
  sessionId,
  profileName,
  onEvent,
  platform = process.platform,
  tempDirectory = defaultTmpdir(),
  randomBytes = cryptoRandomBytes,
  randomUUID = cryptoRandomUUID,
  timingSafeEqual = cryptoTimingSafeEqual,
  createServer = defaultCreateServer,
  fsPromises = defaultFsPromises,
  getUid = process.getuid,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  handshakeTimeoutMs = DSH_BRIDGE_HANDSHAKE_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  onPermissionRequest
} = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required')
  const normalizedProfile = normalizeDshSessionConfig({ profileName, surfacePreference: 'tui' }).profileName
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function')

  const endpointTempDirectory = platform === 'win32'
    ? tempDirectory
    : path.posix.resolve(await fsPromises.realpath(tempDirectory))

  const descriptor = createDshBridgeEndpoint({
    platform,
    tempDirectory: endpointTempDirectory,
    randomId: randomUUID(),
    sessionId
  })
  const token = randomBytes(32).toString('hex')
  const sensitiveValues = Object.freeze([token, descriptor.endpoint])
  const hello = deferred()
  const pendingRequests = new Map()
  const inboundPermissionRequests = new Map()
  const seenInboundPermissionIds = new Set()
  const seenInboundPermissionQueue = []
  let socket = null
  let authState = 'awaiting'
  let closed = false
  let closePromise = null
  let requestSequence = 0
  let handshakeTimer = null
  let listening = false
  let startupReject = null

  if (descriptor.socketRoot) {
    await prepareSocketRoot({ ...descriptor, tempDirectory: endpointTempDirectory }, fsPromises, getUid)
  }

  const rejectHello = (error) => {
    if (hello.settled) return
    hello.settled = true
    hello.reject(error)
  }
  const resolveHello = (value) => {
    if (hello.settled) return
    hello.settled = true
    hello.resolve(value)
  }
  const rejectPending = (error) => {
    for (const pending of pendingRequests.values()) {
      clearTimeoutFn(pending.timer)
      pending.reject(error)
    }
    pendingRequests.clear()
  }
  const abortInboundPermissions = () => {
    for (const pending of inboundPermissionRequests.values()) pending.controller.abort()
    inboundPermissionRequests.clear()
    seenInboundPermissionIds.clear()
    seenInboundPermissionQueue.length = 0
  }
  const failConnection = (error) => {
    authState = 'failed'
    clearTimeoutFn(handshakeTimer)
    rejectHello(error)
    rejectPending(error.code === 'DSH_BRIDGE_SERVER_ERROR'
      ? error
      : bridgeError('DSH_BRIDGE_DISCONNECTED', 'DSH bridge disconnected'))
    abortInboundPermissions()
    socket?.destroy()
  }

  let netServer
  const handleConnection = (candidate) => {
    candidate.on('error', () => {})
    if (closed || socket || hello.settled) {
      const duplicate = encodeBridgeFrame({
        type: 'error',
        code: 'DSH_BRIDGE_DUPLICATE_CLIENT'
      })
      candidate.end(duplicate)
      return
    }
    socket = candidate

    const decoder = new BridgeFrameDecoder((frame) => {
      if (authState === 'awaiting') {
        validateHello(frame, token, normalizedProfile, timingSafeEqual)
        authState = 'acknowledging'
        const ack = encodeBridgeFrame({ type: 'hello-ack', protocolVersion: DSH_BRIDGE_PROTOCOL })
        try {
          candidate.write(ack, (error) => {
            if (error || candidate.destroyed || authState !== 'acknowledging') {
              failConnection(bridgeError('DSH_BRIDGE_ACK_FAILED', 'DSH bridge hello acknowledgement failed'))
              return
            }
            authState = 'authenticated'
            clearTimeoutFn(handshakeTimer)
            resolveHello(normalizeHello(frame))
          })
        } catch {
          throw bridgeError('DSH_BRIDGE_ACK_FAILED', 'DSH bridge hello acknowledgement failed')
        }
        return
      }
      if (authState !== 'authenticated') {
        throw bridgeError('DSH_BRIDGE_FRAME_INVALID', 'Unexpected DSH bridge frame during hello')
      }
      if (frame.type === 'response') {
        if (!validateResponse(frame)) {
          throw bridgeError('DSH_BRIDGE_RESPONSE_INVALID', 'Invalid DSH bridge response')
        }
        if (Object.hasOwn(frame, 'result') && containsCredential(frame.result, sensitiveValues)) {
          throw bridgeError('DSH_BRIDGE_RESPONSE_INVALID', 'Credential-bearing DSH bridge response rejected')
        }
        const pending = pendingRequests.get(frame.requestId)
        if (!pending) {
          throw bridgeError('DSH_BRIDGE_RESPONSE_FORGED', 'Unknown DSH bridge response')
        }
        pendingRequests.delete(frame.requestId)
        clearTimeoutFn(pending.timer)
        if (Object.hasOwn(frame, 'error')) pending.reject(sanitizeRemoteError(frame.error))
        else pending.resolve(frame.result)
        return
      }

      if (containsCredential(frame, sensitiveValues)) {
        throw bridgeError('DSH_BRIDGE_FRAME_INVALID', 'Credential-bearing DSH bridge frame rejected')
      }

      if (frame.type === 'cancel') {
        if (!exactKeys(frame, ['requestId', 'type']) || !SAFE_REQUEST_ID.test(frame.requestId || '')) {
          throw bridgeError('DSH_BRIDGE_REQUEST_INVALID', 'Invalid DSH bridge request cancellation')
        }
        const pending = inboundPermissionRequests.get(frame.requestId)
        if (!pending) {
          throw bridgeError('DSH_BRIDGE_REQUEST_INVALID', 'Unknown DSH bridge request cancellation')
        }
        inboundPermissionRequests.delete(frame.requestId)
        pending.controller.abort()
        return
      }

      if (frame.type === 'request') {
        if (!validatePermissionRequest(frame)) {
          throw bridgeError('DSH_BRIDGE_REQUEST_INVALID', 'Invalid DSH bridge permission request')
        }
        if (
          seenInboundPermissionIds.has(frame.requestId) ||
          inboundPermissionRequests.has(frame.requestId) ||
          inboundPermissionRequests.size >= DSH_BRIDGE_MAX_PENDING_REQUESTS
        ) {
          throw bridgeError('DSH_BRIDGE_REQUEST_LIMIT', 'Too many pending DSH bridge permission requests')
        }
        seenInboundPermissionIds.add(frame.requestId)
        seenInboundPermissionQueue.push(frame.requestId)
        if (seenInboundPermissionQueue.length > 1_024) {
          seenInboundPermissionIds.delete(seenInboundPermissionQueue.shift())
        }
        const controller = new AbortController()
        inboundPermissionRequests.set(frame.requestId, { controller })
        const request = Object.freeze({
          sessionId,
          ...frame.params,
          signal: controller.signal
        })
        Promise.resolve()
          .then(() => typeof onPermissionRequest === 'function'
            ? onPermissionRequest(request)
            : { kind: 'deny', reason: 'UCLI permission handler unavailable' })
          .then((decision) => validatePermissionDecision(decision)
            ? decision
            : { kind: 'deny', reason: 'UCLI permission handler unavailable' })
          .catch(() => ({ kind: 'deny', reason: 'UCLI permission handler unavailable' }))
          .then((decision) => {
            if (!inboundPermissionRequests.delete(frame.requestId) || controller.signal.aborted) return
            if (authState !== 'authenticated' || candidate.destroyed) return
            const safeDecision = containsCredential(decision, sensitiveValues)
              ? { kind: 'deny', reason: 'UCLI permission handler unavailable' }
              : decision
            try {
              candidate.write(encodeBridgeFrame({
                type: 'response', requestId: frame.requestId, result: safeDecision
              }), (error) => { if (error) failConnection(bridgeError('DSH_BRIDGE_DISCONNECTED')) })
            } catch {
              failConnection(bridgeError('DSH_BRIDGE_DISCONNECTED'))
            }
          })
        return
      }

      if (!validateSemanticEvent(frame)) {
        throw bridgeError('DSH_BRIDGE_EVENT_INVALID', 'Invalid DSH bridge semantic event')
      }
      try {
        const result = onEvent(frame)
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch {
        // Consumer failures cannot mutate transport authentication state.
      }
    })

    candidate.on('data', (chunk) => {
      try {
        decoder.push(chunk)
      } catch (error) {
        failConnection(error)
      }
    })
    candidate.once('close', () => {
      if (socket !== candidate) return
      socket = null
      if (!hello.settled) {
        rejectHello(bridgeError('DSH_BRIDGE_DISCONNECTED', 'DSH bridge disconnected before hello'))
      }
      rejectPending(bridgeError('DSH_BRIDGE_DISCONNECTED', 'DSH bridge disconnected'))
      abortInboundPermissions()
    })
  }

  try {
    netServer = createServer(handleConnection)
  } catch (error) {
    if (descriptor.socketRoot) {
      await removeDshBridgeEndpoint({
        ...descriptor,
        tempDirectory: endpointTempDirectory,
        platform,
        fsPromises,
        getUid
      })
    }
    throw error
  }

  const onServerError = (cause) => {
    const error = bridgeError('DSH_BRIDGE_SERVER_ERROR', 'DSH bridge server failed')
    if (!listening) {
      startupReject?.(cause)
      return
    }
    if (!closed) failConnection(error)
  }
  netServer.on('error', onServerError)

  try {
    await new Promise((resolve, reject) => {
      startupReject = reject
      netServer.listen(descriptor.endpoint, () => {
        listening = true
        startupReject = null
        resolve()
      })
    })
    if (descriptor.socketRoot) {
      await assertPrivateSocket(descriptor.endpoint, fsPromises, getUid, false)
      await fsPromises.chmod(descriptor.endpoint, 0o600)
      await assertPrivateSocket(descriptor.endpoint, fsPromises, getUid, true)
    }
  } catch (error) {
    closed = true
    try {
      await closeNetServerAfterStartupFailure(netServer)
    } catch (closeError) {
      throw startupCleanupError(error, closeError)
    }
    netServer.removeListener('error', onServerError)
    if (descriptor.socketRoot) {
      await removeDshBridgeEndpoint({
        ...descriptor,
        tempDirectory: endpointTempDirectory,
        platform,
        fsPromises,
        getUid
      })
    }
    throw error
  }

  handshakeTimer = setTimeoutFn(() => {
    failConnection(bridgeError('DSH_BRIDGE_HANDSHAKE_TIMEOUT', 'DSH bridge hello timed out'))
  }, handshakeTimeoutMs)

  const close = () => {
    if (closePromise) return closePromise
    const attempt = (async () => {
      closed = true
      clearTimeoutFn(handshakeTimer)
      rejectHello(bridgeError('DSH_BRIDGE_CLOSED', 'DSH bridge server closed'))
      rejectPending(bridgeError('DSH_BRIDGE_DISCONNECTED', 'DSH bridge disconnected'))
      abortInboundPermissions()
      const activeSocket = socket
      socket = null
      activeSocket?.destroy()
      try {
        await closeNetServer(netServer)
      } catch (error) {
        throw serverCloseError(error)
      }
      activeSocket?.removeAllListeners()
      netServer.removeListener('error', onServerError)
      if (descriptor.socketRoot) {
        await removeDshBridgeEndpoint({
          ...descriptor,
          tempDirectory: endpointTempDirectory,
          platform,
          fsPromises,
          getUid
        })
      }
    })()
    closePromise = attempt
    attempt.catch(() => {
      if (closePromise === attempt) closePromise = null
    })
    return attempt
  }

  const request = (method, params = {}) => {
    if (authState !== 'authenticated' || !socket || socket.destroyed || closed) {
      return Promise.reject(bridgeError('DSH_BRIDGE_DISCONNECTED', 'DSH bridge is not connected'))
    }
    if (!REQUEST_METHODS.has(method)) {
      return Promise.reject(bridgeError(
        'DSH_BRIDGE_REQUEST_METHOD_UNSUPPORTED',
        'Unsupported DSH bridge request method'
      ))
    }
    if (!isPlainBridgeObject(params)) {
      return Promise.reject(bridgeError('DSH_BRIDGE_REQUEST_INVALID', 'Invalid DSH bridge request params'))
    }
    if (!validateOutboundRequestParams(method, params)) {
      return Promise.reject(bridgeError('DSH_BRIDGE_REQUEST_INVALID', 'Invalid DSH bridge request params'))
    }
    if (containsCredential(params, sensitiveValues)) {
      return Promise.reject(bridgeError('DSH_BRIDGE_REQUEST_INVALID', 'Invalid DSH bridge request params'))
    }
    if (pendingRequests.size >= DSH_BRIDGE_MAX_PENDING_REQUESTS) {
      return Promise.reject(bridgeError('DSH_BRIDGE_REQUEST_LIMIT', 'Too many pending DSH bridge requests'))
    }

    requestSequence += 1
    const requestId = `rpc:${requestSequence}:${randomUUID()}`
    if (!SAFE_REQUEST_ID.test(requestId)) {
      return Promise.reject(bridgeError('DSH_BRIDGE_REQUEST_INVALID', 'Invalid DSH bridge request id'))
    }
    let frame
    try {
      frame = encodeBridgeFrame({ type: 'request', requestId, method, params })
    } catch (error) {
      return Promise.reject(error)
    }

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => {
        if (!pendingRequests.delete(requestId)) return
        if (authState === 'authenticated' && socket && !socket.destroyed && !closed) {
          try { socket.write(encodeBridgeFrame({ type: 'cancel', requestId })) } catch { /* timed out locally */ }
        }
        reject(bridgeError('DSH_BRIDGE_REQUEST_TIMEOUT', 'DSH bridge request timed out'))
      }, requestTimeoutMs)
      pendingRequests.set(requestId, { resolve, reject, timer })
      try {
        socket.write(frame, (error) => {
          if (!error) return
          const pending = pendingRequests.get(requestId)
          if (!pending) return
          pendingRequests.delete(requestId)
          clearTimeoutFn(pending.timer)
          pending.reject(bridgeError('DSH_BRIDGE_DISCONNECTED', 'DSH bridge request write failed'))
        })
      } catch {
        pendingRequests.delete(requestId)
        clearTimeoutFn(timer)
        reject(bridgeError('DSH_BRIDGE_DISCONNECTED', 'DSH bridge request write failed'))
      }
    })
    promise.catch(() => {})
    return promise
  }

  return Object.freeze({
    endpoint: descriptor.endpoint,
    token,
    protocolVersion: DSH_BRIDGE_PROTOCOL,
    waitForHello: () => hello.promise,
    request,
    close
  })
}
