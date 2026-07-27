/**
 * Minimal file logger for the main process.
 *
 * Writes timestamped lines to {userData}/ucli.log so we can trace
 * execution paths without a terminal attached to the main process.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { safeConsoleError } from './brokenPipeGuard.js'

let logPath = null
let initialized = false

function ensureLogPath() {
  if (logPath) return logPath
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'ucli.log')
  } catch (e) {
    // Fallback — temp dir
    try {
      logPath = join(app.getPath('temp'), 'ucli.log')
    } catch {
      logPath = 'ucli.log' // last resort, cwd
    }
  }
  return logPath
}

export function initLogger() {
  if (initialized) return
  initialized = true
  const p = ensureLogPath()
  // Truncate old log at startup (keep last session clean)
  try {
    writeFileSync(p, `--- UCLI log started ${new Date().toISOString()} ---\n`)
  } catch { /* best effort */ }
  log(`Logger initialized at ${p}`)
}

export function log(...args) {
  ensureLogPath()
  const ts = new Date().toISOString()
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  const line = `[${ts}] ${msg}\n`
  try {
    appendFileSync(logPath, line)
  } catch { /* best effort — can't log about logging failure */ }
  // Also write to stderr so it shows in terminal / devtools
  safeConsoleError(console, `[LOG] ${msg}`)
}

export function getLogPath() {
  return logPath
}

export default { initLogger, log, getLogPath }
