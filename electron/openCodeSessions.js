import { spawn } from 'child_process'

function normalizeDirectory(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function parseOpenCodeSessionList(stdout, cwd) {
  const text = String(stdout || '').trim()
  if (!text) return []

  let rows
  try {
    rows = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []

  const target = normalizeDirectory(cwd)
  return rows
    .filter((row) => row && typeof row.id === 'string')
    .filter((row) => !target || normalizeDirectory(row.directory) === target)
    .map((row) => ({
      sessionId: row.id,
      name: row.title || null,
      startedAt: timestamp(row.created),
      updatedAt: timestamp(row.updated)
    }))
    .sort((a, b) => (b.updatedAt || b.startedAt) - (a.updatedAt || a.startedAt))
    .slice(0, 30)
}

export function listOpenCodeSessions(cwd, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32'
      ? {
          file: process.env.ComSpec || 'cmd.exe',
          args: ['/d', '/s', '/c', 'opencode session list --format json --max-count 200']
        }
      : {
          file: 'opencode',
          args: ['session', 'list', '--format', 'json', '--max-count', '200']
        }
    const child = spawn(shell.file, shell.args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let settled = false
    let timer = null
    const finish = (sessions) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(sessions)
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.once('error', () => finish([]))
    child.once('close', (code) => {
      finish(code === 0 ? parseOpenCodeSessionList(stdout, cwd) : [])
    })
    timer = setTimeout(() => {
      child.kill()
      finish([])
    }, timeoutMs)
    timer.unref?.()
  })
}

export function listSessionsWithLaunch(cwd, launch, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(launch.file, [
      ...(launch.prefixArgs || []),
      'session', 'list', '--format', 'json', '--max-count', '200'
    ], {
      cwd: cwd || process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let settled = false
    let timer = null
    const finish = (sessions) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(sessions)
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.once('error', () => finish([]))
    child.once('close', (code) => {
      finish(code === 0 ? parseOpenCodeSessionList(stdout, cwd) : [])
    })
    timer = setTimeout(() => {
      child.kill()
      finish([])
    }, timeoutMs)
    timer.unref?.()
  })
}
