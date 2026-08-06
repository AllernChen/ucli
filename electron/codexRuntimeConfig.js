import { existsSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { parse } from 'smol-toml'

const DEFAULT_PROVIDER = 'openai'

/** Resolve the Codex home directory without reading user configuration. */
export function resolveCodexHome({ configuredDir, env = process.env, userHome } = {}) {
  const selected = String(configuredDir || env.CODEX_HOME || '').trim()
  if (selected) return resolve(selected)

  const home = String(userHome || env.HOME || env.USERPROFILE || '').trim()
  return resolve(home ? join(home, '.codex') : '.codex')
}

/** Parse only the non-sensitive provider identity needed by UCLI. */
export function parseCodexProviderIdentity(content = '') {
  const providerCatalog = parseCodexProviderCatalog(content)
  const availableProviders = providerCatalog.map((provider) => provider.id)
  try {
    const config = parse(String(content || ''))
    const declared = typeof config?.model_provider === 'string' ? config.model_provider : DEFAULT_PROVIDER
    return {
      currentProvider: availableProviders.includes(declared) ? declared : DEFAULT_PROVIDER,
      availableProviders
    }
  } catch {
    return { currentProvider: DEFAULT_PROVIDER, availableProviders }
  }
}

/** Return only safe provider labels. Endpoint, headers, environment keys and
 * all other provider fields remain inside the main process. */
export function parseCodexProviderCatalog(content = '') {
  const catalog = [{ id: DEFAULT_PROVIDER, displayName: 'OpenAI' }]
  try {
    const config = parse(String(content || ''))
    const providers = config?.model_providers && typeof config.model_providers === 'object'
      ? config.model_providers
      : {}
    for (const [id, provider] of Object.entries(providers)) {
      if (!isSafeProviderName(id)) continue
      const candidate = typeof provider?.name === 'string' ? provider.name.trim() : ''
      const displayName = candidate && candidate.length <= 80 && !/[\u0000-\u001f\u007f]/.test(candidate)
        ? candidate
        : id
      catalog.push({ id, displayName })
    }
  } catch {
    // Invalid config safely falls back to the built-in provider.
  }
  return catalog
}

/** Return a sanitised runtime snapshot. Config contents and credentials must
 * never cross the Electron main-process boundary. */
export function readCodexRuntimeSnapshot(codexHome) {
  const resolvedHome = resolve(codexHome || '.codex')
  const configPath = join(resolvedHome, 'config.toml')
  if (!existsSync(configPath)) {
    return {
      codexHome: resolvedHome,
      configPath,
      ...parseCodexProviderIdentity(),
      providerCatalog: parseCodexProviderCatalog(),
      revision: 0,
      mtimeMs: 0
    }
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    return {
      codexHome: resolvedHome,
      configPath,
      ...parseCodexProviderIdentity(content),
      providerCatalog: parseCodexProviderCatalog(content),
      revision: 0,
      mtimeMs: statSync(configPath).mtimeMs
    }
  } catch {
    return {
      codexHome: resolvedHome,
      configPath,
      ...parseCodexProviderIdentity(),
      providerCatalog: parseCodexProviderCatalog(),
      revision: 0,
      mtimeMs: 0
    }
  }
}

function isSafeProviderName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]+$/.test(value)
}
