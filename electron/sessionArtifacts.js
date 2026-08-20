import path from 'node:path'

export const FILE_CREATING_TOOLS = new Set([
  'write', 'edit', 'notebookedit', 'apply_patch', 'patch',
  'write_file', 'edit_file', 'create_file', 'update_file'
])

function artifactError(code) {
  return Object.assign(new Error(code), { code })
}

function pathApiFor(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
    ? path.win32
    : path.posix
}

function isFileCreatingTool(name) {
  return typeof name === 'string' && FILE_CREATING_TOOLS.has(name.toLowerCase())
}

function firstPath(input) {
  if (!input || typeof input !== 'object') return null
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key]
  }
  return null
}

function safeArguments(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function parseClaudeArtifactPaths(records) {
  const paths = []
  for (const record of records || []) {
    const content = record?.message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type !== 'tool_use' || !isFileCreatingTool(part.name)) continue
      const p = firstPath(part.input)
      if (p) paths.push(p)
    }
  }
  return paths
}

export function parseCodexArtifactPaths(records) {
  const paths = []
  for (const record of records || []) {
    if (record?.type !== 'response_item') continue
    const payload = record.payload || {}
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue
    if (!isFileCreatingTool(payload.name)) continue
    const p = firstPath(safeArguments(payload.arguments))
    if (p) paths.push(p)
  }
  return paths
}

export function parseOpenCodeArtifactPaths(source) {
  const paths = []
  const messages = Array.isArray(source?.messages) ? source.messages : []
  for (const message of messages) {
    const parts = Array.isArray(message?.parts) ? message.parts : []
    for (const part of parts) {
      if (part?.type !== 'tool') continue
      const tool = part.tool || {}
      const toolName = typeof tool === 'string' ? tool : (tool.name || tool.tool)
      if (!isFileCreatingTool(toolName)) continue
      const input = part.state?.input || {}
      for (const key of ['filePath', 'file_path', 'path']) {
        if (typeof input[key] === 'string' && input[key].trim()) {
          paths.push(input[key])
          break
        }
      }
    }
  }
  return paths
}

export function artifactKindFromPath(filePath) {
  const ext = String(filePath || '').split('.').pop().toLowerCase()
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return 'markdown'
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) return 'image'
  return 'text'
}

export function imageMimeTypeFromPath(filePath) {
  const ext = String(filePath || '').split('.').pop().toLowerCase()
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif'
  }
  return map[ext] || null
}

export function assertInsideDirectory(root, candidate) {
  if (typeof root !== 'string' || !root.trim() ||
      typeof candidate !== 'string' || !candidate.trim()) {
    throw artifactError('ARTIFACT_PATH_UNSAFE')
  }
  const pathApi = pathApiFor(root)
  if (!pathApi.isAbsolute(root) || !pathApi.isAbsolute(candidate)) {
    throw artifactError('ARTIFACT_PATH_UNSAFE')
  }
  const resolvedRoot = pathApi.resolve(root)
  const resolvedCandidate = pathApi.resolve(candidate)
  // Windows paths are case-insensitive: compare a case-folded copy so a cwd
  // that differs from the on-disk path only by letter case is still inside.
  const compareRoot = pathApi === path.win32 ? resolvedRoot.toLowerCase() : resolvedRoot
  const compareCandidate = pathApi === path.win32 ? resolvedCandidate.toLowerCase() : resolvedCandidate
  const relative = pathApi.relative(compareRoot, compareCandidate)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    throw artifactError('ARTIFACT_PATH_UNSAFE')
  }
  return resolvedCandidate
}

export function resolveArtifactAbsolutePath(raw, cwd) {
  const value = String(raw || '')
  if (!value.trim()) return null
  if (value.startsWith('/')) return path.posix.normalize(value)
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value)
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  if (cwd.startsWith('/')) return path.posix.resolve(cwd, value.replaceAll('\\', '/'))
  if (path.win32.isAbsolute(cwd)) return path.win32.resolve(cwd, value)
  return null
}
