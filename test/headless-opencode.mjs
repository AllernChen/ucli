import { createRequire } from 'module'
import { resolveOpenCodeLaunch } from '../electron/adapters/openCodeAdapter.js'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const launch = resolveOpenCodeLaunch()
let output = ''

const proc = pty.spawn(launch.file, [...launch.prefixArgs, '--version'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env
})
proc.onData((data) => { output += data })

const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    try { proc.kill() } catch {}
    reject(new Error('OpenCode PTY version check timed out'))
  }, 10_000)
  proc.onExit(({ exitCode: code }) => {
    clearTimeout(timer)
    resolve(code)
  })
})

const plainOutput = output.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '').trim()
if (exitCode !== 0) throw new Error(`OpenCode exited with code ${exitCode}`)
if (!/\d+\.\d+\.\d+/.test(plainOutput)) {
  throw new Error(`OpenCode version was not detected: ${JSON.stringify(plainOutput)}`)
}
console.log(`PASS OpenCode PTY ${plainOutput}`)
process.exit(0)
