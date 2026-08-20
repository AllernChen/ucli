import { access, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

async function readPackageVersion(rootDir) {
  const packagePath = path.join(rootDir, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  return packageJson.version
}

function readYamlScalar(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*['\"]?([^'\"\\r\\n]+)['\"]?\\s*$`, 'm'))
  return match?.[1].trim()
}

function hasBuilderTarget(content, target) {
  return new RegExp(`^\\s*-\\s+${target}\\s*$`, 'm').test(content)
}

function readBuilderSectionValue(content, section, key) {
  let activeSection = false
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^([A-Za-z][\w-]*):\s*$/)
    if (header) {
      activeSection = header[1] === section
      continue
    }
    if (activeSection) {
      const value = line.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`))
      if (value) return value[1]
    }
  }
  return undefined
}

function readBuilderSection(content, section) {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `${section}:`)
  if (start < 0) return ''
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z][\w-]*:\s*$/.test(lines[index])) break
    body.push(lines[index])
  }
  return body.join('\n')
}

function validateBundledResources(builderContent) {
  const files = readBuilderSection(builderContent, 'files')
  const extraResources = readBuilderSection(builderContent, 'extraResources')
  const resourcesInFiles = /^\s*-\s+resources\/\*\*\/\*\s*$/m.test(files)
  const resourcesInExtra = /^\s*-\s+from:\s+resources\/?\s*$/m.test(extraResources)
  if (resourcesInFiles && resourcesInExtra) {
    throw new Error('electron-builder.yml duplicates resources through files and extraResources.')
  }
}

function validateWindowsBuilderConfig(builderContent) {
  if (!hasBuilderTarget(builderContent, 'portable')) {
    throw new Error('electron-builder.yml does not configure the portable target.')
  }
  if (!hasBuilderTarget(builderContent, 'nsis')) {
    throw new Error('electron-builder.yml does not configure the nsis target.')
  }
  const nsisTemplate = '${productName}-Setup-${version}-${arch}.${ext}'
  if (readBuilderSectionValue(builderContent, 'nsis', 'artifactName') !== nsisTemplate) {
    throw new Error(`electron-builder.yml NSIS artifactName must be ${nsisTemplate}.`)
  }
  const portableTemplate = '${productName}-Portable-${version}-${arch}.${ext}'
  if (readBuilderSectionValue(builderContent, 'portable', 'artifactName') !== portableTemplate) {
    throw new Error(`electron-builder.yml portable artifactName must be ${portableTemplate}.`)
  }
}

function validateMacBuilderConfig(builderContent) {
  if (!hasBuilderTarget(builderContent, 'dmg')) {
    throw new Error('electron-builder.yml does not configure the macOS DMG target.')
  }
  if (!hasBuilderTarget(builderContent, 'zip')) {
    throw new Error('electron-builder.yml does not configure the macOS ZIP target.')
  }
  const artifactTemplate = '${productName}-${version}-${arch}.${ext}'
  if (readBuilderSectionValue(builderContent, 'mac', 'artifactName') !== artifactTemplate) {
    throw new Error(`electron-builder.yml macOS artifactName must be ${artifactTemplate}.`)
  }
}

function releaseArtifacts(platform, version, arch) {
  if (platform === 'win32') {
    const installerName = `UCLI-Setup-${version}-${arch}.exe`
    const portableName = `UCLI-Portable-${version}-${arch}.exe`
    return {
      primaryName: installerName,
      secondaryName: portableName,
      metadataName: 'latest.yml',
      requiredNames: [
        portableName,
        installerName,
        'latest.yml',
        `${installerName}.blockmap`
      ]
    }
  }
  if (platform === 'darwin') {
    const installerName = `UCLI-${version}-${arch}.dmg`
    const archiveName = `UCLI-${version}-${arch}.zip`
    return {
      primaryName: archiveName,
      secondaryName: installerName,
      metadataName: 'latest-mac.yml',
      requiredNames: [
        installerName,
        archiveName,
        'latest-mac.yml',
        `${archiveName}.blockmap`
      ]
    }
  }
  throw new Error(`Release verification does not support platform ${platform}.`)
}

export async function verifyReleaseArtifacts({
  rootDir,
  platform = process.platform,
  arch = process.arch
}) {
  const version = await readPackageVersion(rootDir)
  const builderContent = await readFile(path.join(rootDir, 'electron-builder.yml'), 'utf8')
  validateBundledResources(builderContent)
  if (platform === 'win32') validateWindowsBuilderConfig(builderContent)
  else if (platform === 'darwin') validateMacBuilderConfig(builderContent)

  const artifacts = releaseArtifacts(platform, version, arch)

  for (const artifactName of artifacts.requiredNames) {
    try {
      await access(path.join(rootDir, 'dist', artifactName))
    } catch {
      throw new Error(`Release artifact ${artifactName} is missing.`)
    }
  }

  const distDir = path.join(rootDir, 'dist')
  const latestPath = path.join(distDir, artifacts.metadataName)
  const latestContent = await readFile(latestPath, 'utf8')
  const latestVersion = readYamlScalar(latestContent, 'version')
  if (latestVersion !== version) {
    throw new Error(`${artifacts.metadataName} version ${latestVersion ?? 'missing'} does not match package version ${version}.`)
  }

  const latestPathValue = readYamlScalar(latestContent, 'path')
  if (latestPathValue !== artifacts.primaryName) {
    throw new Error(`${artifacts.metadataName} path ${latestPathValue ?? 'missing'} does not match ${artifacts.primaryName}.`)
  }

  const latestChecksum = readYamlScalar(latestContent, 'sha512')
  const primaryContent = await readFile(path.join(distDir, artifacts.primaryName))
  const installerChecksum = createHash('sha512').update(primaryContent).digest('base64')
  if (latestChecksum !== installerChecksum) {
    throw new Error(`${artifacts.metadataName} sha512 does not match ${artifacts.primaryName}.`)
  }

  return {
    version,
    platform,
    artifactNames: [artifacts.primaryName, artifacts.secondaryName]
  }
}
