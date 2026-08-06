const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const REQUIRED_METHODS = ['validateDraft', 'sanitiseConfig', 'resolveLaunch', 'reconcile']

function registryError(message, code) {
  return Object.assign(new TypeError(message), { code })
}

function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !ADAPTER_ID_PATTERN.test(adapter.id || '')) {
    throw registryError('Profile adapter is invalid', 'INVALID_PROFILE_ADAPTER')
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw registryError(`Profile adapter ${adapter.id} is missing ${method}`, 'INVALID_PROFILE_ADAPTER')
    }
  }
}

export function createProfileAdapterRegistry(adapters = []) {
  if (!Array.isArray(adapters)) {
    throw registryError('Profile adapters must be an array', 'INVALID_PROFILE_ADAPTER')
  }

  const registry = new Map()
  for (const adapter of adapters) {
    assertAdapter(adapter)
    if (registry.has(adapter.id)) {
      throw registryError(`Duplicate profile adapter: ${adapter.id}`, 'DUPLICATE_PROFILE_ADAPTER')
    }
    registry.set(adapter.id, adapter)
  }
  return registry
}
