import { load as parseYaml } from 'js-yaml'

const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function skillError(message, code = 'SKILL_MANIFEST_INVALID') {
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
    ucode: { compatible: true, reason: null }
  }
}

function cleanRelativePath(value, field) {
  if (value == null || value === '') return ''
  const input = String(value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (input.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw skillError(`${field} is invalid`, 'SKILL_SOURCE_INVALID')
  }
  return input
}

export function sanitiseGitHubSource(source = {}) {
  let url
  try { url = new URL(String(source.url || '')) } catch {
    throw skillError('GitHub URL is invalid', 'SKILL_SOURCE_INVALID')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw skillError('Only GitHub HTTPS URLs are supported', 'SKILL_SOURCE_INVALID')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || !/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+(?:\.git)?$/.test(parts[1])) {
    throw skillError('GitHub repository URL is invalid', 'SKILL_SOURCE_INVALID')
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
    subdir: cleanRelativePath(source.subdir, 'GitHub subdirectory')
  }
}

export function sanitiseSkillError(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('SKILL_')
    ? error.code
    : 'SKILL_OPERATION_FAILED'
  return Object.assign(new Error(code === 'SKILL_OPERATION_FAILED' ? 'Skill operation failed' : error.message), { code })
}
