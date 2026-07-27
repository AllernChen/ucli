function sessionCreatedTimestamp(session) {
  return Number(
    session.createdAt ||
    session.startedAt ||
    0
  )
}

export function normalizeProjectPath(cwd) {
  const original = String(cwd || '').trim()
  if (!original) return ''

  let normalized = original.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '')
  }

  if (/^[A-Za-z]:\//.test(normalized) || original.startsWith('\\\\')) {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

export function projectNameFromPath(cwd) {
  const original = String(cwd || '').trim()
  if (!original) return '未设置目录'
  const path = original.replace(/[\\/]+$/, '')
  if (!path) return original[0]
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function groupSessionsByProject(sessions = [], adapters = []) {
  const adapterById = new Map(adapters.map((adapter, index) => [
    adapter.id,
    { ...adapter, order: index }
  ]))
  const projectByKey = new Map()

  sessions.forEach((session, sessionOrder) => {
    const normalizedPath = normalizeProjectPath(session.cwd)
    const projectKey = normalizedPath || '__no_project__'
    let project = projectByKey.get(projectKey)
    if (!project) {
      project = {
        key: projectKey,
        name: projectNameFromPath(session.cwd),
        path: session.cwd || '',
        count: 0,
        latestAt: 0,
        order: sessionOrder,
        cliById: new Map()
      }
      projectByKey.set(projectKey, project)
    }

    const adapterId = session.adapterId || 'unknown'
    let cli = project.cliById.get(adapterId)
    if (!cli) {
      const adapter = adapterById.get(adapterId)
      cli = {
        key: JSON.stringify([projectKey, adapterId]),
        id: adapterId,
        icon: adapter?.icon || session.icon || '•',
        displayName: adapter?.displayName || adapterId,
        order: adapter?.order ?? Number.MAX_SAFE_INTEGER,
        firstSessionOrder: sessionOrder,
        sessions: []
      }
      project.cliById.set(adapterId, cli)
    }

    const latestAt = sessionCreatedTimestamp(session)
    project.count += 1
    project.latestAt = Math.max(project.latestAt, latestAt)
    cli.sessions.push({ session, latestAt, order: sessionOrder })
  })

  return Array.from(projectByKey.values())
    .map((project) => ({
      key: project.key,
      name: project.name,
      path: project.path,
      count: project.count,
      latestAt: project.latestAt,
      order: project.order,
      cliGroups: Array.from(project.cliById.values())
        .sort((a, b) =>
          a.order - b.order ||
          a.displayName.localeCompare(b.displayName) ||
          a.firstSessionOrder - b.firstSessionOrder
        )
        .map((cli) => ({
          key: cli.key,
          id: cli.id,
          icon: cli.icon,
          displayName: cli.displayName,
          count: cli.sessions.length,
          sessions: cli.sessions
            .sort((a, b) => b.latestAt - a.latestAt || a.order - b.order)
            .map((item) => item.session)
        }))
    }))
    .sort((a, b) => b.latestAt - a.latestAt || a.order - b.order)
    .map(({ order, ...project }) => project)
}
