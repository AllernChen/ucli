import assert from 'node:assert/strict'
import test from 'node:test'

async function createBus() {
  const { SessionSignalBus } = await import('../electron/gateway/sessionSignalBus.js')
  return new SessionSignalBus()
}

function completedEvent(turnId) {
  return {
    type: 'turn_completed',
    sessionId: 'session-1',
    turnId,
    occurredAt: 1785370000000
  }
}

test('session signal bus publishes immutable snapshots in order', async () => {
  const bus = await createBus()
  const seen = []
  bus.subscribe((event) => seen.push(event))
  const first = completedEvent('turn-1')

  const published = bus.publish(first)
  first.turnId = 'mutated'
  bus.publish(completedEvent('turn-2'))

  assert.deepEqual(seen.map((event) => event.turnId), ['turn-1', 'turn-2'])
  assert.equal(published, seen[0])
  assert.equal(Object.isFrozen(published), true)
})

test('session signal bus unsubscribe stops later delivery', async () => {
  const bus = await createBus()
  const seen = []
  const unsubscribe = bus.subscribe((event) => seen.push(event))

  bus.publish(completedEvent('turn-1'))
  unsubscribe()
  bus.publish(completedEvent('turn-2'))

  assert.deepEqual(seen.map((event) => event.turnId), ['turn-1'])
})

test('session signal bus rejects terminal and statistics events', async () => {
  const bus = await createBus()

  assert.throws(
    () => bus.publish({
      type: 'terminal',
      sessionId: 'session-1',
      occurredAt: 1785370000000
    }),
    (error) => error.code === 'INVALID_GATEWAY_EVENT'
  )
  assert.throws(
    () => bus.publish({
      type: 'stats_update',
      sessionId: 'session-1',
      occurredAt: 1785370000000
    }),
    (error) => error.code === 'INVALID_GATEWAY_EVENT'
  )
})
