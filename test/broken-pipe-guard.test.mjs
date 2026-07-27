import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  installOutputErrorGuards,
  safeConsoleError
} from '../electron/brokenPipeGuard.js'

function errorWithCode(code, message = code) {
  return Object.assign(new Error(message), { code })
}

test('process output guards swallow broken pipes and install only once', () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()

  installOutputErrorGuards({ stdout, stderr })
  installOutputErrorGuards({ stdout, stderr })

  assert.equal(stdout.listenerCount('error'), 1)
  assert.equal(stderr.listenerCount('error'), 1)
  assert.doesNotThrow(() => stdout.emit('error', errorWithCode('EPIPE')))
  assert.doesNotThrow(() => stderr.emit('error', errorWithCode('ERR_STREAM_DESTROYED')))
})

test('process output guards preserve unexpected stream failures', () => {
  const stdout = new EventEmitter()
  installOutputErrorGuards({ stdout, stderr: null })

  assert.throws(
    () => stdout.emit('error', errorWithCode('ENOSPC', 'disk full')),
    /disk full/
  )
})

test('safe console logging ignores only broken output pipes', () => {
  const brokenConsole = {
    error: () => {
      throw errorWithCode('EPIPE')
    }
  }
  const failingConsole = {
    error: () => {
      throw errorWithCode('EINVAL', 'invalid write')
    }
  }

  assert.doesNotThrow(() => safeConsoleError(brokenConsole, 'message'))
  assert.throws(() => safeConsoleError(failingConsole, 'message'), /invalid write/)
})
