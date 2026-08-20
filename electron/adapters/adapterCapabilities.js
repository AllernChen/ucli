export const TERMINAL_ADAPTER_CAPABILITIES = Object.freeze({
  surface: 'terminal',
  permissionOwner: 'ucli',
  historyOwner: 'ucli',
  statsOwner: 'ucli',
  gateway: true,
  bridge: false
})

export const BRIDGED_DSH_TUI_CAPABILITIES = Object.freeze({
  surface: 'terminal',
  permissionOwner: 'ucli',
  historyOwner: 'ucli',
  statsOwner: 'ucli',
  gateway: true,
  bridge: true
})

export const DSH_WEB_CAPABILITIES = Object.freeze({
  surface: 'web',
  permissionOwner: 'native',
  historyOwner: 'native',
  statsOwner: 'ucli',
  gateway: false,
  bridge: false
})

export const DSH_UNAVAILABLE_CAPABILITIES = Object.freeze({
  surface: 'unavailable',
  permissionOwner: 'native',
  historyOwner: 'native',
  statsOwner: 'native',
  gateway: false,
  bridge: false
})

export function normalizeAdapterCapabilities(input = TERMINAL_ADAPTER_CAPABILITIES) {
  const capabilities = input
  if (
    !capabilities ||
    typeof capabilities !== 'object' ||
    Array.isArray(capabilities) ||
    !['terminal', 'web', 'unavailable'].includes(capabilities.surface) ||
    !['ucli', 'native'].includes(capabilities.permissionOwner) ||
    !['ucli', 'native'].includes(capabilities.historyOwner) ||
    !['ucli', 'native'].includes(capabilities.statsOwner) ||
    typeof capabilities.gateway !== 'boolean' ||
    typeof capabilities.bridge !== 'boolean'
  ) {
    throw new TypeError('Invalid adapter capabilities')
  }

  return Object.freeze({
    surface: capabilities.surface,
    permissionOwner: capabilities.permissionOwner,
    historyOwner: capabilities.historyOwner,
    statsOwner: capabilities.statsOwner,
    gateway: capabilities.gateway,
    bridge: capabilities.bridge
  })
}

export function resolveAdapterCapabilities(descriptor, adapterConfig) {
  const selected = typeof descriptor?.capabilitiesForConfig === 'function'
    ? descriptor.capabilitiesForConfig(adapterConfig)
    : descriptor?.capabilities
  return normalizeAdapterCapabilities(selected)
}
