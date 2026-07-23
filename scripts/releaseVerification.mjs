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

export async function verifyReleaseArtifacts({ rootDir }) {
  const version = await readPackageVersion(rootDir)
  const builderContent = await readFile(path.join(rootDir, 'electron-builder.yml'), 'utf8')
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
  const installerName = `UCLI-Setup-${version}-x64.exe`
  const portableName = `UCLI-Portable-${version}-x64.exe`
  const artifactNames = [
    portableName,
    installerName,
    'latest.yml',
    `UCLI-Setup-${version}-x64.exe.blockmap`
  ]

  for (const artifactName of artifactNames) {
    try {
      await access(path.join(rootDir, 'dist', artifactName))
    } catch {
      throw new Error(`Release artifact ${artifactName} is missing.`)
    }
  }

  const distDir = path.join(rootDir, 'dist')
  const latestPath = path.join(distDir, 'latest.yml')
  const latestContent = await readFile(latestPath, 'utf8')
  const latestVersion = readYamlScalar(latestContent, 'version')
  if (latestVersion !== version) {
    throw new Error(`latest.yml version ${latestVersion ?? 'missing'} does not match package version ${version}.`)
  }

  const latestPathValue = readYamlScalar(latestContent, 'path')
  if (latestPathValue !== installerName) {
    throw new Error(`latest.yml path ${latestPathValue ?? 'missing'} does not match ${installerName}.`)
  }

  const latestChecksum = readYamlScalar(latestContent, 'sha512')
  const installerContent = await readFile(path.join(distDir, installerName))
  const installerChecksum = createHash('sha512').update(installerContent).digest('base64')
  if (latestChecksum !== installerChecksum) {
    throw new Error(`latest.yml sha512 does not match ${installerName}.`)
  }

  return {
    version,
    installerName,
    portableName
  }
}
