// Standalone headless test of the Claude adapter + PreToolUse hook chain.
// Does NOT import electron or the app modules — uses only Node built-ins so it
// can run directly with `node`. Verifies:
//   1. claude --print --input-format stream-json accepts a JSON user turn
//   2. the bundled PreToolUse hook runner (resources/claudeHook.runner.mjs)
//      fires for a tool call, calls back to a localhost hook server, and
//      claude proceeds when the server returns `allow`
//
// Run:  node test/headless-claude.mjs
import { spawn } from 'child_process'
import http from 'http'
import { mkdtempSync, writeFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOOK_RUNNER = join(ROOT, 'resources', 'claudeHook.runner.mjs')

// 1. tiny hook server that always allows (test only)
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    console.log('[hook-server] received tool call:', JSON.parse(body || '{}').tool)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ verdict: 'allow', reason: 'test auto-allow' }))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
console.log('[test] hook server on port', port)

// 2. generated settings.json wiring the PreToolUse hook
const dir = mkdtempSync(join(tmpdir(), 'ucli-test-'))
const settingsFile = join(dir, 'settings.json')
writeFileSync(settingsFile, JSON.stringify({
  hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${HOOK_RUNNER}"` }] }] },
  permissions: { deny: ['Bash(rm -rf /:*)', 'Bash(mkfs:*)'] }
}))
console.log('[test] settings at', settingsFile)

// 3. spawn claude with the adapter's exact flags + env
const args = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--verbose', '--permission-mode', 'default', '--settings', settingsFile
]
const proc = spawn('claude', args, {
  cwd: ROOT,
  shell: true,
  env: { ...process.env, UCLI_HOOK_PORT: String(port), UCLI_SESSION_ID: 'test-session' }
})

let sawToolUse = false
let sawToolResult = false
let sawResult = false
let buffer = ''
proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      const o = JSON.parse(line)
      if (o.type === 'assistant') {
        for (const b of o.message?.content || []) {
          if (b.type === 'tool_use') {
            sawToolUse = true
            console.log('[test] tool_use:', b.name, JSON.stringify(b.input).slice(0, 100))
          }
        }
      } else if (o.type === 'user') {
        for (const b of o.message?.content || []) {
          if (b.type === 'tool_result') {
            sawToolResult = true
            console.log('[test] tool_result is_error=', b.is_error)
          }
        }
      } else if (o.type === 'result') {
        sawResult = true
        console.log('[test] result subtype=', o.subtype, 'usage=', JSON.stringify(o.usage), 'cost=', o.total_cost_usd)
      }
    } catch { /* ignore non-JSON */ }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (c) => process.stderr.write('[claude stderr] ' + c))
proc.on('exit', (code) => {
  console.log('[test] claude exited code=', code)
  server.close()
  const ok = sawToolUse && sawToolResult && sawResult
  console.log('\n=== RESULT ===')
  console.log('sawToolUse:', sawToolUse, '| sawToolResult:', sawToolResult, '| sawResult:', sawResult)
  console.log(ok ? 'PASS ✅  hook fired → tool allowed → result emitted' : 'FAIL ❌')
  process.exit(ok ? 0 : 1)
})

// 4. send a user turn that forces a tool call (list files)
const turn = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Use the LS tool to list files in the current directory, then reply with the count.' }] }
})
proc.stdin.write(turn + '\n')
// close stdin after a moment so claude finishes (one-turn test)
setTimeout(() => proc.stdin.end(), 2000)

// safety timeout
setTimeout(() => {
  console.log('[test] timeout — killing')
  proc.kill()
}, 90000)
