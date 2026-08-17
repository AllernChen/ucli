import { claudeDescriptor } from './adapters/claudeAdapter.js'
import { codexDescriptor } from './adapters/codexAdapter.js'
import { openCodeDescriptor } from './adapters/openCodeAdapter.js'
import { ucodeDescriptor } from './adapters/ucodeAdapter.js'
import { deepSeekHarnessDescriptor } from './adapters/deepSeekHarnessAdapter.js'
import {
  DSH_UNAVAILABLE_CAPABILITIES,
  DSH_WEB_CAPABILITIES
} from './adapters/adapterCapabilities.js'
import {
  normalizeDshCreateConfig,
  normalizePersistedDshConfig
} from './adapters/adapterSessionConfig.js'

const registeredDeepSeekHarnessDescriptor = Object.freeze({
  ...deepSeekHarnessDescriptor,
  capabilities: DSH_WEB_CAPABILITIES,
  capabilitiesForConfig: config => config?.surfacePreference === 'web'
    ? DSH_WEB_CAPABILITIES
    : DSH_UNAVAILABLE_CAPABILITIES,
  normalizeSessionConfig: normalizeDshCreateConfig,
  normalizePersistedSessionConfig: normalizePersistedDshConfig
})

const ADAPTER_DESCRIPTORS = [
  claudeDescriptor,
  codexDescriptor,
  openCodeDescriptor,
  ucodeDescriptor,
  registeredDeepSeekHarnessDescriptor
]

export function listAdapterDescriptors() {
  return [...ADAPTER_DESCRIPTORS]
}

export function createAdapterMap() {
  return new Map(ADAPTER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]))
}
