import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'

import { isSafeNativeProfileName, normaliseProfileDraft } from './contracts.js'

const PROFILE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const OWNED_FILE_PATTERN = /^(ucli-[a-f0-9]{32})\.config\.toml$/
const MARKER_PATTERN = /^# ucli-profile-id: ([a-f0-9-]+)$/
const SERVER_PROFILE_ID_PATTERN = /^[a-f0-9]{32}$/
const SERVER_OWNED_FILE_PATTERN = /^(ucli-server-[a-f0-9]{32})\.config\.toml$/
const SERVER_MARKER_PATTERN = /^# ucli-server-profile-id: ([a-f0-9]{32})$/
const MAX_PROFILE_FILE_BYTES = 1024 * 1024

function fileError(message, code) {
  return Object.assign(new Error(message), { code })
}

function assertProfileId(profileId) {
  const value = String(profileId || '').toLowerCase()
  if (!PROFILE_ID_PATTERN.test(value)) {
    throw fileError('Profile id is invalid', 'INVALID_PROFILE_ID')
  }
  return value
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function codexProfileSecretEnvName(profileId) {
  const value = assertProfileId(profileId)
  return `UCLI_CODEX_PROFILE_${value.replaceAll('-', '_').toUpperCase()}`
}

export function codexManagedProviderId(profileId) {
  return `ucli_${assertProfileId(profileId).replaceAll('-', '').slice(0, 12)}`
}

function assertRegularOwnedTarget(path) {
  if (!existsSync(path)) {
    throw fileError('Codex profile file is missing', 'PROFILE_FILE_MISSING')
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw fileError('Codex profile file is not owned by UCLI', 'PROFILE_FILE_NOT_OWNED')
  }
  if (stat.size > MAX_PROFILE_FILE_BYTES) {
    throw fileError('Codex profile file is too large', 'PROFILE_FILE_TOO_LARGE')
  }
}

function sanitiseInspectedConfig(config) {
  const result = {}
  for (const key of ['model', 'model_reasoning_effort', 'model_context_window', 'model_provider']) {
    if (config[key] !== undefined) result[key] = config[key]
  }
  const providerId = typeof result.model_provider === 'string' ? result.model_provider : null
  const provider = providerId && config.model_providers?.[providerId]
  if (provider && typeof provider === 'object' && !Array.isArray(provider)) {
    const safeProvider = {}
    for (const key of ['name', 'base_url', 'env_key', 'wire_api', 'requires_openai_auth']) {
      if (provider[key] !== undefined) safeProvider[key] = provider[key]
    }
    result.model_providers = { [providerId]: safeProvider }
  }
  return result
}

function stringifyCodexProfileConfig(config) {
  let rendered = stringify(config).trimEnd()
  if (config.model_providers && !/^\[model_providers\]$/m.test(rendered)) {
    rendered = rendered.replace(/^\[model_providers\./m, '[model_providers]\n$&')
  }
  return `${rendered}\n`
}

export function codexNativeProfileName(profileId) {
  return `ucli-${assertProfileId(profileId).replaceAll('-', '')}`
}

function assertServerProfileId(profileId) {
  const value = String(profileId || '').toLowerCase()
  if (!SERVER_PROFILE_ID_PATTERN.test(value)) {
    throw fileError('Server profile id is invalid', 'INVALID_PROFILE_ID')
  }
  return value
}

export function serverCodexNativeProfileName(profileId) {
  return `ucli-server-${assertServerProfileId(profileId)}`
}

export function serverCodexProfileSecretEnvName(profileId) {
  return `UCLI_SERVER_PROFILE_${assertServerProfileId(profileId).toUpperCase()}`
}

export function resolveCodexProfilePath(codexHome, nativeProfileName) {
  if (!isSafeNativeProfileName(nativeProfileName)) {
    throw fileError('Native profile name is invalid', 'INVALID_NATIVE_PROFILE_NAME')
  }
  const root = resolve(String(codexHome || ''))
  const path = resolve(root, `${nativeProfileName}.config.toml`)
  if (path === root || !path.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw fileError('Codex profile path escapes its configuration directory', 'INVALID_NATIVE_PROFILE_NAME')
  }
  return path
}

export function resolveServerCodexProfilePath(codexHome, nativeProfileName) {
  if (typeof nativeProfileName !== 'string' || !SERVER_OWNED_FILE_PATTERN.test(`${nativeProfileName}.config.toml`)) {
    throw fileError('Server native profile name is invalid', 'INVALID_NATIVE_PROFILE_NAME')
  }
  const root = resolve(String(codexHome || ''))
  const path = resolve(root, `${nativeProfileName}.config.toml`)
  if (path === root || !path.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw fileError('Codex profile path escapes its configuration directory', 'INVALID_NATIVE_PROFILE_NAME')
  }
  return path
}

export function renderServerCodexProfileFile({ id, name, model, contextWindow }, {
  baseUrl,
  envKey = serverCodexProfileSecretEnvName(id)
} = {}) {
  const profileId = assertServerProfileId(id)
  const baseUrlResult = new URL(String(baseUrl || ''))
  if (baseUrlResult.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrlResult.hostname)) {
    throw fileError('Server Codex profile requires a loopback base URL', 'INVALID_BASE_URL')
  }
  const safeModel = String(model || '').trim()
  const safeName = String(name || '').trim()
  if (!safeModel || !safeName || !Number.isSafeInteger(contextWindow) || contextWindow <= 0 ||
    !/^UCLI_SERVER_[A-Z0-9_]+$/.test(envKey)) {
    throw fileError('Server Codex profile is invalid', 'INVALID_PROFILE')
  }
  const providerId = `ucli_server_${profileId.slice(0, 12)}`
  return `# ucli-server-profile-id: ${profileId}\n${stringifyCodexProfileConfig({
    model: safeModel,
    model_context_window: contextWindow,
    model_provider: providerId,
    model_providers: {
      [providerId]: {
        name: safeName,
        base_url: baseUrlResult.origin,
        env_key: envKey,
        wire_api: 'responses',
        requires_openai_auth: false
      }
    }
  })}`
}

export function inspectServerCodexProfileFile(path) {
  if (!SERVER_OWNED_FILE_PATTERN.test(basename(path))) {
    throw fileError('Codex server profile file is not in the UCLI namespace', 'PROFILE_FILE_NOT_OWNED')
  }
  assertRegularOwnedTarget(path)
  const content = readFileSync(path)
  const text = content.toString('utf8').replace(/\r\n/g, '\n')
  const marker = text.split('\n', 1)[0].match(SERVER_MARKER_PATTERN)
  if (!marker) throw fileError('Codex server profile ownership marker is missing', 'PROFILE_FILE_NOT_OWNED')
  const profileId = assertServerProfileId(marker[1])
  if (basename(path) !== `${serverCodexNativeProfileName(profileId)}.config.toml`) {
    throw fileError('Codex server profile ownership marker does not match its file', 'PROFILE_FILE_NOT_OWNED')
  }
  try {
    return { profileId, sha256: sha256(content), config: sanitiseInspectedConfig(parse(text.slice(text.indexOf('\n') + 1))) }
  } catch (error) {
    if (error?.code) throw error
    throw fileError('Codex server profile file is invalid', 'PROFILE_FILE_INVALID')
  }
}

export function writeServerCodexProfileFileAtomic({ codexHome, profile, baseUrl, envKey }) {
  const nativeProfileName = serverCodexNativeProfileName(profile?.id)
  const path = resolveServerCodexProfilePath(codexHome, nativeProfileName)
  if (existsSync(path)) inspectServerCodexProfileFile(path)
  const data = Buffer.from(renderServerCodexProfileFile(profile, { baseUrl, envKey }), 'utf8')
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  let handle = null
  try {
    handle = openSync(tempPath, 'wx')
    let offset = 0
    while (offset < data.length) offset += writeSync(handle, data, offset, data.length - offset)
    fsyncSync(handle)
    closeSync(handle)
    handle = null
    renameSync(tempPath, path)
  } finally {
    if (handle !== null) try { closeSync(handle) } catch { /* best effort */ }
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best effort */ }
  }
  return { path, sha256: sha256(data) }
}

export function cleanStaleServerCodexProfileFiles({ codexHome, validArtifactIds } = {}) {
  const root = resolve(String(codexHome || ''))
  const valid = validArtifactIds instanceof Set ? validArtifactIds : new Set(validArtifactIds || [])
  let removed = 0
  for (const name of readdirSync(root)) {
    const match = name.match(SERVER_OWNED_FILE_PATTERN)
    if (!match || valid.has(match[1].slice('ucli-server-'.length))) continue
    const path = resolveServerCodexProfilePath(root, match[1])
    try {
      const inspected = inspectServerCodexProfileFile(path)
      if (inspected.profileId !== match[1].slice('ucli-server-'.length)) continue
      unlinkSync(path)
      removed += 1
    } catch {
      // Leave unowned, malformed, or concurrently changed files untouched.
    }
  }
  return removed
}

export function renderCodexProfileFile(profile) {
  const profileId = assertProfileId(profile?.id)
  const normalised = normaliseProfileDraft({
    ...profile,
    adapterId: 'codex',
    nativeProfileName: codexNativeProfileName(profileId)
  })
  if (!normalised.providerId) {
    throw fileError('Codex provider is required', 'INVALID_PROVIDER')
  }

  const config = {}
  if (normalised.model) config.model = normalised.model
  if (normalised.reasoningEffort) config.model_reasoning_effort = normalised.reasoningEffort
  if (normalised.contextWindow) config.model_context_window = normalised.contextWindow

  if (normalised.kind === 'managed') {
    const providerId = codexManagedProviderId(profileId)
    if (!normalised.baseUrl) {
      throw fileError('Managed Codex profiles require a base URL', 'INVALID_BASE_URL')
    }
    config.model_provider = providerId
    config.model_providers = {
      [providerId]: {
        name: normalised.name,
        base_url: normalised.baseUrl,
        env_key: codexProfileSecretEnvName(profileId),
        wire_api: 'responses',
        requires_openai_auth: false
      }
    }
  } else {
    config.model_provider = normalised.providerId
  }

  return `# ucli-profile-id: ${profileId}\n${stringifyCodexProfileConfig(config)}`
}

export function inspectCodexProfileFile(path) {
  if (!OWNED_FILE_PATTERN.test(basename(path))) {
    throw fileError('Codex profile file is not in the UCLI namespace', 'PROFILE_FILE_NOT_OWNED')
  }
  assertRegularOwnedTarget(path)
  const content = readFileSync(path)
  const text = content.toString('utf8').replace(/\r\n/g, '\n')
  const marker = text.split('\n', 1)[0].match(MARKER_PATTERN)
  if (!marker) {
    throw fileError('Codex profile ownership marker is missing', 'PROFILE_FILE_NOT_OWNED')
  }
  const profileId = assertProfileId(marker[1])
  const expectedName = `${codexNativeProfileName(profileId)}.config.toml`
  if (basename(path) !== expectedName) {
    throw fileError('Codex profile ownership marker does not match its file', 'PROFILE_FILE_NOT_OWNED')
  }

  try {
    return {
      profileId,
      sha256: sha256(content),
      config: sanitiseInspectedConfig(parse(text.slice(text.indexOf('\n') + 1)))
    }
  } catch (error) {
    if (error?.code) throw error
    throw fileError('Codex profile file is invalid', 'PROFILE_FILE_INVALID')
  }
}

export function writeCodexProfileFileAtomic({ codexHome, profile, expectedSha256 = null }) {
  const nativeProfileName = codexNativeProfileName(profile?.id)
  const path = resolveCodexProfilePath(codexHome, nativeProfileName)
  if (existsSync(path)) {
    const inspected = inspectCodexProfileFile(path)
    if (!expectedSha256 || inspected.sha256 !== expectedSha256) {
      throw fileError('Codex profile file changed outside UCLI', 'PROFILE_FILE_DRIFTED')
    }
  }

  const data = Buffer.from(renderCodexProfileFile(profile), 'utf8')
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  let handle = null
  try {
    handle = openSync(tempPath, 'wx')
    let offset = 0
    while (offset < data.length) {
      offset += writeSync(handle, data, offset, data.length - offset)
    }
    fsyncSync(handle)
    closeSync(handle)
    handle = null
    renameSync(tempPath, path)
  } finally {
    if (handle !== null) {
      try { closeSync(handle) } catch { /* best effort */ }
    }
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best effort */ }
  }

  return { path, sha256: sha256(data) }
}

export function removeCodexProfileFile({ codexHome, profile, expectedSha256 }) {
  const path = resolveCodexProfilePath(codexHome, codexNativeProfileName(profile?.id))
  if (!existsSync(path)) return false
  const inspected = inspectCodexProfileFile(path)
  if (!expectedSha256 || inspected.sha256 !== expectedSha256) {
    throw fileError('Codex profile file changed outside UCLI', 'PROFILE_FILE_DRIFTED')
  }
  unlinkSync(path)
  return true
}
