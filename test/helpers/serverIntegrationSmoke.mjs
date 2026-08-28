import {
  PUBLIC_MODEL_PROTOCOLS,
  localGatewayPathForProtocol
} from '../../electron/serverConnection/contracts.js'

export function modelStreamRequest(protocol, modelId) {
  if (!PUBLIC_MODEL_PROTOCOLS.includes(protocol)) {
    throw Object.assign(new TypeError('Smoke protocol is invalid'), { code: 'SMOKE_PROTOCOL_INVALID' })
  }
  const path = localGatewayPathForProtocol(protocol)
  if (protocol === 'openai_responses') {
    return { path, headers: {}, body: { model: modelId, input: 'ping', stream: true } }
  }
  if (protocol === 'openai_chat') {
    return {
      path,
      headers: {},
      body: { model: modelId, messages: [{ role: 'user', content: 'ping' }], stream: true }
    }
  }
  return {
    path,
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], stream: true }
  }
}
