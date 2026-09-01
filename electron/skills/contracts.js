import { load as parseYaml } from 'js-yaml'
import { isAllowedGitLabUrl } from '../../src/gitRemotePolicy.js'

const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function skillError(message, code = 'SKILL_MANIFEST_INVALID') {
  return Object.assign(new Error(message), { code })
}

export function parseSkillManifest(content) {
  if (typeof content !== 'string') throw skillError('SKILL.md must be text')
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!match) throw skillError('SKILL.md must start with YAML frontmatter')
  let metadata
  try {
    metadata = parseYaml(match[1])
  } catch {
    throw skillError('SKILL.md frontmatter is invalid YAML')
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw skillError('SKILL.md frontmatter must be an object')
  }
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
  if (!name || !description) throw skillError('SKILL.md requires name and description')
  if (name.length > 128 || description.length > 1024) {
    throw skillError('Skill name or description is too long')
  }
  return { name, description, metadata, body: content.slice(match[0].length) }
}

export function validateSkillCompatibility(name) {
  const portable = PORTABLE_NAME.test(name) && name.length <= 64
  return {
    claude: { compatible: true, reason: null },
    codex: { compatible: true, reason: null },
    opencode: {
      compatible: portable,
      reason: portable ? null : 'OpenCode requires a lowercase hyphenated skill name'
    },
    ucode: { compatible: true, reason: null },
    'deepseek-harness': { compatible: portable, reason: portable ? null : 'DSH requires a lowercase hyphenated skill name' }
  }
}

export function validateDshSkillName(name) {
  const value = String(name || '').trim()
  if (!PORTABLE_NAME.test(value) || value.length > 64) {
    throw skillError('DSH Skill name must be lowercase and hyphenated')
  }
  return value
}

function cleanRelativePath(value, field) {
  if (value == null || value === '') return ''
  const input = String(value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (input.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw skillError(`${field} is invalid`, 'SKILL_SOURCE_INVALID')
  }
  return input
}

function sanitiseGitSource(source = {}, { host, label, nestedGroups = false, allowSelfHosted = false }) {
  let url
  try { url = new URL(String(source.url || '')) } catch {
    throw skillError(`${label} URL is invalid`, 'SKILL_SOURCE_INVALID')
  }
  const officialHttps = url.protocol === 'https:' && url.hostname.toLowerCase() === host
  if (!officialHttps && (!allowSelfHosted || !isAllowedGitLabUrl(url))) {
    const requirement = allowSelfHosted
      ? `${label} sources require HTTPS, except for private or local HTTP hosts`
      : `Only ${label} HTTPS URLs are supported`
    throw skillError(requirement, 'SKILL_SOURCE_INVALID')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const namespaces = parts.slice(0, -1)
  const repository = parts.at(-1) || ''
  if ((!nestedGroups && parts.length !== 2) || (nestedGroups && parts.length < 2) ||
    namespaces.some((part) => !/^[\w.-]+$/.test(part)) || !/^[\w.-]+(?:\.git)?$/.test(repository)) {
    throw skillError(`${label} repository URL is invalid`, 'SKILL_SOURCE_INVALID')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const ref = source.ref == null ? '' : String(source.ref).trim()
  if (ref.includes('\0') || ref.length > 256) throw skillError('Git ref is invalid', 'SKILL_SOURCE_INVALID')
  return {
    url: url.toString().replace(/\/$/, ''),
    ref,
    subdir: cleanRelativePath(source.subdir, `${label} subdirectory`)
  }
}

export function sanitiseGitHubSource(source = {}) {
  return sanitiseGitSource(source, { host: 'github.com', label: 'GitHub' })
}

export function sanitiseGitLabSource(source = {}) {
  return sanitiseGitSource(source, {
    host: 'gitlab.com', label: 'GitLab', nestedGroups: true, allowSelfHosted: true
  })
}

export function sanitiseGitRemoteSource(source = {}) {
  let hostname
  try { hostname = new URL(String(source.url || '')).hostname.toLowerCase() } catch {
    throw skillError('Git repository URL is invalid', 'SKILL_SOURCE_INVALID')
  }
  if (hostname === 'github.com') return { type: 'github', ...sanitiseGitHubSource(source) }
  return { type: 'gitlab', ...sanitiseGitLabSource(source) }
}

export function sanitiseSkillError(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('SKILL_')
    ? error.code
    : 'SKILL_OPERATION_FAILED'
  const safeMessage = code === 'SKILL_PROJECTION_RECOVERY_REQUIRED'
    ? 'Skill projection recovery is required'
    : code === 'SKILL_OPERATION_FAILED' ? 'Skill operation failed' : error.message
  const safe = Object.assign(new Error(safeMessage), { code })
  if (code === 'SKILL_PROJECTION_ROLLBACK_FAILED' && error?.recoveryAction === 'retry_apply_codex') {
    safe.recoveryAction = 'retry_apply_codex'
  }
  return safe
}
