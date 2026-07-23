import path from 'node:path'
import { verifyReleaseArtifacts } from './releaseVerification.mjs'

try {
  const result = await verifyReleaseArtifacts({ rootDir: path.resolve(process.cwd()) })
  console.log(`Release artifacts verified for v${result.version}.`)
  console.log(`Installer: ${result.installerName}`)
  console.log(`Portable: ${result.portableName}`)
} catch (error) {
  console.error(`Release verification failed: ${error.message}`)
  process.exitCode = 1
}
