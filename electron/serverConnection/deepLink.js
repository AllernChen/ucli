import { parseConnectionInput } from './linkParser.js'

function parseCandidate(input, parse) {
  if (typeof input !== 'string') return null
  try {
    return parse(input)
  } catch {
    return null
  }
}

/**
 * Keeps connection-link secrets in the main process until the registration
 * service is ready. Callers receive only a boolean, never the original URL.
 */
export function createDeepLinkReceiver({
  acceptConnection,
  parse = parseConnectionInput,
  ready = false
} = {}) {
  if (typeof acceptConnection !== 'function') throw new TypeError('acceptConnection is required')
  const pending = []
  let accepting = Promise.resolve()
  let isReady = ready

  function consume() {
    if (!isReady) return accepting
    while (pending.length) {
      const connection = pending.shift()
      accepting = accepting.then(() => acceptConnection(connection)).catch(() => {})
    }
    return accepting
  }

  function acceptParsed(connection) {
    pending.push(connection)
    void consume()
    return true
  }

  return {
    acceptOpenUrl(input) {
      const connection = parseCandidate(input, parse)
      return connection ? acceptParsed(connection) : false
    },
    acceptArgv(argv) {
      if (!Array.isArray(argv)) return false
      const candidates = argv.map(input => parseCandidate(input, parse)).filter(Boolean)
      if (candidates.length !== 1) return false
      return acceptParsed(candidates[0])
    },
    setReady() {
      isReady = true
      return consume()
    },
    flush() {
      return consume()
    }
  }
}
