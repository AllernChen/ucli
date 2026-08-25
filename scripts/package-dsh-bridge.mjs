import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'integrations', 'deepseek-harness-bridge')
const outputRoot = process.env.UCLI_DSH_BRIDGE_OUTPUT_ROOT
  ? path.resolve(process.env.UCLI_DSH_BRIDGE_OUTPUT_ROOT)
  : path.join(root, 'resources', 'deepseek-harness')
const output = path.join(outputRoot, 'ucli-dsh-bridge-0.11.0.tgz')
const entries = [
  ['package/package.json', 'package.json'],
  ['package/cordis.patch.yml', 'cordis.patch.yml'],
  ['package/framing.js', 'framing.js'],
  ['package/index.js', 'index.js']
]

function writeText(target, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`tar field exceeds ${length} bytes`)
  bytes.copy(target, offset)
}

function writeOctal(target, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, '0') + '\0'
  writeText(target, offset, length, octal)
}

function tarEntry(name, body) {
  const header = Buffer.alloc(512)
  writeText(header, 0, 100, name)
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, body.length)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeText(header, 257, 6, 'ustar\0')
  writeText(header, 263, 2, '00')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeText(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function assertNoRuntimeSecret(files) {
  const values = Object.entries(process.env)
    .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/iu.test(key) && value?.length >= 8)
    .map(([, value]) => value)
  for (const [name, body] of files) {
    const text = body.toString('utf8')
    for (const value of values) {
      if (text.includes(value)) throw new Error(`runtime secret found in ${name}`)
    }
  }
}

async function buildArchive() {
  const files = []
  for (const [archiveName, sourceName] of entries) {
    const source = path.join(sourceRoot, sourceName)
    const stat = await lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe bridge source: ${sourceName}`)
    files.push([archiveName, await readFile(source)])
  }
  assertNoRuntimeSecret(files)
  const tar = Buffer.concat([
    ...files.map(([name, body]) => tarEntry(name, body)),
    Buffer.alloc(1024)
  ])
  return gzipSync(tar, { level: 9, mtime: 0 })
}

const artifactFs = { writeFile, rename, rm }

export async function replaceBridgeArtifact(target, bytes, {
  fs = artifactFs,
  suffix = `${process.pid}-${randomUUID()}`
} = {}) {
  const temporary = `${target}.${suffix}.tmp`
  const backup = `${target}.${suffix}.backup`
  let hadPrevious = false
  let preserveBackup = false
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600 })
    try {
      await fs.rename(target, backup)
      hadPrevious = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await fs.rename(temporary, target)
    } catch (error) {
      if (hadPrevious) {
        try {
          await fs.rename(backup, target)
          hadPrevious = false
        } catch (restoreError) {
          preserveBackup = true
          throw new AggregateError([error, restoreError], 'bridge artifact replacement and restore failed')
        }
      }
      throw error
    }
  } finally {
    await fs.rm(temporary, { force: true })
    if (!preserveBackup) await fs.rm(backup, { force: true })
  }
}

export async function packageDshBridge() {
  const resolvedOutputRoot = path.resolve(outputRoot)
  if (path.dirname(path.resolve(output)) !== resolvedOutputRoot) {
    throw new Error('unsafe DSH bridge artifact path')
  }
  await mkdir(resolvedOutputRoot, { recursive: true })
  await replaceBridgeArtifact(output, await buildArchive())
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) await packageDshBridge()
