export const managedSummaryProfile = (profile, executorId) =>
  executorId === 'claude' &&
  profile?.adapterId === executorId &&
  profile?.kind === 'managed' &&
  profile?.status === 'ready' &&
  ['api_key', 'bearer'].includes(profile?.connectionMode || profile?.config?.connectionMode)

export const summaryProfileUsable = (profile, tool) =>
  managedSummaryProfile(profile, tool?.id) || (
    tool?.summaryExecutorAvailable === true &&
    tool?.id === 'claude' &&
    profile?.adapterId === tool.id &&
    profile?.kind === 'reference' &&
    profile?.status === 'ready' &&
    (profile?.connectionMode || profile?.config?.connectionMode) === 'subscription'
  )

export function summaryExecutorUsable(tool, profileId = null, profiles = [], allowAnyManaged = false) {
  if (!tool?.installed || tool.safeForSummary !== true) return false
  const selected = profileId
    ? profiles.find(profile => profile.id === profileId)
    : null
  if (profileId && !summaryProfileUsable(selected, tool)) return false
  if (tool.summaryExecutorAvailable === true) return true
  if (selected && managedSummaryProfile(selected, tool.id)) return true
  return allowAnyManaged && profiles.some(profile => managedSummaryProfile(profile, tool.id))
}

export function selectSummaryExecution({ settings = {}, tools = [], profiles = [] } = {}) {
  const defaultTool = tools.find(tool => tool.id === settings.defaultExecutorId)
  if (summaryExecutorUsable(defaultTool, settings.defaultProfileId, profiles)) {
    return {
      useDefaults: true,
      executorId: settings.defaultExecutorId,
      profileId: settings.defaultProfileId || null,
      model: settings.defaultModel || null
    }
  }

  for (const tool of tools) {
    if (!tool?.installed || tool.safeForSummary !== true) continue
    if (tool.summaryExecutorAvailable === true) {
      return { useDefaults: false, executorId: tool.id, profileId: null, model: null }
    }
    const profile = profiles.find(candidate => managedSummaryProfile(candidate, tool.id))
    if (profile) {
      return { useDefaults: false, executorId: tool.id, profileId: profile.id, model: null }
    }
  }

  return { useDefaults: false, executorId: null, profileId: null, model: null }
}
