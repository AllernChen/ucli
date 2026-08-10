import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildSkillVisibility } from '../electron/skills/adapters.js'
import { createSkillDiscovery } from '../electron/skills/discovery.js'
import { inspectSkillDirectory } from '../electron/skills/fileOps.js'

export async function discoverAuditLocations({ home = homedir(), projectPath } = {}) {
  return createSkillDiscovery({
    home,
    inspectSkillDirectory,
    buildSkillVisibility
  }).discover({ projectPath })
}

function countBy(items, key) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const value = item[key] || 'unknown'
    counts.set(value, (counts.get(value) || 0) + 1)
    return counts
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)))
}

export async function auditSkills({ home = homedir(), projectPath, discovery = discoverAuditLocations } = {}) {
  const discovered = await discovery({ home, projectPath })
  const locations = discovered.map((item) => ({
    name: item.name,
    sourceKind: item.sourceKind,
    health: item.health || item.status || 'ready',
    entryPath: item.entryPath || item.path,
    resolvedPath: item.resolvedPath || item.path,
    ...(item.plugin ? { plugin: item.plugin } : {})
  })).sort((left, right) => left.name.localeCompare(right.name) || left.sourceKind.localeCompare(right.sourceKind))
  return {
    countsBySourceKind: countBy(locations, 'sourceKind'),
    countsByHealth: countBy(locations, 'health'),
    locations
  }
}

function cliProjectPath(argv) {
  const inline = argv.find((value) => value.startsWith('--project='))
  if (inline) return inline.slice('--project='.length)
  const index = argv.indexOf('--project')
  return index >= 0 ? argv[index + 1] : undefined
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  auditSkills({ projectPath: cliProjectPath(process.argv.slice(2)) })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error)
      process.exitCode = 1
    })
}
