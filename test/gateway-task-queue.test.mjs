import assert from 'node:assert/strict'
import test from 'node:test'

import { GatewayTaskQueue } from '../electron/gateway/taskQueue.js'

test('Gateway task queues run one task and retain at most five waiting per session', () => {
  const queue = new GatewayTaskQueue()
  const first = queue.enqueue('session-1', 'message-0', 'task 0')
  assert.equal(first.accepted, true)
  assert.equal(first.position, 0)
  assert.match(first.task.relayTaskId, /^[0-9a-f-]{36}$/)

  for (let index = 1; index <= 5; index++) {
    const result = queue.enqueue('session-1', `message-${index}`, `task ${index}`)
    assert.equal(result.accepted, true)
    assert.equal(result.position, index)
  }
  assert.deepEqual(
    queue.enqueue('session-1', 'message-6', 'task 6'),
    { accepted: false, reason: 'queue_full' }
  )

  const other = queue.enqueue('session-2', 'other-message', 'other task')
  assert.equal(other.position, 0)
  assert.equal(queue.getState('session-2').running.text, 'other task')
})

test('interrupt pauses a queue and continue resumes from its head', () => {
  const queue = new GatewayTaskQueue()
  queue.enqueue('session-1', 'message-1', 'running')
  queue.enqueue('session-1', 'message-2', 'next')
  queue.enqueue('session-1', 'message-3', 'last')

  const interrupted = queue.interrupt('session-1')
  assert.equal(interrupted.text, 'running')
  assert.equal(queue.getState('session-1').paused, true)
  assert.equal(queue.getState('session-1').running, null)

  queue.enqueue('session-1', 'message-4', 'queued while paused')
  const resumed = queue.continue('session-1')
  assert.equal(resumed.text, 'next')
  assert.equal(queue.getState('session-1').paused, false)

  const following = queue.completeCurrent('session-1', resumed.relayTaskId)
  assert.equal(following.text, 'last')
})

test('clear, stop, and relay disable remove only ordinary queued tasks', () => {
  const queue = new GatewayTaskQueue()
  assert.deepEqual(
    queue.enqueue('session-1', 'decision-message', { kind: 'decision', action: 'allow' }),
    { accepted: false, reason: 'invalid_task' }
  )
  queue.enqueue('session-1', 'message-1', 'one')
  queue.enqueue('session-1', 'message-2', 'two')
  assert.equal(queue.clear('session-1'), 2)
  assert.deepEqual(queue.getState('session-1'), {
    running: null,
    waiting: [],
    paused: false
  })

  queue.enqueue('session-1', 'message-3', 'three')
  assert.equal(queue.onSessionStopped('session-1'), 1)
  queue.enqueue('session-2', 'message-4', 'four')
  assert.equal(queue.onRelayDisabled('session-2'), 1)
  assert.deepEqual(new GatewayTaskQueue().listSessionIds(), [])
})
