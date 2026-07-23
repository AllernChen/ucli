import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseArtifacts } from '../scripts/releaseVerification.mjs'

async function createReleaseFixture() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'ucli-release-'))
  const distDir = path.join(rootDir, 'dist')
  await mkdir(distDir)
  await writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.2.0' }))
  await writeFile(
    path.join(rootDir, 'electron-builder.yml'),
    'productName: UCLI\nwin:\n  target:\n    - nsis\n    - portable\nnsis:\n  artifactName: ${productName}-Setup-${version}-${arch}.${ext}\nportable:\n  artifactName: ${productName}-Portable-${version}-${arch}.${ext}\n'
  )
  await writeFile(path.join(rootDir, 'placeholder'), '')
  return { rootDir, distDir }
}

test('release verification rejects a missing portable artifact', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /UCLI-Portable-0\.2\.0-x64\.exe is missing/
  )
})

test('release verification rejects a missing installer artifact', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /UCLI-Setup-0\.2\.0-x64\.exe is missing/
  )
})

test('release verification rejects missing update metadata', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe'), '')

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /latest\.yml is missing/
  )
})

test('release verification rejects a missing installer blockmap', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), 'version: 0.2.0\n')

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /UCLI-Setup-0\.2\.0-x64\.exe\.blockmap is missing/
  )
})

test('release verification rejects update metadata for a different version', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe.blockmap'), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), 'version: 0.1.9\n')

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /latest\.yml version 0\.1\.9 does not match package version 0\.2\.0/
  )
})

test('release verification rejects update metadata pointing at another installer', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe.blockmap'), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), 'version: 0.2.0\npath: UCLI-Setup-0.1.9-x64.exe\n')

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /latest\.yml path UCLI-Setup-0\.1\.9-x64\.exe does not match UCLI-Setup-0\.2\.0-x64\.exe/
  )
})

test('release verification rejects update metadata with a different installer checksum', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe'), 'installer bytes')
  await writeFile(path.join(fixture.distDir, 'UCLI-Setup-0.2.0-x64.exe.blockmap'), '')
  await writeFile(
    path.join(fixture.distDir, 'latest.yml'),
    'version: 0.2.0\npath: UCLI-Setup-0.2.0-x64.exe\nsha512: not-the-installer-checksum\n'
  )

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /latest\.yml sha512 does not match UCLI-Setup-0\.2\.0-x64\.exe/
  )
})

test('release verification returns the verified artifact names', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  const installerName = 'UCLI-Setup-0.2.0-x64.exe'
  const installerContent = 'installer bytes'
  const installerChecksum = createHash('sha512').update(installerContent).digest('base64')
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, installerName), installerContent)
  await writeFile(path.join(fixture.distDir, `${installerName}.blockmap`), '')
  await writeFile(
    path.join(fixture.distDir, 'latest.yml'),
    `version: 0.2.0\npath: ${installerName}\nsha512: ${installerChecksum}\n`
  )

  const result = await verifyReleaseArtifacts({ rootDir: fixture.rootDir })

  assert.deepEqual(result, {
    version: '0.2.0',
    installerName,
    portableName: 'UCLI-Portable-0.2.0-x64.exe'
  })
})

test('release verification rejects a build configuration without the portable target', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  const installerName = 'UCLI-Setup-0.2.0-x64.exe'
  const installerContent = 'installer bytes'
  const installerChecksum = createHash('sha512').update(installerContent).digest('base64')
  await writeFile(path.join(fixture.rootDir, 'electron-builder.yml'), 'productName: UCLI\nwin:\n  target:\n    - nsis\n')
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, installerName), installerContent)
  await writeFile(path.join(fixture.distDir, `${installerName}.blockmap`), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), `version: 0.2.0\npath: ${installerName}\nsha512: ${installerChecksum}\n`)

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /electron-builder\.yml does not configure the portable target/
  )
})

test('release verification rejects a build configuration without the NSIS target', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  const installerName = 'UCLI-Setup-0.2.0-x64.exe'
  const installerContent = 'installer bytes'
  const installerChecksum = createHash('sha512').update(installerContent).digest('base64')
  await writeFile(path.join(fixture.rootDir, 'electron-builder.yml'), 'productName: UCLI\nwin:\n  target:\n    - portable\n')
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, installerName), installerContent)
  await writeFile(path.join(fixture.distDir, `${installerName}.blockmap`), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), `version: 0.2.0\npath: ${installerName}\nsha512: ${installerChecksum}\n`)

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /electron-builder\.yml does not configure the nsis target/
  )
})

test('release verification rejects an unexpected NSIS artifact name template', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  const installerName = 'UCLI-Setup-0.2.0-x64.exe'
  const installerContent = 'installer bytes'
  const installerChecksum = createHash('sha512').update(installerContent).digest('base64')
  await writeFile(
    path.join(fixture.rootDir, 'electron-builder.yml'),
    'productName: UCLI\nwin:\n  target:\n    - nsis\n    - portable\nnsis:\n  artifactName: UCLI-${version}.exe\nportable:\n  artifactName: ${productName}-Portable-${version}-${arch}.${ext}\n'
  )
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, installerName), installerContent)
  await writeFile(path.join(fixture.distDir, `${installerName}.blockmap`), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), `version: 0.2.0\npath: ${installerName}\nsha512: ${installerChecksum}\n`)

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /electron-builder\.yml NSIS artifactName must be \$\{productName\}-Setup-\$\{version\}-\$\{arch\}\.\$\{ext\}/
  )
})

test('release verification rejects an unexpected portable artifact name template', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  const installerName = 'UCLI-Setup-0.2.0-x64.exe'
  const installerContent = 'installer bytes'
  const installerChecksum = createHash('sha512').update(installerContent).digest('base64')
  await writeFile(
    path.join(fixture.rootDir, 'electron-builder.yml'),
    'productName: UCLI\nwin:\n  target:\n    - nsis\n    - portable\nnsis:\n  artifactName: ${productName}-Setup-${version}-${arch}.${ext}\nportable:\n  artifactName: UCLI-${version}.exe\n'
  )
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, installerName), installerContent)
  await writeFile(path.join(fixture.distDir, `${installerName}.blockmap`), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), `version: 0.2.0\npath: ${installerName}\nsha512: ${installerChecksum}\n`)

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /electron-builder\.yml portable artifactName must be \$\{productName\}-Portable-\$\{version\}-\$\{arch\}\.\$\{ext\}/
  )
})

test('release verification CLI reports the verified release version', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  const installerName = 'UCLI-Setup-0.2.0-x64.exe'
  const installerContent = 'installer bytes'
  const installerChecksum = createHash('sha512').update(installerContent).digest('base64')
  await writeFile(path.join(fixture.distDir, 'UCLI-Portable-0.2.0-x64.exe'), '')
  await writeFile(path.join(fixture.distDir, installerName), installerContent)
  await writeFile(path.join(fixture.distDir, `${installerName}.blockmap`), '')
  await writeFile(path.join(fixture.distDir, 'latest.yml'), `version: 0.2.0\npath: ${installerName}\nsha512: ${installerChecksum}\n`)

  const cliPath = fileURLToPath(new URL('../scripts/verify-release.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cliPath], { cwd: fixture.rootDir, encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Release artifacts verified for v0\.2\.0/)
})
