import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function skillNames() {
  const index = process.argv.indexOf('--skills')
  if (index < 0) return []
  const names = []
  for (const value of process.argv.slice(index + 1)) {
    if (value.startsWith('--')) break
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) names.push(value)
  }
  return [...new Set(names)]
}

function canonicalRepositoryUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Repository URL is invalid') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) {
    throw new Error('Only credential-free GitHub HTTPS URLs are supported')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2) throw new Error('Repository URL must identify owner/repository')
  const owner = parts[0]
  const repository = parts[1].replace(/\.git$/i, '')
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository)) throw new Error('Repository URL is invalid')
  return `https://github.com/${owner}/${repository}`
}

const userDataPath = resolve(argument('--user-data'))
const repositoryUrl = canonicalRepositoryUrl(argument('--repo'))
const skills = skillNames()
if (!argument('--user-data') || !skills.length) {
  throw new Error('Usage: node scripts/associate-skill-sources.mjs --user-data <path> --repo <url> --skills <name...>')
}

const registryPath = join(userDataPath, 'skills', 'source-projects.json')
let registry = { version: 1, associations: {} }
if (existsSync(registryPath)) {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Existing registry is invalid')
  if (!registry.associations || typeof registry.associations !== 'object' || Array.isArray(registry.associations)) {
    registry.associations = {}
  }
}

for (const skillName of skills) {
  registry.associations[skillName] = { sourceType: 'github', sourceUrl: repositoryUrl }
}
registry.version = 1

mkdirSync(dirname(registryPath), { recursive: true })
if (existsSync(registryPath)) copyFileSync(registryPath, `${registryPath}.bak`)
const temporaryPath = `${registryPath}.${process.pid}.tmp`
writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
renameSync(temporaryPath, registryPath)
console.log(`Associated ${skills.length} Skills with ${repositoryUrl} in ${registryPath}`)
