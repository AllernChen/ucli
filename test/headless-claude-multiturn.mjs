// Verifies multi-turn over a single `claude --print --input-format stream-json`
// process: after the first `result`, send a second user turn on the same stdin
// and confirm a second `result` is emitted (process stays alive). No hook, no
// tools — pure text turns.
import { spawn } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const proc = spawn('claude', [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--verbose', '--permission-mode', 'default'
], { cwd: ROOT, shell: true })

let results = 0
let buffer = ''
function sendTurn(text) {
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
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
      const o = JSON.parse(line)
      if (o.type === 'result') {
        results += 1
        console.log(`[test] result #${results} subtype=${o.subtype} text="${(o.result || '').slice(0, 40)}"`)
        if (results === 1) {
          console.log('[test] sending second turn on same stdin...')
          sendTurn('Reply with exactly: world')
        } else if (results === 2) {
          console.log('\n=== RESULT ===\nPASS ✅  multi-turn over single process works (2 results)')
          proc.kill()
          process.exit(0)
        }
      }
    } catch { /* ignore */ }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (c) => process.stderr.write('[stderr] ' + c))
proc.on('exit', (code) => {
  if (results < 2) {
    console.log(`\n=== RESULT ===\nFAIL ❌  only ${results} result(s); process exited code=${code}`)
    process.exit(1)
  }
})

console.log('[test] sending first turn...')
sendTurn('Reply with exactly: hello')
setTimeout(() => { console.log('[test] timeout'); proc.kill(); }, 90000)
