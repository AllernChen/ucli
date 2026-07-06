import http from 'http'

/**
 * A tiny localhost HTTP server that the bundled Claude `PreToolUse` hook runner
 * calls back into. The runner (resources/claudeHook.runner.js) is invoked by
 * `claude` for every tool call; it POSTs the tool call here and blocks until we
 * respond with a verdict. This is how the GUI intercepts Claude tool calls —
 * `claude` itself never prompts on a TTY.
 *
 * Route: POST /hook/pre-tool-use  body: { sessionId, tool, input, cwd }
 * Response: { verdict: 'allow'|'deny', reason: string }
 */
export function startHookServer() {
  /** @type {((req: object) => Promise<{verdict:string, reason:string}>) | null} */
  let handler = null

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook/pre-tool-use') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ verdict: 'deny', reason: 'hook payload parse error' }))
      return
    }
    if (!handler) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ verdict: 'deny', reason: 'engine not ready' }))
      return
    }
    try {
      const result = await handler(payload)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ verdict: 'deny', reason: 'engine error: ' + (err?.message || String(err)) }))
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        setHandler(fn) {
          handler = fn
        },
        close() {
          return new Promise((r) => server.close(r))
        }
      })
    })
  })
}
