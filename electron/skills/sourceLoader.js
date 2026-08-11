import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import AdmZip from 'adm-zip'

import { sanitiseGitHubSource, sanitiseGitLabSource, sanitiseGitRemoteSource, validateSkillCompatibility } from './contracts.js'
import { inspectSkillDirectory } from './fileOps.js'
import { isPrivateNetworkHostname } from '../../src/gitRemotePolicy.js'

function sourceError(message, code = 'SKILL_SOURCE_INVALID') {
  return Object.assign(new Error(message), { code })
}

function defaultRunGit(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    throw sourceError('Git source could not be read', 'SKILL_GIT_FAILED')
  }
}

function safeChild(root, subdir) {
  const path = resolve(root, subdir || '.')
  const pathRelative = relative(resolve(root), path)
  if (pathRelative === '..' || pathRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw sourceError('Skill subdirectory escapes the source root')
  }
  return path
}

function preview(prepared) {
  const inspected = inspectSkillDirectory(prepared.workingDirectory)
  return {
    kind: 'skill',
    name: inspected.name,
    description: inspected.description,
    manifest: inspected.manifest,
    contentSha256: inspected.contentSha256,
    fileList: inspected.fileList,
    totalBytes: inspected.totalBytes,
    compatibility: validateSkillCompatibility(inspected.name),
    source: prepared.source,
    resolvedRevision: prepared.resolvedRevision || null
  }
}

function findSkillRoots(directory, results = [], options = {}, state = { directories: 0, entries: 0 }, depth = 0) {
  const ignoredDirectories = options.ignoredDirectories || new Set()
  const maxRoots = options.maxRoots ?? Number.POSITIVE_INFINITY
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY
  const maxDirectories = options.maxDirectories ?? Number.POSITIVE_INFINITY
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY
  if (depth > maxDepth) throw sourceError('Skill repository exceeds the collection scan limit', 'SKILL_PACKAGE_TOO_LARGE')

  state.directories += 1
  if (state.directories > maxDirectories) {
    throw sourceError('Skill repository exceeds the collection scan limit', 'SKILL_PACKAGE_TOO_LARGE')
  }
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
  state.entries += entries.length
  if (state.entries > maxEntries) {
    throw sourceError('Skill repository exceeds the collection scan limit', 'SKILL_PACKAGE_TOO_LARGE')
  }

  const hasManifest = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')
  if (hasManifest) results.push(directory)
  if (results.length > maxRoots) {
    throw sourceError('Skill repository contains too many packages', 'SKILL_PACKAGE_TOO_LARGE')
  }
  if (hasManifest && options.stopAtSkillRoot) return results
  for (const entry of entries) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      findSkillRoots(resolve(directory, entry.name), results, options, state, depth + 1)
    }
  }
  return results
}

function collectionPreview(prepared, rootManifestError, scanLimits = {}) {
  const roots = findSkillRoots(prepared.workingDirectory, [], {
    ignoredDirectories: new Set(['.git', 'node_modules']),
    maxRoots: scanLimits.maxRoots ?? 200,
    maxDepth: scanLimits.maxDepth ?? 16,
    maxDirectories: scanLimits.maxDirectories ?? 5000,
    maxEntries: scanLimits.maxEntries ?? 20000,
    stopAtSkillRoot: true
  })
  if (!roots.length) throw rootManifestError

  const baseSubdir = String(prepared.source.subdir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const skills = []
  const invalidSkills = []
  for (const skillRoot of roots) {
    const nestedSubdir = relative(prepared.workingDirectory, skillRoot).replace(/\\/g, '/')
    const subdir = [baseSubdir, nestedSubdir].filter(Boolean).join('/')
    try {
      const inspected = inspectSkillDirectory(skillRoot)
      skills.push({
        name: inspected.name,
        description: inspected.description,
        subdir,
        fileList: inspected.fileList,
        totalBytes: inspected.totalBytes,
        compatibility: validateSkillCompatibility(inspected.name)
      })
    } catch (error) {
      if (!String(error?.code || '').startsWith('SKILL_')) throw error
      invalidSkills.push({ subdir, code: error.code })
    }
  }
  skills.sort((left, right) => left.subdir.localeCompare(right.subdir))
  invalidSkills.sort((left, right) => left.subdir.localeCompare(right.subdir))
  if (!skills.length) {
    throw sourceError('Skill repository does not contain a valid Skill package', 'SKILL_MANIFEST_INVALID')
  }

  return {
    kind: 'collection',
    skills,
    invalidSkills,
    source: prepared.source,
    resolvedRevision: prepared.resolvedRevision || null
  }
}

function extractZipSource(archive, stagingRoot) {
  const destination = resolve(stagingRoot, `zip-${randomUUID()}`)
  mkdirSync(destination, { recursive: true })
  try {
    const zip = new AdmZip(archive)
    const entries = zip.getEntries()
    let totalBytes = 0
    if (entries.length > 2000) throw sourceError('ZIP contains too many files', 'SKILL_PACKAGE_TOO_LARGE')
    for (const entry of entries) {
      const name = String(entry.entryName || '').replace(/\\/g, '/')
      const parts = name.split('/').filter(Boolean)
      if (!name || name.includes('\0') || name.startsWith('/') || parts.some((part) => part === '..' || part === '.')) {
        throw sourceError('ZIP contains an unsafe path', 'SKILL_PACKAGE_UNSAFE')
      }
      const size = Number(entry.header?.size || 0)
      if (size > 10 * 1024 * 1024) throw sourceError('ZIP file exceeds the size limit', 'SKILL_PACKAGE_TOO_LARGE')
      totalBytes += size
      if (totalBytes > 50 * 1024 * 1024) throw sourceError('ZIP exceeds the size limit', 'SKILL_PACKAGE_TOO_LARGE')
    }
    zip.extractAllTo(destination, true)
    const roots = findSkillRoots(destination)
    if (roots.length !== 1) throw sourceError('ZIP must contain exactly one Skill package')
    return { destination, workingDirectory: roots[0] }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true })
    if (error?.code?.startsWith('SKILL_')) throw error
    throw sourceError('ZIP could not be extracted', 'SKILL_PACKAGE_UNSAFE')
  }
}

export function createSkillSourceLoader({ stagingRoot, runGit = defaultRunGit, collectionScanLimits = {} } = {}) {
  const root = resolve(stagingRoot || '.ucli-skill-staging')
  mkdirSync(root, { recursive: true })

  async function prepare(source = {}) {
    if (source.type === 'local') {
      const path = resolve(String(source.path || ''))
      if (!existsSync(path)) throw sourceError('Local skill source was not found', 'SKILL_SOURCE_NOT_FOUND')
      if (!statSync(path).isDirectory()) {
        if (extname(path).toLowerCase() === '.zip') {
          const extracted = extractZipSource(path, root)
          return {
            workingDirectory: extracted.workingDirectory,
            source: { type: 'zip', locator: path, ref: '', subdir: '' },
            resolvedRevision: null,
            cleanup() { rmSync(extracted.destination, { recursive: true, force: true }) }
          }
        }
        throw sourceError('Local skill source must be a directory or ZIP file')
      }
      return {
        workingDirectory: path,
        source: { type: 'local', locator: path, ref: '', subdir: '' },
        resolvedRevision: null,
        cleanup() {}
      }
    }

    if (source.type === 'github' || source.type === 'gitlab' || source.type === 'git') {
      const resolved = source.type === 'git'
        ? sanitiseGitRemoteSource(source)
        : { type: source.type, ...(source.type === 'github' ? sanitiseGitHubSource(source) : sanitiseGitLabSource(source)) }
      const checkout = resolve(root, `${resolved.type}-${randomUUID()}`)
      const repositoryUrl = new URL(resolved.url)
      const gitPrefix = repositoryUrl.protocol === 'http:' && isPrivateNetworkHostname(repositoryUrl.hostname)
        ? ['-c', 'http.proxy=']
        : []
      const runSourceGit = (args) => runGit([...gitPrefix, ...args])
      mkdirSync(dirname(checkout), { recursive: true })
      if (source.refType === 'commit') {
        runSourceGit(['clone', '--filter=blob:none', '--no-checkout', resolved.url, checkout])
        runSourceGit(['-C', checkout, 'fetch', '--depth', '1', 'origin', resolved.ref])
        runSourceGit(['-C', checkout, 'checkout', '--detach', 'FETCH_HEAD'])
      } else {
        const args = ['clone', '--depth', '1']
        if (resolved.ref) args.push('--branch', resolved.ref)
        args.push(resolved.url, checkout)
        runSourceGit(args)
      }
      const workingDirectory = safeChild(checkout, resolved.subdir)
      const resolvedRevision = String(runSourceGit(['-C', checkout, 'rev-parse', 'HEAD']) || '').trim()
      return {
        workingDirectory,
        source: {
          type: resolved.type,
          locator: resolved.url,
          ref: resolved.ref,
          subdir: resolved.subdir
        },
        resolvedRevision,
        cleanup() { rmSync(checkout, { recursive: true, force: true }) }
      }
    }
    throw sourceError('Skill source type is invalid')
  }

  return {
    async withPrepared(source, work) {
      const prepared = await prepare(source)
      try { return await work(prepared) } finally { prepared.cleanup() }
    },
    inspect(source) {
      return this.withPrepared(source, async (prepared) => {
        const isGitSource = ['github', 'gitlab'].includes(prepared.source.type)
        const rootManifest = resolve(prepared.workingDirectory, 'SKILL.md')
        if (isGitSource && !existsSync(rootManifest)) {
          const missingManifest = sourceError('Skill package requires a root SKILL.md', 'SKILL_MANIFEST_INVALID')
          return collectionPreview(prepared, missingManifest, collectionScanLimits)
        }
        return preview(prepared)
      })
    }
  }
}
