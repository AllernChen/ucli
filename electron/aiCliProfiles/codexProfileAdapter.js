import { normaliseProfileDraft } from './contracts.js'
import {
  codexManagedProviderId,
  codexNativeProfileName,
  codexProfileSecretEnvName
} from './codexProfileFile.js'
import { resolveCodexProfileRuntime } from './profileResolver.js'

function adapterError(message, code) {
  return Object.assign(new TypeError(message), { code })
}

export function createCodexProfileAdapter() {
  return {
    id: 'codex',

    validateDraft(draft = {}) {
      const id = String(draft.id || '')
      const kind = draft.kind
      const providerId = kind === 'managed'
        ? codexManagedProviderId(id)
        : draft.providerId
      const common = normaliseProfileDraft({
        ...draft,
        adapterId: 'codex',
        nativeProfileName: codexNativeProfileName(id),
        providerId,
        baseUrl: kind === 'managed' ? draft.baseUrl : null
      })
      if (!common.providerId) throw adapterError('Codex provider is required', 'INVALID_PROVIDER')
      if (kind === 'managed' && !common.baseUrl) {
        throw adapterError('Managed Codex profile requires a base URL', 'INVALID_BASE_URL')
      }
      if (kind === 'reference' && draft.secret) {
        throw adapterError('Reference Codex profile cannot store a secret', 'INVALID_PROFILE')
      }
      const secret = typeof draft.secret === 'string' ? draft.secret : ''
      return {
        common,
        config: { wireApi: 'responses' },
        secretAction: secret
          ? { type: 'replace', value: secret }
          : draft.keepSecret
            ? { type: 'keep' }
            : { type: 'none' }
      }
    },

    sanitiseConfig(config = {}) {
      return {
        wireApi: 'responses',
        recovered: config.recovered === true
      }
    },

    resolveLaunch({ profile, secret }) {
      const env = {}
      if (profile.kind === 'managed' && secret) {
        env[codexProfileSecretEnvName(profile.id)] = secret
      }
      return {
        args: ['--profile', profile.nativeProfileName],
        env,
        artifact: { nativeProfileName: profile.nativeProfileName }
      }
    },

    reconcile({ profile, runtime, fileState, secretState }) {
      return resolveCodexProfileRuntime({ profile, runtime, fileState, secretState })
    }
  }
}
