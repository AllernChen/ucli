// Standalone headless test of the Codex app-server JSON-RPC + approval chain.
// Verifies: spawn → initialize → thread/start → turn/start → notifications
// (deltas, token usage) → approval ServerRequest → respond accept → turn/completed.
//
// Run:  node test/headless-codex.mjs
import { spawn } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  cwd: ROOT,
  shell: true,
  env: { ...process.env, UCLI_SESSION_ID: 'test-codex' }
})

let nextId = 1
const pending = new Map()
let buffer = ''
let threadId = null
let sawDelta = false
let sawTokenUsage = false
let sawApproval = false
let sawTurnComplete = false

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n')
}
function request(method, params) {
  const id = nextId++
  return new Promise((resolveP, rejectP) => {
    pending.set(id, { resolve: resolveP, reject: rejectP })
    send({ jsonrpc: '2.0', id, method, params: params || {} })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        rejectP(new Error('timeout: ' + method))
      }
    }, 60000)
  })
}
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch (e) {
      console.log('[parse skip]', line.slice(0, 120))
    }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (c) => process.stderr.write('[codex stderr] ' + c))

function handle(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    }
    return
  }
  if (msg.id !== undefined && msg.method) {
    // Server request — approval. Accept everything (test only).
    sawApproval = true
    console.log('[test] approval request:', msg.method, '| command:', (msg.params || {}).command || '(none)')
    respond(msg.id, { decision: 'accept' })
    return
  }
  if (msg.method) {
    // notification
    switch (msg.method) {
      case 'item/agentMessage/delta':
        sawDelta = true
        break
      case 'thread/tokenUsage/updated':
        sawTokenUsage = true
        const tu = msg.params?.tokenUsage?.total
        console.log('[test] tokenUsage total:', tu ? JSON.stringify(tu) : '?')
        break
      case 'turn/completed':
        sawTurnComplete = true
        console.log('[test] turn/completed status:', msg.params?.turn?.status || msg.params?.status)
        break
      default:
        // log a few interesting ones
        if (/item\/(started|completed)|thread\/started|error|warning/.test(msg.method)) {
          console.log('[test] notif:', msg.method)
        }
        break
    }
  }
}

proc.on('exit', (code) => {
  console.log('\n=== RESULT ===')
  console.log('threadId:', threadId)
  console.log('sawDelta:', sawDelta, '| sawTokenUsage:', sawTokenUsage, '| sawApproval:', sawApproval, '| sawTurnComplete:', sawTurnComplete)
  const ok = threadId && sawTurnComplete
  console.log(ok ? 'PASS ✅  codex JSON-RPC + turn flow works' : 'FAIL ❌')
  process.exit(ok ? 0 : 1)
})

console.log('[test] spawning codex app-server...')
try {
  const init = await request('initialize', { clientInfo: { name: 'ucli-test', version: '0.1.0' } })
  console.log('[test] initialized')
  const ts = await request('thread/start', {
    cwd: ROOT,
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user'
  })
  threadId = ts?.thread?.id || ts?.threadId || ts?.id
  console.log('[test] thread started:', threadId)
  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: "Create a new file named hello.txt in the current directory with the content 'hi'." }]
  })
  console.log('[test] turn started, waiting for completion...')
} catch (e) {
  console.log('[test] ERROR:', e.message || e)
  proc.kill()
}

setTimeout(() => {
  console.log('[test] timeout — killing')
  proc.kill()
}, 90000)
