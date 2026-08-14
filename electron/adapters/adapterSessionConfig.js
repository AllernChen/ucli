const DSH_SURFACES = new Set(['tui', 'web'])
const INVALID_PROFILE_NAMES = new Set(['.', '..', 'node_modules'])

export function normalizeSessionConfig(descriptor, input) {
  const normalized = descriptor.normalizeSessionConfig?.(input) ?? {}
  return structuredClone(normalized)
}

export function normalizePersistedSessionConfig(descriptor, input) {
  try {
    return normalizeSessionConfig(descriptor, input)
  } catch {
    return {}
  }
}

export function normalizeDshSessionConfig(input) {
  const surfacePreference = input?.surfacePreference
  if (!DSH_SURFACES.has(surfacePreference)) {
    throw new TypeError('Invalid DSH surface preference')
  }
  if (surfacePreference === 'web') {
    return { surfacePreference }
  }

  const profileName = input?.profileName
  if (
    typeof profileName !== 'string' ||
    profileName.length === 0 ||
    profileName.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f/\\]/u.test(profileName) ||
    INVALID_PROFILE_NAMES.has(profileName)
  ) {
    throw new TypeError('Invalid DSH profile name')
  }

  return { profileName, surfacePreference }
}
