import path from 'node:path'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { verifyReleaseArtifacts } from './releaseVerification.mjs'

const LEGACY_BRIDGE_RESOURCE = path.join(
  'resources',
  'deepseek-harness',
  'ucli-dsh-bridge-0.11.0.tgz'
)
const LEGACY_BRIDGE_MANIFEST = path.join(
  'integrations',
  'deepseek-harness-bridge',
  'package.json'
)

async function requireRegularFile(filePath, label) {
  let details
  try {
    details = await lstat(filePath)
  } catch {
    throw new Error(`${label} is missing`)
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`)
  }
}

function isDshTuiReleasePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/').toLowerCase()
  return /(?:^|[/_.-])(?:tui|turtle)(?:[/_.-]|$)/u.test(normalized)
}

async function rejectDshTuiContent(rootDir) {
  const searchRoots = [
    path.join(rootDir, 'resources', 'deepseek-harness'),
    path.join(rootDir, 'integrations')
  ]
  for (const searchRoot of searchRoots) {
    const pending = [searchRoot]
    while (pending.length > 0) {
      const directory = pending.pop()
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw new Error('DSH release content could not be inspected')
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name)
        const relativePath = path.relative(rootDir, entryPath)
        if (isDshTuiReleasePath(relativePath)) {
          throw new Error('DSH TUI release content is forbidden')
        }
        if (entry.isDirectory()) pending.push(entryPath)
      }
    }
  }
}

export async function verifyDshReleaseResources({ rootDir }) {
  const resolvedRoot = path.resolve(rootDir)
  const resourcePath = path.join(resolvedRoot, LEGACY_BRIDGE_RESOURCE)
  const manifestPath = path.join(resolvedRoot, LEGACY_BRIDGE_MANIFEST)
  await requireRegularFile(resourcePath, 'legacy DSH bridge resource')
  await requireRegularFile(manifestPath, 'legacy DSH bridge manifest')

  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error('legacy DSH bridge manifest is invalid')
  }
  if (manifest.name !== '@ucli/dsh-bridge' || manifest.version !== '0.11.0') {
    throw new Error('legacy DSH bridge manifest must remain @ucli/dsh-bridge@0.11.0')
  }
  await rejectDshTuiContent(resolvedRoot)

  return {
    resourceNames: [LEGACY_BRIDGE_RESOURCE.split(path.sep).join('/')]
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

async function run() {
  try {
    const rootDir = path.resolve(process.cwd())
    const result = await verifyReleaseArtifacts({
      rootDir,
      platform: argument('platform', process.platform),
      arch: argument('arch', process.arch)
    })
    const resources = await verifyDshReleaseResources({ rootDir })
    console.log(`Release artifacts verified for v${result.version} (${result.platform}).`)
    for (const artifactName of result.artifactNames) console.log(`Artifact: ${artifactName}`)
    for (const resourceName of resources.resourceNames) console.log(`Resource: ${resourceName}`)
  } catch (error) {
    console.error(`Release verification failed: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await run()
}
