import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { createCodexProfileAdapter } from './codexProfileAdapter.js'
import { codexNativeProfileName } from './codexProfileFile.js'
import { sanitiseProfile } from './contracts.js'
import { createProfileAdapterRegistry } from './profileAdapterRegistry.js'
import { resolveSessionProfile as resolveProfileSelection } from './profileResolver.js'

const OWNED_PROFILE_FILE = /^(ucli-[a-f0-9]{32})\.config\.toml$/

function serviceError(message, code) {
  return Object.assign(new Error(message), { code })
}

function profileSnapshot(profile) {
  return {
    adapterId: profile.adapterId,
    name: profile.name,
    kind: profile.kind,
    nativeProfileName: profile.nativeProfileName,
    providerId: profile.providerId,
    baseUrl: profile.baseUrl,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    contextWindow: profile.contextWindow,
    config: profile.config && typeof profile.config === 'object'
      ? structuredClone(profile.config)
      : {}
  }
}

function projectScopeKey(value) {
  const path = resolve(String(value || '.'))
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function createProfileService({
  db,
  secretStore,
  resolveCodexHome,
  readCodexRuntime,
  fileOps,
  adapterRegistry = createProfileAdapterRegistry([createCodexProfileAdapter()]),
  listFiles = (directory) => readdirSync(directory),
  uuid = randomUUID,
  now = Date.now,
  flush = () => db.flush()
}) {
  async function persistOrThrow() {
    try {
      const result = await flush()
      if (result === false) throw new Error('flush failed')
    } catch {
      throw serviceError('Profile changes are pending persistence', 'PROFILE_PERSISTENCE_PENDING')
    }
  }

  function adapterFor(adapterId) {
    const adapter = adapterRegistry.get(adapterId)
    if (!adapter) throw serviceError('Profile adapter is unavailable', 'PROFILE_ADAPTER_UNAVAILABLE')
    return adapter
  }

  function fileStateFor(profile, codexHome) {
    try {
      const path = fileOps.resolveCodexProfilePath(codexHome, profile.nativeProfileName)
      const inspected = fileOps.inspectCodexProfileFile(path)
      return {
        exists: true,
        owned: inspected.profileId === profile.id,
        sha256: inspected.sha256
      }
    } catch (error) {
      if (error?.code === 'PROFILE_FILE_MISSING') return { exists: false, owned: false, sha256: null }
      return { exists: true, owned: false, sha256: null }
    }
  }

  function secretStateFor(profile) {
    if (profile.kind !== 'managed') {
      return {
        hasSecret: false,
        secretSuffix: null,
        encryptionAvailable: secretStore.isEncryptionAvailable?.() !== false
      }
    }
    try {
      return secretStore.describeSecret(profile.id)
    } catch {
      return {
        hasSecret: Boolean(profile.hasSecretHint),
        secretSuffix: null,
        encryptionAvailable: true,
        decryptionFailed: true
      }
    }
  }

  function runtimeStateFor(profile) {
    const adapter = adapterFor(profile.adapterId)
    const secretState = secretStateFor(profile)
    const runtimeState = adapter.reconcile({
      profile,
      runtime: readCodexRuntime(),
      fileState: fileStateFor(profile, resolveCodexHome()),
      secretState
    })
    return { ...runtimeState, ...secretState }
  }

  function rendererProfile(profile) {
    const state = runtimeStateFor(profile)
    return sanitiseProfile(profile, {
      ...state,
      secretSuffix: state.secretSuffix,
      isAppDefault: db.listAiCliProfileBindings({ profileId: profile.id })
        .some((binding) => binding.scopeType === 'app'),
      isProjectDefault: db.listAiCliProfileBindings({ profileId: profile.id })
        .some((binding) => binding.scopeType === 'project')
    })
  }

  async function updateInternal(profileId, patch, reason) {
    const current = db.getAiCliProfile(profileId)
    if (!current) throw serviceError('Profile was not found', 'PROFILE_NOT_FOUND')
    const adapter = adapterFor(current.adapterId)
    const draft = adapter.validateDraft({
      ...profileSnapshot(current),
      ...patch,
      id: current.id,
      adapterId: current.adapterId,
      keepSecret: patch.secret === undefined
    })
    if (draft.common.kind === 'managed' && draft.secretAction.type === 'none' && !current.hasSecretHint) {
      throw serviceError('Managed profile secret is required', 'PROFILE_SECRET_REQUIRED')
    }
    const timestamp = now()
    const revisionId = uuid()
    await db.transaction(async () => {
      db.insertAiCliProfileRevision({
        id: revisionId,
        profileId,
        config: profileSnapshot(current),
        fileSha256: current.fileSha256,
        reason,
        createdAt: timestamp
      })
      db.updateAiCliProfile(profileId, {
        ...draft.common,
        config: draft.config,
        updatedAt: timestamp
      })
      if (draft.common.kind === 'reference') {
        secretStore.deleteSecret(profileId)
        db.updateAiCliProfile(profileId, { hasSecretHint: false, updatedAt: timestamp })
      } else if (draft.secretAction.type === 'replace') {
        secretStore.setSecret(profileId, draft.secretAction.value)
        db.updateAiCliProfile(profileId, { hasSecretHint: true, updatedAt: timestamp })
      }
      const projected = {
        ...current,
        ...draft.common,
        config: draft.config,
        id: profileId
      }
      const written = fileOps.writeCodexProfileFileAtomic({
        codexHome: resolveCodexHome(),
        profile: projected,
        expectedSha256: current.fileSha256
      })
      db.updateAiCliProfile(profileId, { fileSha256: written.sha256, updatedAt: timestamp })
    })
    await persistOrThrow()
    return rendererProfile(db.getAiCliProfile(profileId))
  }

  const service = {
    listCliConfigurationState({ cwd } = {}) {
      return ['codex', 'claude', 'opencode', 'ucode'].map((adapterId) => ({
        adapterId,
        mode: adapterRegistry.has(adapterId) ? 'profiles' : 'system',
        profileCount: adapterRegistry.has(adapterId)
          ? db.listAiCliProfiles({ adapterId }).length
          : 0,
        projectBinding: adapterRegistry.has(adapterId)
          ? db.getAiCliProfileBinding('project', projectScopeKey(cwd), adapterId)?.profileId || null
          : null
      }))
    },

    listProfiles({ adapterId = 'codex' } = {}) {
      return db.listAiCliProfiles({ adapterId }).map(rendererProfile)
    },

    async createProfile(input) {
      const id = uuid()
      const adapterId = input?.adapterId || 'codex'
      const adapter = adapterFor(adapterId)
      const draft = adapter.validateDraft({ ...input, id, adapterId })
      if (draft.common.kind === 'managed' && draft.secretAction.type !== 'replace') {
        throw serviceError('Managed profile secret is required', 'PROFILE_SECRET_REQUIRED')
      }
      const timestamp = now()
      await db.transaction(async () => {
        db.insertAiCliProfile({
          id,
          ...draft.common,
          config: draft.config,
          hasSecretHint: draft.secretAction.type === 'replace',
          fileSha256: null,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        if (draft.secretAction.type === 'replace') {
          secretStore.setSecret(id, draft.secretAction.value)
        }
        const profile = db.getAiCliProfile(id)
        const written = fileOps.writeCodexProfileFileAtomic({
          codexHome: resolveCodexHome(),
          profile,
          expectedSha256: null
        })
        db.updateAiCliProfile(id, { fileSha256: written.sha256, updatedAt: timestamp })
      })
      await persistOrThrow()
      return rendererProfile(db.getAiCliProfile(id))
    },

    updateProfile(profileId, patch) {
      return updateInternal(profileId, patch, 'update')
    },

    async replaceProfileSecret(profileId, secret) {
      const profile = db.getAiCliProfile(profileId)
      if (!profile) throw serviceError('Profile was not found', 'PROFILE_NOT_FOUND')
      if (profile.kind !== 'managed') throw serviceError('Reference profile cannot store a secret', 'INVALID_PROFILE')
      await db.transaction(async () => {
        secretStore.setSecret(profileId, secret)
        db.updateAiCliProfile(profileId, { hasSecretHint: true, updatedAt: now() })
      })
      await persistOrThrow()
      return rendererProfile(db.getAiCliProfile(profileId))
    },

    async deleteProfileSecret(profileId) {
      const profile = db.getAiCliProfile(profileId)
      if (!profile) throw serviceError('Profile was not found', 'PROFILE_NOT_FOUND')
      await db.transaction(async () => {
        secretStore.deleteSecret(profileId)
        db.updateAiCliProfile(profileId, { hasSecretHint: false, updatedAt: now() })
      })
      await persistOrThrow()
      return rendererProfile(db.getAiCliProfile(profileId))
    },

    async deleteProfile(profileId) {
      const profile = db.getAiCliProfile(profileId)
      if (!profile) return false
      const usage = db.getAiCliProfileUsage(profileId)
      if (usage.sessionCount || usage.bindingCount) {
        throw serviceError('Profile is still in use', 'PROFILE_IN_USE')
      }
      await db.transaction(async () => {
        db.deleteAiCliProfile(profileId)
        for (const revision of db.listAiCliProfileRevisions(profileId)) {
          db.deleteAiCliProfileRevision(revision.id)
        }
        secretStore.deleteSecret(profileId)
        fileOps.removeCodexProfileFile({
          codexHome: resolveCodexHome(),
          profile,
          expectedSha256: profile.fileSha256
        })
      })
      await persistOrThrow()
      return true
    },

    async setBinding({ scopeType, scopeKey, adapterId, profileId }) {
      if (!['app', 'project'].includes(scopeType)) {
        throw serviceError('Profile scope is invalid', 'INVALID_PROFILE_SCOPE')
      }
      const key = scopeType === 'app' ? '*' : projectScopeKey(scopeKey)
      if (profileId) {
        const profile = db.getAiCliProfile(profileId)
        if (!profile || profile.adapterId !== adapterId) {
          throw serviceError('Profile was not found', 'PROFILE_NOT_FOUND')
        }
      }
      db.upsertAiCliProfileBinding({
        scopeType,
        scopeKey: key,
        adapterId,
        profileId: profileId || null,
        updatedAt: now()
      })
      await persistOrThrow()
      return db.getAiCliProfileBinding(scopeType, key, adapterId)
    },

    listRevisions(profileId) {
      return db.listAiCliProfileRevisions(profileId)
    },

    async rollbackProfile(profileId, revisionId) {
      const revision = db.getAiCliProfileRevision(revisionId)
      if (!revision || revision.profileId !== profileId) {
        throw serviceError('Profile revision was not found', 'PROFILE_REVISION_NOT_FOUND')
      }
      return updateInternal(profileId, revision.config, 'rollback')
    },

    resolveSessionProfile(options) {
      return resolveProfileSelection({
        ...options,
        profiles: db.listAiCliProfiles({ adapterId: options.adapterId }),
        bindings: db.listAiCliProfileBindings({ adapterId: options.adapterId })
      })
    },

    resolveCodexLaunchProfile(profileId) {
      const profile = db.getAiCliProfile(profileId)
      if (!profile) throw serviceError('Profile was not found', 'PROFILE_NOT_FOUND')
      const state = runtimeStateFor(profile)
      if (!state.canStart) throw serviceError('Profile is not ready', 'PROFILE_NOT_READY')
      const secret = profile.kind === 'managed' ? secretStore.getSecret(profileId) : null
      return {
        ...adapterFor('codex').resolveLaunch({ profile, secret }),
        status: state.status,
        runtimeRevision: state.runtimeRevision
      }
    },

    async repairProfile(profileId) {
      const profile = db.getAiCliProfile(profileId)
      if (!profile) throw serviceError('Profile was not found', 'PROFILE_NOT_FOUND')
      let expectedSha256 = null
      try {
        const path = fileOps.resolveCodexProfilePath(resolveCodexHome(), profile.nativeProfileName)
        const inspected = fileOps.inspectCodexProfileFile(path)
        if (inspected.profileId !== profile.id) {
          throw serviceError('Profile file is not owned', 'PROFILE_FILE_NOT_OWNED')
        }
        expectedSha256 = inspected.sha256
      } catch (error) {
        if (error?.code !== 'PROFILE_FILE_MISSING') throw error
      }
      const written = fileOps.writeCodexProfileFileAtomic({
        codexHome: resolveCodexHome(),
        profile,
        expectedSha256
      })
      db.updateAiCliProfile(profileId, { fileSha256: written.sha256, updatedAt: now() })
      await persistOrThrow()
      return rendererProfile(db.getAiCliProfile(profileId))
    },

    async reconcileCodexProfiles() {
      const profiles = db.listAiCliProfiles({ adapterId: 'codex' })
      const byNativeName = new Map()
      for (const profile of profiles) {
        const entries = byNativeName.get(profile.nativeProfileName) || []
        entries.push(profile)
        byNativeName.set(profile.nativeProfileName, entries)
      }
      const warnings = []
      const duplicates = new Set()
      for (const [nativeProfileName, entries] of byNativeName) {
        if (entries.length < 2) continue
        duplicates.add(nativeProfileName)
        warnings.push({
          code: 'DUPLICATE_NATIVE_PROFILE_NAME',
          nativeProfileName,
          profileIds: entries.map((profile) => profile.id).sort()
        })
      }

      const recovered = []
      let files = []
      try { files = listFiles(resolveCodexHome()) } catch { /* missing config directory */ }
      const knownIds = new Set(profiles.map((profile) => profile.id))
      for (const filename of files) {
        const match = String(filename).match(OWNED_PROFILE_FILE)
        if (!match) continue
        const path = fileOps.resolveCodexProfilePath(resolveCodexHome(), match[1])
        let inspected
        try { inspected = fileOps.inspectCodexProfileFile(path) } catch { continue }
        if (knownIds.has(inspected.profileId)) continue
        const providerId = inspected.config.model_provider || null
        const provider = providerId ? inspected.config.model_providers?.[providerId] : null
        const timestamp = now()
        let recoveredDraft
        try {
          recoveredDraft = adapterFor('codex').validateDraft({
            id: inspected.profileId,
            adapterId: 'codex',
            name: provider?.name || `Recovered ${inspected.profileId.slice(0, 8)}`,
            kind: provider ? 'managed' : 'reference',
            providerId,
            baseUrl: provider?.base_url || null,
            model: inspected.config.model || null,
            reasoningEffort: inspected.config.model_reasoning_effort || null,
            contextWindow: inspected.config.model_context_window || null
          })
        } catch {
          warnings.push({
            code: 'ORPHAN_PROFILE_INVALID',
            profileId: inspected.profileId
          })
          continue
        }
        db.insertAiCliProfile({
          id: inspected.profileId,
          ...recoveredDraft.common,
          nativeProfileName: codexNativeProfileName(inspected.profileId),
          config: { ...recoveredDraft.config, recovered: true },
          hasSecretHint: false,
          fileSha256: inspected.sha256,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        recovered.push(inspected.profileId)
        knownIds.add(inspected.profileId)
      }
      if (recovered.length) await persistOrThrow()

      const visible = db.listAiCliProfiles({ adapterId: 'codex' })
        .filter((profile) => !duplicates.has(profile.nativeProfileName))
        .map(rendererProfile)
      return { profiles: visible, recovered, warnings }
    }
  }

  return service
}
