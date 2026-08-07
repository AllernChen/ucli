import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'

export function parseUCodeSkillOutput(output) {
  let parsed
  try { parsed = JSON.parse(String(output || '').trim()) } catch { return [] }
  const skills = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.skills) ? parsed.skills : []
  return skills.flatMap((skill) => {
    if (!skill || typeof skill !== 'object') return []
    const name = typeof skill.name === 'string' ? skill.name.slice(0, 128) : ''
    const description = typeof skill.description === 'string' ? skill.description.slice(0, 1024) : ''
    const path = typeof skill.location === 'string' ? skill.location.slice(0, 4096) : ''
    if (!name || !description) return []
    return [{
      name,
      description,
      path,
      origin: skill.bundled === true ? 'bundled' : 'system',
      hidden: skill.hidden === true
    }]
  })
}

function findUCodeOnPath() {
  const result = spawnSync('where.exe', ['ucode'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
}

function findNodeOnPath() {
  const result = spawnSync('where.exe', ['node'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
}

/** Expand %~dp0 / %dp0% inside a quoted npm .cmd shim path. */
function expandShimPath(value, shimDirectory) {
  const directoryPrefix = shimDirectory.endsWith('\\') ? shimDirectory : `${shimDirectory}\\`
  const expanded = String(value)
    .replace(/%~dp0/gi, directoryPrefix)
    .replace(/%dp0%/gi, directoryPrefix)
  return expanded.includes('%') ? null : win32.normalize(expanded)
}

function isWithinDirectory(path, directory) {
  const relative = win32.relative(directory, path)
  return relative !== '..' &&
    !relative.startsWith(`..${win32.sep}`) &&
    !win32.isAbsolute(relative)
}

/** Resolve an npm-installed U-Code entry point directly from its .cmd shim,
 *  bypassing the .cmd shim entirely (execFileSync on a .cmd shim fails on
 *  Windows with EINVAL). Falls back to a bare `ucode` invocation on non-Win32. */
function resolveLaunch({ home = homedir(), platform = process.platform } = {}) {
  if (platform !== 'win32') return { file: 'ucode', prefixArgs: [] }
  const legacy = win32.join(home, '.ucode', 'bin', 'ucode.exe')
  const shimPaths = findUCodeOnPath()
  for (const shim of shimPaths.filter((path) => path.toLowerCase().endsWith('.cmd'))) {
    let content
    try { content = readFileSync(shim, 'utf8') } catch { continue }
    const directory = win32.dirname(shim)
    const quoted = [...String(content || '').matchAll(/"([^"\r\n]+)"/g)]
      .map((match) => match[1])
      .map((value) => expandShimPath(value, directory))
      .filter((path) => path && isWithinDirectory(path, directory) && existsSync(path))
    if (!quoted.length) continue
    const entry = quoted.find((path) =>
      path.toLowerCase().includes(`${win32.sep}node_modules${win32.sep}`) &&
      !path.toLowerCase().endsWith('.exe')
    ) || quoted[0]
    const localNode = win32.join(directory, 'node.exe')
    const node = existsSync(localNode)
      ? localNode
      : findNodeOnPath().find((path) => win32.basename(path).toLowerCase() === 'node.exe' && existsSync(path))
    if (node && entry) return { file: node, prefixArgs: [entry] }
    if (existsSync(entry)) return { file: entry, prefixArgs: [] }
  }
  if (existsSync(legacy)) return { file: legacy, prefixArgs: [] }
  return { file: 'ucode', prefixArgs: [] }
}

function defaultRun({ cwd } = {}) {
  const launch = resolveLaunch()
  return execFileSync(launch.file, [...launch.prefixArgs, 'debug', 'skill'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15000
  })
}

export function listUCodeSkills({ cwd, run = defaultRun } = {}) {
  try { return parseUCodeSkillOutput(run({ cwd })) } catch { return [] }
}
