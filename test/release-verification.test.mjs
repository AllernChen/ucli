import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseArtifacts as verifyReleaseArtifactsForPlatform } from '../scripts/releaseVerification.mjs'

function verifyReleaseArtifacts({ rootDir }) {
  return verifyReleaseArtifactsForPlatform({ rootDir, platform: 'win32', arch: 'x64' })
}

test('0.9.4 release package and user documentation agree', async () => {
  const [packageSource, readme, changelog] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  ])
  assert.equal(JSON.parse(packageSource).version, '0.9.4')
  assert.match(readme, /配置档案/)
  assert.match(readme, /CC Switch/)
  assert.match(readme, /Claude 登录态/)
  assert.match(readme, /Bearer Token/)
  assert.match(readme, /不读取.*OAuth/s)
  assert.match(readme, /Bedrock.*Vertex.*Foundry/s)
  assert.doesNotMatch(readme, /\uFFFD/)
  assert.doesNotMatch(changelog, /\uFFFD/)
  assert.match(readme, /Skills 管理/)
  assert.match(readme, /GitLab/)
  assert.match(changelog, /## \[0\.9\.4\]/)
})

test('Gateway release acceptance documents every required Feishu prerequisite', async () => {
  const acceptance = await import('node:fs/promises')
    .then(({ readFile }) => readFile(
      new URL('../docs/release-acceptance.md', import.meta.url),
      'utf8'
    ))

  for (const requirement of [
    '机器人能力',
    'WebSocket',
    '消息接收事件',
    '卡片回传事件',
    '发送消息',
    '更新卡片',
    '回复消息',
    '消息表情回复',
    '群组完整消息权限',
    '绑定 UCLI',
    '本地确认',
    '自动成为首位操作人'
  ]) {
    assert.match(acceptance, new RegExp(requirement))
  }
})

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
    platform: 'win32',
    artifactNames: [
      installerName,
      'UCLI-Portable-0.2.0-x64.exe'
    ]
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
  const result = spawnSync(
    process.execPath,
    [cliPath, '--platform', 'win32', '--arch', 'x64'],
    { cwd: fixture.rootDir, encoding: 'utf8' }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Release artifacts verified for v0\.2\.0 \(win32\)/)
})

test('release verification accepts macOS DMG and ZIP artifacts', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(
    path.join(fixture.rootDir, 'electron-builder.yml'),
    'productName: UCLI\nmac:\n  target:\n    - dmg\n    - zip\n  artifactName: ${productName}-${version}-${arch}.${ext}\n'
  )
  const installerName = 'UCLI-0.2.0-arm64.dmg'
  const archiveName = 'UCLI-0.2.0-arm64.zip'
  const archiveContent = 'archive bytes'
  const archiveChecksum = createHash('sha512').update(archiveContent).digest('base64')
  await writeFile(path.join(fixture.distDir, installerName), '')
  await writeFile(path.join(fixture.distDir, archiveName), archiveContent)
  await writeFile(path.join(fixture.distDir, `${archiveName}.blockmap`), '')
  await writeFile(
    path.join(fixture.distDir, 'latest-mac.yml'),
    `version: 0.2.0\npath: ${archiveName}\nsha512: ${archiveChecksum}\n`
  )

  const result = await verifyReleaseArtifactsForPlatform({
    rootDir: fixture.rootDir,
    platform: 'darwin',
    arch: 'arm64'
  })

  assert.deepEqual(result, {
    version: '0.2.0',
    platform: 'darwin',
    artifactNames: [archiveName, installerName]
  })
})
