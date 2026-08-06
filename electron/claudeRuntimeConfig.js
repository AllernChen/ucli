import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CLOUD_PROVIDER_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE'
]

function hasEnvironmentValue(env, key) {
  return typeof env?.[key] === 'string' && env[key].trim().length > 0
}

export function resolveClaudeConfigDir({ env = process.env, userHome } = {}) {
  const configured = typeof env?.CLAUDE_CONFIG_DIR === 'string'
    ? env.CLAUDE_CONFIG_DIR.trim()
    : ''
  if (configured) return resolve(configured)

  const home = String(userHome || env?.HOME || env?.USERPROFILE || '').trim()
  return resolve(home ? join(home, '.claude') : '.claude')
}

export function readClaudeRuntimeSnapshot({ env = process.env, userHome } = {}) {
  const configDir = resolveClaudeConfigDir({ env, userHome })
  const settingsPath = join(configDir, 'settings.json')
  let settingsMtimeMs = 0
  try {
    const stats = statSync(settingsPath)
    settingsMtimeMs = stats.isFile() ? stats.mtimeMs : 0
  } catch {
    settingsMtimeMs = 0
  }

  let inheritedAuthMode = 'login_or_unknown'
  if (hasEnvironmentValue(env, 'ANTHROPIC_API_KEY')) {
    inheritedAuthMode = 'api_key'
  } else if (hasEnvironmentValue(env, 'ANTHROPIC_AUTH_TOKEN')) {
    inheritedAuthMode = 'bearer'
  } else if (CLOUD_PROVIDER_KEYS.some((key) => hasEnvironmentValue(env, key))) {
    inheritedAuthMode = 'cloud_provider'
  }

  return {
    configDir,
    settingsPath,
    settingsMtimeMs,
    inheritedAuthMode
  }
}
