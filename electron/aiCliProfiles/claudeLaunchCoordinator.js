export function claudeProfileLaunchStamp(session = {}) {
  return {
    profileId: session.profileId || null,
    runtimeRevision: session.profileRuntimeRevision || null
  }
}

function sameStamp(left = {}, right = {}) {
  return (left.profileId || null) === (right.profileId || null) &&
    (left.runtimeRevision || null) === (right.runtimeRevision || null)
}

export function armClaudeProfileLaunch({ entry, desiredStamp, prepareRuntime }) {
  const shouldRefresh = !sameStamp(entry._claudeProfileLaunchStamp, desiredStamp)
  if (shouldRefresh) {
    const prepared = prepareRuntime()
    Object.assign(entry.session, prepared.session)
    entry.adapter.setProfileLaunch(prepared.profileLaunch)
    entry._claudeProfileLaunchStamp = claudeProfileLaunchStamp(prepared.session)
  }

  Object.assign(entry.session, {
    activeProfileId: entry.session.profileId || null,
    pendingProfileId: null,
    pendingProfileRuntimeRevision: null,
    restartRequired: false
  })
  entry.status = 'launching'
  return shouldRefresh
}
