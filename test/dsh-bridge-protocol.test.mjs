import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BridgeFrameDecoder,
  DSH_BRIDGE_MAX_FRAME_BYTES,
  encodeBridgeFrame
} from '../electron/adapters/dshBridgeProtocol.js'

function decodeChunks(chunks) {
  const values = []
  const decoder = new BridgeFrameDecoder((value) => values.push(value))
  for (const chunk of chunks) decoder.push(chunk)
  return values
}

test('decoder retains fragmented header and body until one complete frame arrives', () => {
  const frame = encodeBridgeFrame({ type: 'event', text: 'hello' })

  const values = decodeChunks([
    frame.subarray(0, 2),
    frame.subarray(2, 7),
    frame.subarray(7)
  ])

  assert.deepEqual(values, [{ type: 'event', text: 'hello' }])
})

test('decoder emits every coalesced frame in wire order', () => {
  const wire = Buffer.concat([
    encodeBridgeFrame({ sequence: 1 }),
    encodeBridgeFrame({ sequence: 2 }),
    encodeBridgeFrame({ sequence: 3 })
  ])

  assert.deepEqual(decodeChunks([wire]), [
    { sequence: 1 },
    { sequence: 2 },
    { sequence: 3 }
  ])
})

test('codec counts UTF-8 bytes and round-trips multibyte JSON', () => {
  const value = { text: '深度求索 🐢' }
  const frame = encodeBridgeFrame(value)
  const encodedLength = frame.readUInt32BE(0)

  assert.equal(encodedLength, Buffer.byteLength(JSON.stringify(value), 'utf8'))
  assert.deepEqual(decodeChunks([frame]), [value])
})

test('encoder accepts a JSON body exactly 1 MiB long', () => {
  const value = { data: 'a'.repeat(DSH_BRIDGE_MAX_FRAME_BYTES - 11) }
  const frame = encodeBridgeFrame(value)

  assert.equal(frame.readUInt32BE(0), 1024 * 1024)
  assert.equal(frame.length, 4 + 1024 * 1024)
})

test('encoder rejects a JSON body one byte over 1 MiB without echoing payload', () => {
  const marker = 'secret-payload-marker'
  const value = { data: `${marker}${'a'.repeat(DSH_BRIDGE_MAX_FRAME_BYTES - 10 - marker.length)}` }

  assert.throws(
    () => encodeBridgeFrame(value),
    (error) => {
      assert.equal(error.code, 'DSH_BRIDGE_FRAME_TOO_LARGE')
      assert.equal(error.message.includes(marker), false)
      return true
    }
  )
})

test('encoder rejects primitive and array top-level values', () => {
  for (const value of [null, true, 7, 'text', [], [1], undefined]) {
    assert.throws(
      () => encodeBridgeFrame(value),
      (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID',
      String(value)
    )
  }
})

test('decoder rejects an announced length over 1 MiB before buffering its body', () => {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(DSH_BRIDGE_MAX_FRAME_BYTES + 1)
  const decoder = new BridgeFrameDecoder(() => assert.fail('must not emit a frame'))

  assert.throws(
    () => decoder.push(header),
    (error) => error.code === 'DSH_BRIDGE_FRAME_TOO_LARGE'
  )
})

test('decoder rejects invalid JSON with a stable error that omits payload data', () => {
  const body = Buffer.from('{"token":"do-not-echo"', 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  const decoder = new BridgeFrameDecoder(() => assert.fail('must not emit a frame'))

  assert.throws(
    () => decoder.push(Buffer.concat([header, body])),
    (error) => {
      assert.equal(error.code, 'DSH_BRIDGE_FRAME_INVALID')
      assert.equal(error.message.includes('do-not-echo'), false)
      return true
    }
  )
})

test('decoder becomes unusable after malformed input instead of resynchronizing unsafely', () => {
  const badBody = Buffer.from('not-json', 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(badBody.length)
  const decoder = new BridgeFrameDecoder(() => assert.fail('must not emit a frame'))

  assert.throws(() => decoder.push(Buffer.concat([header, badBody])))
  assert.throws(
    () => decoder.push(encodeBridgeFrame({ valid: true })),
    (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID'
  )
})

test('decoder rejects malformed UTF-8 instead of accepting replacement characters', () => {
  const body = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  const decoder = new BridgeFrameDecoder(() => assert.fail('must not emit a frame'))

  assert.throws(
    () => decoder.push(Buffer.concat([header, body])),
    (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID'
  )
})

test('decoder rejects primitive and array JSON top-level values', () => {
  for (const bodyText of ['null', 'true', '7', '"text"', '[]', '[1]']) {
    const body = Buffer.from(bodyText)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    const decoder = new BridgeFrameDecoder(() => assert.fail('must not emit a frame'))
    assert.throws(
      () => decoder.push(Buffer.concat([header, body])),
      (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID'
    )
  }
})

test('decoder fail-stops when a frame callback rejects a frame in a coalesced chunk', () => {
  const seen = []
  const decoder = new BridgeFrameDecoder((value) => {
    seen.push(value.type)
    throw Object.assign(new Error('invalid hello'), { code: 'DSH_BRIDGE_HELLO_INVALID' })
  })
  const wire = Buffer.concat([
    encodeBridgeFrame({ type: 'invalid-hello' }),
    encodeBridgeFrame({ type: 'hello' }),
    encodeBridgeFrame({ type: 'session-ready' })
  ])

  assert.throws(
    () => decoder.push(wire),
    (error) => error.code === 'DSH_BRIDGE_HELLO_INVALID'
  )
  assert.deepEqual(seen, ['invalid-hello'])
  assert.throws(
    () => decoder.push(encodeBridgeFrame({ type: 'later' })),
    (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID'
  )
})

test('decoder keeps a bounded incomplete tail across one-byte fragments', () => {
  const frame = encodeBridgeFrame({ data: 'a'.repeat(256 * 1024) })
  const values = []
  const decoder = new BridgeFrameDecoder((value) => values.push(value))

  for (let index = 0; index < frame.length; index += 1) {
    decoder.push(frame.subarray(index, index + 1))
    assert.ok(decoder.bufferedBytes <= DSH_BRIDGE_MAX_FRAME_BYTES + 4)
  }

  assert.equal(values.length, 1)
  assert.equal(values[0].data.length, 256 * 1024)
  assert.equal(decoder.bufferedBytes, 0)
})
