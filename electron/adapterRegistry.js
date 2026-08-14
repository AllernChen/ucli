import { claudeDescriptor } from './adapters/claudeAdapter.js'
import { codexDescriptor } from './adapters/codexAdapter.js'
import { openCodeDescriptor } from './adapters/openCodeAdapter.js'
import { ucodeDescriptor } from './adapters/ucodeAdapter.js'
import { deepSeekHarnessDescriptor } from './adapters/deepSeekHarnessAdapter.js'

const ADAPTER_DESCRIPTORS = [
  claudeDescriptor,
  codexDescriptor,
  openCodeDescriptor,
  ucodeDescriptor,
  deepSeekHarnessDescriptor
]

export function listAdapterDescriptors() {
  return [...ADAPTER_DESCRIPTORS]
}

export function createAdapterMap() {
  return new Map(ADAPTER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]))
}
