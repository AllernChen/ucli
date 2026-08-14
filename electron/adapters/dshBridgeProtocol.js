export const DSH_BRIDGE_PROTOCOL = 1
export const DSH_BRIDGE_MAX_FRAME_BYTES = 1024 * 1024
export const DSH_BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000

const HEADER_BYTES = 4
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export function createDshBridgeError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

export function isPlainBridgeObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function encodeBridgeFrame(value) {
  if (!isPlainBridgeObject(value)) {
    throw createDshBridgeError('DSH_BRIDGE_FRAME_INVALID', 'Invalid DSH bridge frame')
  }

  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw createDshBridgeError('DSH_BRIDGE_FRAME_INVALID', 'Invalid DSH bridge frame')
  }
  if (typeof serialized !== 'string') {
    throw createDshBridgeError('DSH_BRIDGE_FRAME_INVALID', 'Invalid DSH bridge frame')
  }

  const body = Buffer.from(serialized, 'utf8')
  if (body.length > DSH_BRIDGE_MAX_FRAME_BYTES) {
    throw createDshBridgeError('DSH_BRIDGE_FRAME_TOO_LARGE', 'DSH bridge frame exceeds limit')
  }

  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, HEADER_BYTES)
  return frame
}

export class BridgeFrameDecoder {
  #header = Buffer.alloc(HEADER_BYTES)
  #headerBytes = 0
  #body = null
  #bodyBytes = 0
  #failed = false
  #onFrame

  constructor(onFrame) {
    if (typeof onFrame !== 'function') throw new TypeError('onFrame must be a function')
    this.#onFrame = onFrame
  }

  get bufferedBytes() {
    return this.#body === null ? this.#headerBytes : HEADER_BYTES + this.#body.length
  }

  push(chunk) {
    if (this.#failed) {
      throw createDshBridgeError('DSH_BRIDGE_FRAME_INVALID', 'DSH bridge decoder is closed')
    }
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      return this.#fail('DSH_BRIDGE_FRAME_INVALID', 'Invalid DSH bridge frame chunk')
    }

    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let offset = 0
    while (offset < incoming.length) {
      if (this.#body === null) {
        const headerPart = Math.min(HEADER_BYTES - this.#headerBytes, incoming.length - offset)
        incoming.copy(this.#header, this.#headerBytes, offset, offset + headerPart)
        this.#headerBytes += headerPart
        offset += headerPart
        if (this.#headerBytes < HEADER_BYTES) continue

        const bodyLength = this.#header.readUInt32BE(0)
        if (bodyLength > DSH_BRIDGE_MAX_FRAME_BYTES) {
          return this.#fail('DSH_BRIDGE_FRAME_TOO_LARGE', 'DSH bridge frame exceeds limit')
        }
        this.#body = Buffer.allocUnsafe(bodyLength)
        this.#bodyBytes = 0
      }

      const bodyPart = Math.min(this.#body.length - this.#bodyBytes, incoming.length - offset)
      if (bodyPart > 0) {
        incoming.copy(this.#body, this.#bodyBytes, offset, offset + bodyPart)
        this.#bodyBytes += bodyPart
        offset += bodyPart
      }
      if (this.#bodyBytes !== this.#body.length) continue

      const body = this.#body
      this.#resetFrame()
      let value
      try {
        value = JSON.parse(UTF8_DECODER.decode(body))
      } catch {
        return this.#fail('DSH_BRIDGE_FRAME_INVALID', 'Invalid DSH bridge frame')
      }
      if (!isPlainBridgeObject(value)) {
        return this.#fail('DSH_BRIDGE_FRAME_INVALID', 'Invalid DSH bridge frame')
      }
      try {
        this.#onFrame(value)
      } catch (error) {
        this.#abort()
        throw error
      }
    }
  }

  #resetFrame() {
    this.#headerBytes = 0
    this.#body = null
    this.#bodyBytes = 0
  }

  #abort() {
    this.#failed = true
    this.#resetFrame()
  }

  #fail(code, message) {
    this.#abort()
    throw createDshBridgeError(code, message)
  }
}
