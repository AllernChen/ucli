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
  try {
    const config = parse(String(content || ''))
    const providers = config?.model_providers && typeof config.model_providers === 'object'
      ? config.model_providers
      : {}
    const available = new Set([DEFAULT_PROVIDER])
    for (const provider of Object.keys(providers)) {
      if (isSafeProviderName(provider)) available.add(provider)
    }

    const declared = typeof config?.model_provider === 'string' ? config.model_provider : DEFAULT_PROVIDER
    return {
      currentProvider: available.has(declared) ? declared : DEFAULT_PROVIDER,
      availableProviders: Array.from(available)
    }
  } catch {
    return { currentProvider: DEFAULT_PROVIDER, availableProviders: [DEFAULT_PROVIDER] }
  }
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
      mtimeMs: 0
    }
  }

  try {
    return {
      codexHome: resolvedHome,
      configPath,
      ...parseCodexProviderIdentity(readFileSync(configPath, 'utf8')),
      mtimeMs: statSync(configPath).mtimeMs
    }
  } catch {
    return {
      codexHome: resolvedHome,
      configPath,
      ...parseCodexProviderIdentity(),
      mtimeMs: 0
    }
  }
}

function isSafeProviderName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]+$/.test(value)
}
