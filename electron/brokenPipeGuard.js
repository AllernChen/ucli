const guardedStreams = new WeakSet()
const BROKEN_OUTPUT_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED'])

export function isBrokenOutputError(error) {
  return BROKEN_OUTPUT_CODES.has(error?.code)
}

export function installOutputErrorGuards({
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  for (const stream of [stdout, stderr]) {
    if (!stream || typeof stream.on !== 'function' || guardedStreams.has(stream)) continue
    guardedStreams.add(stream)
    stream.on('error', (error) => {
      if (!isBrokenOutputError(error)) throw error
    })
  }
}

export function safeConsoleError(consoleObject, ...args) {
  try {
    consoleObject.error(...args)
  } catch (error) {
    if (!isBrokenOutputError(error)) throw error
  }
}
