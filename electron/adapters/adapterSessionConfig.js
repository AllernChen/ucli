const DSH_SURFACES = new Set(['tui', 'web'])
const INVALID_PROFILE_NAMES = new Set(['.', '..', 'node_modules'])
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export function validateDshProfileName(profileName) {
  if (
    typeof profileName !== 'string' ||
    profileName.length === 0 ||
    profileName.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f/\\<>:"|?*]/u.test(profileName) ||
    INVALID_PROFILE_NAMES.has(profileName.toLowerCase()) ||
    WINDOWS_DEVICE_NAME.test(profileName) ||
    /[. ]$/u.test(profileName)
  ) {
    throw new TypeError('Invalid DSH profile name')
  }
  return profileName
}

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

  return { profileName: validateDshProfileName(input?.profileName), surfacePreference }
}
