import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { resolveDshHome } from '../adapters/deepSeekHarnessRuntime.js'

export const SKILL_ADAPTERS = Object.freeze({
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    projectParts: ['.claude', 'skills'],
    userParts: ['.claude', 'skills'],
    visibleFrom: ['claude']
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    projectParts: ['.agents', 'skills'],
    userParts: ['.agents', 'skills'],
    visibleFrom: ['codex']
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    projectParts: ['.opencode', 'skills'],
    userParts: ['.config', 'opencode', 'skills'],
    visibleFrom: ['opencode', 'claude', 'codex']
  },
  ucode: {
    id: 'ucode',
    displayName: 'U-Code',
    projectParts: ['.ucode', 'skills'],
    userParts: ['.config', 'ucode', 'skills'],
    visibleFrom: ['ucode', 'opencode', 'claude', 'codex']
  },
  'deepseek-harness': {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    projectParts: ['.dsh', 'skills'],
    userRoot: ({ env, home }) => join(resolveDshHome({ env, homeDirectory: home }), 'skills'),
    visibleFrom: ['deepseek-harness', 'codex']
  }
})

export function listSkillPresentationAdapters() {
  return Object.values(SKILL_ADAPTERS).map(({ id, displayName }) => ({ id, displayName }))
}

const PROJECTION_COVERAGE = Object.freeze({
  claude: ['claude', 'opencode', 'ucode'],
  codex: ['codex', 'opencode', 'ucode', 'deepseek-harness'],
  opencode: ['opencode', 'ucode'],
  ucode: ['ucode'],
  'deepseek-harness': ['deepseek-harness']
})

function normalizedPath(path) {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function expandHomePrefix(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

export function resolveDshAgentsRoot({ home = homedir(), env = process.env, cwd = process.cwd() } = {}) {
  const configured = typeof env.DSH_AGENTS_HOME === 'string' && env.DSH_AGENTS_HOME.trim()
    ? env.DSH_AGENTS_HOME
    : join(home, '.agents')
  return join(resolve(cwd, expandHomePrefix(configured, resolve(home))), 'skills')
}

export function resolveProjectScopeRoot(projectPath) {
  // Walk the logical path (path.resolve) instead of realpath: macOS exposes the
  // temp root under /var -> /private/var, so realpath would expand it and the
  // returned project root would disagree with the path the user sees. .git
  // detection follows symlinks either way.
  const fallback = resolve(projectPath)
  let current = fallback
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return fallback
}

function codexProjectionCoversDsh(options = {}) {
  if (options.scopeType !== 'user') return true
  const home = resolve(options.home || homedir())
  const codexRoot = resolveSkillRoot({ adapterId: 'codex', scopeType: 'user', home, env: options.env || process.env })
  const dshAgentsRoot = resolveDshAgentsRoot({ home, env: options.env || process.env })
  return normalizedPath(codexRoot) === normalizedPath(dshAgentsRoot)
}

function effectiveProjectionCoverage(adapterId, options = {}) {
  const coverage = PROJECTION_COVERAGE[adapterId]
  if (!coverage) throw Object.assign(new Error('Skill adapter is unavailable'), { code: 'SKILL_ADAPTER_UNAVAILABLE' })
  return adapterId === 'codex' && !codexProjectionCoversDsh(options)
    ? coverage.filter((id) => id !== 'deepseek-harness')
    : [...coverage]
}

export function resolveSkillRoot({ adapterId, scopeType, projectPath, home = homedir(), env = process.env }) {
  const adapter = SKILL_ADAPTERS[adapterId]
  if (!adapter) throw Object.assign(new Error('Skill adapter is unavailable'), { code: 'SKILL_ADAPTER_UNAVAILABLE' })
  if (scopeType === 'project') {
    if (!projectPath) throw Object.assign(new Error('Project path is required'), { code: 'SKILL_SCOPE_INVALID' })
    const base = ['codex', 'deepseek-harness'].includes(adapterId)
      ? resolveProjectScopeRoot(projectPath)
      : resolve(projectPath)
    return join(base, ...adapter.projectParts)
  }
  if (scopeType !== 'user') throw Object.assign(new Error('Skill scope is invalid'), { code: 'SKILL_SCOPE_INVALID' })
  if (adapterId === 'ucode' && env.UCODE_HOME) {
    if (!isAbsolute(env.UCODE_HOME)) throw Object.assign(new Error('UCODE_HOME must be absolute'), { code: 'SKILL_SCOPE_INVALID' })
    return join(resolve(env.UCODE_HOME), 'config', 'skills')
  }
  if (adapterId === 'opencode' || adapterId === 'ucode') {
    const configHome = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(resolve(home), '.config')
    return join(configHome, adapterId, 'skills')
  }
  if (adapter.userRoot) return adapter.userRoot({ env, home: resolve(home) })
  return join(resolve(home), ...adapter.userParts)
}

export function buildSkillVisibility(projectionAdapterIds, { scopeType } = {}) {
  const projections = [...new Set(projectionAdapterIds)]
  const visibility = Object.fromEntries(Object.keys(SKILL_ADAPTERS).map((adapterId) => {
    const inheritedFrom = projections.filter((projectionId) =>
      projectionId !== adapterId && PROJECTION_COVERAGE[projectionId]?.includes(adapterId)
    )
    const direct = projections.includes(adapterId)
    return [adapterId, { visible: direct || inheritedFrom.length > 0, direct, inheritedFrom }]
  }))
  return visibility
}

export function listSkillProjectionCapabilities(options = {}) {
  return Object.keys(SKILL_ADAPTERS).map((adapterId) => ({
    adapterId,
    directRoot: resolveSkillRoot({ adapterId, ...options }),
    covers: effectiveProjectionCoverage(adapterId, options),
    canExcludeInherited: false,
    isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED'
  }))
}

export function planSkillProjections(targetAdapterIds, options = {}) {
  const adapterOrder = Object.keys(SKILL_ADAPTERS)
  const remaining = new Set(targetAdapterIds.filter((id) => SKILL_ADAPTERS[id]))
  const selected = []
  while (remaining.size) {
    let best = null
    let bestCoverage = []
    for (const adapterId of adapterOrder) {
      const adapterCoverage = effectiveProjectionCoverage(adapterId, options)
      const coverage = adapterCoverage.filter((id) => remaining.has(id))
      if (coverage.length > bestCoverage.length || (coverage.length === bestCoverage.length && remaining.has(adapterId))) {
        best = adapterId
        bestCoverage = coverage
      }
    }
    if (!best || bestCoverage.length === 0) break
    selected.push(best)
    for (const id of bestCoverage) remaining.delete(id)
  }
  return selected.sort((left, right) => adapterOrder.indexOf(left) - adapterOrder.indexOf(right))
}
