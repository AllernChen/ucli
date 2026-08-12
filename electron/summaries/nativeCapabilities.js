const capability = (value) => Object.freeze(value)

export const NATIVE_CAPABILITY_MATRIX = Object.freeze({
  claude: capability({
    structuredOutput: true,
    nativeUsage: false,
    nativeRetrospective: true,
    existingSessionDigest: false,
    safeTranscriptExport: false
  }),
  codex: capability({
    structuredOutput: true,
    nativeUsage: false,
    nativeRetrospective: false,
    existingSessionDigest: false,
    safeTranscriptExport: false
  }),
  opencode: capability({
    structuredOutput: true,
    nativeUsage: true,
    nativeRetrospective: false,
    existingSessionDigest: true,
    safeTranscriptExport: true
  }),
  ucode: capability({
    structuredOutput: true,
    nativeUsage: false,
    nativeRetrospective: false,
    existingSessionDigest: true,
    safeTranscriptExport: true
  })
})

const NATIVE_CAPABILITY_METADATA = Object.freeze({
  claude: capability({
    nativeRetrospective: capability({
      command: '/insights',
      invocation: 'manual',
      stability: 'experimental'
    })
  }),
  codex: capability({}),
  opencode: capability({}),
  ucode: capability({})
})

const SUMMARY_EXECUTOR_CAPABILITIES = Object.freeze({
  claude: capability({
    available: true,
    noToolsEnforcement: 'cli-flag',
    reason: null
  }),
  codex: capability({
    available: false,
    noToolsEnforcement: null,
    reason: 'no-guaranteed-no-tools-mode'
  }),
  opencode: capability({
    available: true,
    noToolsEnforcement: 'permission-wildcard',
    reason: null
  }),
  ucode: capability({
    available: false,
    noToolsEnforcement: null,
    reason: 'no-guaranteed-no-tools-mode'
  })
})

export function getNativeCapabilities(adapterId) {
  return NATIVE_CAPABILITY_MATRIX[adapterId] || null
}

export function getNativeCapabilityMetadata(adapterId) {
  return NATIVE_CAPABILITY_METADATA[adapterId] || null
}

export function getSummaryExecutorCapability(adapterId) {
  return SUMMARY_EXECUTOR_CAPABILITIES[adapterId] || null
}
