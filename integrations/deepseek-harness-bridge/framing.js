export const DSH_BRIDGE_MAX_FRAME_BYTES = 1024 * 1024

const HEADER_BYTES = 4

export function createBridgeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function isPlainBridgeObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function encodeBridgeFrame(value) {
  if (!isPlainBridgeObject(value)) throw createBridgeError('DSH_BRIDGE_FRAME_INVALID')
  let json
  try {
    json = JSON.stringify(value)
  } catch {
    throw createBridgeError('DSH_BRIDGE_FRAME_INVALID')
  }
  if (typeof json !== 'string') throw createBridgeError('DSH_BRIDGE_FRAME_INVALID')
  const body = Buffer.from(json, 'utf8')
  if (body.length > DSH_BRIDGE_MAX_FRAME_BYTES) {
    throw createBridgeError('DSH_BRIDGE_FRAME_TOO_LARGE')
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
    return this.#headerBytes + this.#bodyBytes
  }

  push(chunk) {
    if (this.#failed) throw createBridgeError('DSH_BRIDGE_FRAME_INVALID')
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      return this.#fail('DSH_BRIDGE_FRAME_INVALID')
    }
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let offset = 0
    while (offset < incoming.length) {
      if (this.#body === null) {
        const length = Math.min(HEADER_BYTES - this.#headerBytes, incoming.length - offset)
        incoming.copy(this.#header, this.#headerBytes, offset, offset + length)
        this.#headerBytes += length
        offset += length
        if (this.#headerBytes < HEADER_BYTES) continue
        const bodyLength = this.#header.readUInt32BE(0)
        if (bodyLength > DSH_BRIDGE_MAX_FRAME_BYTES) return this.#fail('DSH_BRIDGE_FRAME_TOO_LARGE')
        this.#body = Buffer.allocUnsafe(bodyLength)
        this.#bodyBytes = 0
      }

      const length = Math.min(this.#body.length - this.#bodyBytes, incoming.length - offset)
      if (length > 0) {
        incoming.copy(this.#body, this.#bodyBytes, offset, offset + length)
        this.#bodyBytes += length
        offset += length
      }
      if (this.#bodyBytes !== this.#body.length) continue
      const body = this.#body
      this.#resetFrame()
      let value
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
        value = JSON.parse(text)
      } catch {
        return this.#fail('DSH_BRIDGE_FRAME_INVALID')
      }
      if (!isPlainBridgeObject(value)) return this.#fail('DSH_BRIDGE_FRAME_INVALID')
      try {
        this.#onFrame(value)
      } catch (error) {
        this.#failed = true
        this.#resetFrame()
        throw error
      }
    }
  }

  #resetFrame() {
    this.#headerBytes = 0
    this.#body = null
    this.#bodyBytes = 0
  }

  #fail(code) {
    this.#failed = true
    this.#resetFrame()
    throw createBridgeError(code)
  }
}
