/**
 * Claude Code `PreToolUse` hook runner — a standalone Node script with NO
 * external dependencies, invoked by `claude` for every tool call. It is run as
 *   node "<path>/claudeHook.runner.mjs"
 * (configured in the generated settings.json). Env vars set by the adapter:
 *   UCLI_HOOK_PORT   port of the GUI's localhost hook server
 *   UCLI_SESSION_ID  the UCLI session id this claude process belongs to
 *
 * Flow: read the PreToolUse payload from stdin → POST to the hook server →
 * print the Claude hook output JSON (allow/deny) → exit. `claude` blocks on
 * this process, so the user's confirmation in the GUI can take its time.
 */
import http from 'http'

const PORT = process.env.UCLI_HOOK_PORT
const SESSION_ID = process.env.UCLI_SESSION_ID

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
    // If claude ever sends no stdin, don't hang forever.
    setTimeout(() => resolve(data), 2000)
  })
}

function post(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj)
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf || '{}'))
          } catch {
            resolve({ verdict: 'deny', reason: 'bad response from hook server' })
          }
        })
      }
    )
    req.on('error', (err) => reject(err))
    req.end(body)
  })
}

async function main() {
  if (!PORT || !SESSION_ID) {
    // Misconfigured — fail safe (deny) so the tool doesn't run unsupervised.
    emit('deny', 'UCLI hook env (UCLI_HOOK_PORT/UCLI_SESSION_ID) not set')
    return
  }
  const raw = await readStdin()
  let payload = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    emit('deny', 'could not parse PreToolUse stdin payload')
    return
  }
  const tool = payload.tool_name || payload.toolName || ''
  const input = payload.tool_input || payload.toolInput || {}
  const cwd = payload.cwd
  try {
    const result = await post('/hook/pre-tool-use', { sessionId: SESSION_ID, tool, input, cwd })
    emit(result.verdict === 'allow' ? 'allow' : 'deny', result.reason || '')
  } catch (err) {
    emit('deny', 'hook server unreachable: ' + (err?.message || String(err)))
  }
}

function emit(permissionDecision, permissionDecisionReason) {
  // Claude PreToolUse hook output schema. `allow` proceeds; `deny` blocks.
  const out = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason
    }
  }
  process.stdout.write(JSON.stringify(out))
}

main().catch((err) => emit('deny', 'runner crash: ' + (err?.message || String(err))))
