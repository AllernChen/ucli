import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { parseSkillManifest } from './contracts.js'

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FILES = 2000

function fileError(message, code) {
  return Object.assign(new Error(message), { code })
}

function safeRelative(root, path) {
  return relative(root, path).split(sep).join('/')
}

function collectFiles(root, limits) {
  const files = []
  let totalBytes = 0
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const inspected = lstatSync(path)
      if (inspected.isSymbolicLink()) throw fileError('Skill packages cannot contain symbolic links', 'SKILL_PACKAGE_UNSAFE')
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile()) throw fileError('Skill packages can only contain files and directories', 'SKILL_PACKAGE_UNSAFE')
      if (inspected.size > limits.maxFileBytes) throw fileError('A skill file exceeds the size limit', 'SKILL_PACKAGE_TOO_LARGE')
      totalBytes += inspected.size
      files.push({ path, relativePath: safeRelative(root, path), size: inspected.size })
      if (files.length > limits.maxFiles || totalBytes > limits.maxBytes) {
        throw fileError('Skill package exceeds the size limit', 'SKILL_PACKAGE_TOO_LARGE')
      }
    }
  }
  visit(root)
  return { files, totalBytes }
}

export function inspectSkillDirectory(directory, options = {}) {
  const root = resolve(String(directory || ''))
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw fileError('Skill directory was not found', 'SKILL_SOURCE_NOT_FOUND')
  }
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES
  }
  const { files, totalBytes } = collectFiles(root, limits)
  files.sort((left, right) => {
    if (left.relativePath === 'SKILL.md') return -1
    if (right.relativePath === 'SKILL.md') return 1
    return left.relativePath.localeCompare(right.relativePath)
  })
  const manifestFile = files.find((item) => item.relativePath === 'SKILL.md')
  if (!manifestFile) throw fileError('Skill package requires a root SKILL.md', 'SKILL_MANIFEST_INVALID')
  const parsed = parseSkillManifest(readFileSync(manifestFile.path, 'utf8'))
  const hash = createHash('sha256')
  const fileHashes = {}
  for (const file of files) {
    const content = readFileSync(file.path)
    hash.update(file.relativePath)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
    fileHashes[file.relativePath] = createHash('sha256').update(content).digest('hex')
  }
  return {
    root,
    name: parsed.name,
    description: parsed.description,
    manifest: parsed.metadata,
    contentSha256: hash.digest('hex'),
    fileList: files.map((file) => file.relativePath),
    fileHashes,
    totalBytes
  }
}

export function diffSkillDirectories(beforeDirectory, afterDirectory) {
  const before = inspectSkillDirectory(beforeDirectory)
  const after = inspectSkillDirectory(afterDirectory)
  const beforeFiles = new Set(before.fileList)
  const afterFiles = new Set(after.fileList)
  const changedFiles = before.fileList.filter((file) =>
    afterFiles.has(file) && before.fileHashes[file] !== after.fileHashes[file]
  )
  return {
    addedFiles: after.fileList.filter((file) => !beforeFiles.has(file)),
    removedFiles: before.fileList.filter((file) => !afterFiles.has(file)),
    changedFiles,
    skillMdChanged: changedFiles.includes('SKILL.md')
  }
}

function uniqueSibling(target, suffix) {
  return join(dirname(target), `.${basename(target)}.${suffix}-${process.pid}-${randomUUID()}`)
}

export function copySkillDirectoryAtomic(sourceDirectory, targetDirectory, { expectedExistingSha256 = null } = {}) {
  const source = inspectSkillDirectory(sourceDirectory)
  const target = resolve(targetDirectory)
  mkdirSync(dirname(target), { recursive: true })
  let existing = null
  if (existsSync(target)) {
    existing = inspectSkillDirectory(target)
    if (!expectedExistingSha256) throw fileError('A skill already exists at the target', 'SKILL_TARGET_CONFLICT')
    if (existing.contentSha256 !== expectedExistingSha256) {
      throw fileError('The managed skill was modified outside UCLI', 'SKILL_DRIFTED')
    }
  }

  const staged = uniqueSibling(target, 'staging')
  const backup = uniqueSibling(target, 'backup')
  try {
    cpSync(source.root, staged, { recursive: true, errorOnExist: true })
    const stagedInspection = inspectSkillDirectory(staged)
    if (stagedInspection.contentSha256 !== source.contentSha256) {
      throw fileError('Skill changed while it was being copied', 'SKILL_SOURCE_CHANGED')
    }
    if (existing) renameSync(target, backup)
    try {
      renameSync(staged, target)
    } catch (error) {
      if (existing && existsSync(backup) && !existsSync(target)) renameSync(backup, target)
      throw error
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
    return { ...source, root: target }
  } finally {
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true })
    if (existsSync(backup) && !existsSync(target)) renameSync(backup, target)
  }
}

export function removeManagedSkillDirectory(targetDirectory, expectedSha256) {
  const target = resolve(targetDirectory)
  if (!existsSync(target)) return false
  const inspected = inspectSkillDirectory(target)
  if (!expectedSha256 || inspected.contentSha256 !== expectedSha256) {
    throw fileError('The managed skill was modified outside UCLI', 'SKILL_DRIFTED')
  }
  rmSync(target, { recursive: true })
  return true
}
