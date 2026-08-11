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

export function getNativeCapabilities(adapterId) {
  return NATIVE_CAPABILITY_MATRIX[adapterId] || null
}

export function getNativeCapabilityMetadata(adapterId) {
  return NATIVE_CAPABILITY_METADATA[adapterId] || null
}
