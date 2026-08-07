import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

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
  }
})

const PROJECTION_COVERAGE = Object.freeze({
  claude: ['claude', 'opencode', 'ucode'],
  codex: ['codex', 'opencode', 'ucode'],
  opencode: ['opencode', 'ucode'],
  ucode: ['ucode']
})

export function resolveSkillRoot({ adapterId, scopeType, projectPath, home = homedir(), env = process.env }) {
  const adapter = SKILL_ADAPTERS[adapterId]
  if (!adapter) throw Object.assign(new Error('Skill adapter is unavailable'), { code: 'SKILL_ADAPTER_UNAVAILABLE' })
  if (scopeType === 'project') {
    if (!projectPath) throw Object.assign(new Error('Project path is required'), { code: 'SKILL_SCOPE_INVALID' })
    return join(resolve(projectPath), ...adapter.projectParts)
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
  return join(resolve(home), ...adapter.userParts)
}

export function buildSkillVisibility(projectionAdapterIds) {
  const projections = [...new Set(projectionAdapterIds)]
  return Object.fromEntries(Object.keys(SKILL_ADAPTERS).map((adapterId) => {
    const inheritedFrom = projections.filter((projectionId) =>
      projectionId !== adapterId && PROJECTION_COVERAGE[projectionId]?.includes(adapterId)
    )
    const direct = projections.includes(adapterId)
    return [adapterId, { visible: direct || inheritedFrom.length > 0, direct, inheritedFrom }]
  }))
}

export function planSkillProjections(targetAdapterIds) {
  const adapterOrder = Object.keys(SKILL_ADAPTERS)
  const remaining = new Set(targetAdapterIds.filter((id) => SKILL_ADAPTERS[id]))
  const selected = []
  while (remaining.size) {
    let best = null
    let bestCoverage = []
    for (const adapterId of adapterOrder) {
      const coverage = PROJECTION_COVERAGE[adapterId].filter((id) => remaining.has(id))
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
