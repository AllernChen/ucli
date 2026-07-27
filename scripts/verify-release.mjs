import path from 'node:path'
import { verifyReleaseArtifacts } from './releaseVerification.mjs'

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

try {
  const result = await verifyReleaseArtifacts({
    rootDir: path.resolve(process.cwd()),
    platform: argument('platform', process.platform),
    arch: argument('arch', process.arch)
  })
  console.log(`Release artifacts verified for v${result.version} (${result.platform}).`)
  for (const artifactName of result.artifactNames) console.log(`Artifact: ${artifactName}`)
} catch (error) {
  console.error(`Release verification failed: ${error.message}`)
  process.exitCode = 1
}
