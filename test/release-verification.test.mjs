import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseArtifacts as verifyReleaseArtifactsForPlatform } from '../scripts/releaseVerification.mjs'
import { verifyDshReleaseResources } from '../scripts/verify-release.mjs'

function verifyReleaseArtifacts({ rootDir }) {
  return verifyReleaseArtifactsForPlatform({ rootDir, platform: 'win32', arch: 'x64' })
}

test('app release package and acceptance documentation agree', async () => {
  const [packageSource, readme, changelog, acceptance] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/release-acceptance.md', import.meta.url), 'utf8')
  ])
  assert.equal(JSON.parse(packageSource).version, '0.11.3')
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
  assert.match(changelog, /## \[0\.11\.1\] - 2026-08-18/)
  for (const anchor of [
    'settings-section-navigation',
    'settings-section-deep-link',
    'storage-inventory-no-provider-paths',
    'storage-protected-data',
    'storage-immediate-cleanup',
    'storage-restart-cleanup',
    'storage-partial-failure',
    'update-footer-available',
    'update-footer-download-progress',
    'update-footer-downloaded',
    'update-portable-unsupported'
  ]) assert.match(acceptance, new RegExp(`\\b${anchor}\\b`))
  for (const manualCheck of [
    /0\.10\.1.*设置.*报告.*会话.*档案.*Skills.*用量.*缓存/s,
    /鼠标.*键盘.*\?section=storage.*900/s,
    /外部 Provider.*项目路径.*受保护.*不可清理/s,
    /活动中的总结工作区.*保留.*非活动.*派生数据.*删除/s,
    /浏览器.*Skills.*更新器.*下次启动.*受保护/s,
    /不可读.*锁定.*partial.*partial-success.*零.*完全成功/s,
    /0\.10\.2.*较新测试版本.*侧栏.*不自动下载/s,
    /相同百分比.*侧栏.*设置.*导航.*重新加载/s,
    /重启并安装.*安装器/s,
    /便携版.*开发版.*更新器网络.*下载操作/s
  ]) assert.match(acceptance, manualCheck)
  for (const anchor of [
    'summary-workspace-recovery',
    'summary-cache-quota',
    'summary-cache-partial-hit',
    'summary-direct-one-call',
    'summary-map-concurrency',
    'summary-theme-executive',
    'summary-theme-engineering',
    'summary-theme-timeline',
    'summary-theme-dashboard',
    'summary-theme-print',
    'summary-ai-custom-export'
  ]) assert.match(acceptance, new RegExp(`\\b${anchor}\\b`))
  assert.match(readme, /精确趋势从升级到 0\.10\.0 后开始/)
  assert.match(readme, /升级前累计总量.*单独/)
  assert.match(readme, /自动总结.*默认关闭.*AI CLI/s)
  assert.match(readme, /仅补齐每种周期最新一个/)
  assert.match(readme, /可能产生 Provider 费用/)
  assert.match(readme, /Claude Code.*`\/insights`.*交互式原生报告/s)
  assert.match(readme, /不作为 0\.10\.0 跨 CLI 总结引擎/)
  assert.match(readme, /OpenCode.*compact.*复用/s)
  assert.match(readme, /不会修改原生会话来生成 compact/)
  assert.match(acceptance, /0\.10\.0 统计与工作总结/)
  assert.match(acceptance, /fake.*不调用真实 AI CLI/s)
  assert.match(acceptance, /需要用户本地验收/)
  assert.match(acceptance, /pre-0\.10 数据库.*legacy totals/s)
  assert.match(acceptance, /小时、天、周、月四种趋势/)
  assert.match(acceptance, /每日、每周、每月、每季度和每年报告/)
  assert.match(acceptance, /单次手动报告覆盖 executor、profile 或 model/)
  assert.match(acceptance, /取消一个多分块报告并重试/)
  assert.match(acceptance, /切换“当前版本”后重启应用/)
  assert.match(acceptance, /复制报告 Markdown.*导出 Markdown/s)
  assert.match(acceptance, /light、dark 和 custom 三种 AI HTML/)
  assert.match(acceptance, /prompt-injection 文本与假密钥/)
})

test('0.11.1 documents DSH Web-only remediation, managed runtime and native acceptance gates', async () => {
  const [protocol, acceptance, changelog] = await Promise.all([
    readFile(new URL('../docs/protocol-reference.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/release-acceptance.md', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  ])

  for (const source of [protocol, acceptance, changelog]) {
    assert.doesNotMatch(source, /\uFFFD/)
  }
  assert.match(changelog, /0\.11\.0.*错误的上游假设/s)
  assert.match(changelog, /0\.11\.1.*Web-only/s)
  assert.match(changelog, /保留.*DSH_HOME/s)
  assert.match(protocol, /没有 CLI TUI/)
  assert.match(protocol, /Runtime manager/)
  assert.match(protocol, /legacy bridge.*隔离/is)
  assert.match(protocol, /100.*\.dsh\/skills/s)
  assert.match(protocol, /200.*项目.*\.agents\/skills/s)
  assert.match(protocol, /400.*\$DSH_HOME\/skills/s)
  assert.match(protocol, /500.*用户.*\.agents\/skills/s)
  assert.match(protocol, /600.*内置/s)
  assert.match(protocol, /DSH_RUNTIME_INSTALL_FAILED/)
  assert.match(protocol, /DSH_TUI_UNAVAILABLE/)
  assert.match(protocol, /DSH_WEB_GATEWAY_UNSUPPORTED/)
  for (const anchor of [
    'dsh-managed-install',
    'dsh-install-interruption-rollback',
    'dsh-managed-repair',
    'dsh-web-lifecycle',
    'dsh-legacy-session-migration',
    'dsh-legacy-bridge-removal-rollback',
    'dsh-skills-four-roots',
    'dsh-shared-projection-dedupe',
    'dsh-runtime-uninstall-preserves-home',
    'dsh-windows-native-acceptance',
    'dsh-macos-native-acceptance'
  ]) assert.match(acceptance, new RegExp(`\\b${anchor}\\b`))
  const dshAcceptance = acceptance.slice(acceptance.indexOf('## 12.'))
  assert.doesNotMatch(dshAcceptance, /- \[ \].*(?:启动|恢复|运行).*(?:DSH )?TUI/mu)
  assert.doesNotMatch(dshAcceptance, /- \[ \].*PTY/mu)
  assert.doesNotMatch(dshAcceptance, /- \[ \].*(?:bridge.*权限|权限.*bridge|DSH.*Gateway|Gateway.*DSH)/imu)
  assert.match(dshAcceptance, /legacy TUI unavailable/iu)
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
  const resourceDir = path.join(rootDir, 'resources', 'deepseek-harness')
  const integrationDir = path.join(rootDir, 'integrations', 'deepseek-harness-bridge')
  await mkdir(distDir)
  await mkdir(resourceDir, { recursive: true })
  await mkdir(integrationDir, { recursive: true })
  await writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.2.0' }))
  await writeFile(
    path.join(rootDir, 'electron-builder.yml'),
    'productName: UCLI\nwin:\n  target:\n    - nsis\n    - portable\nnsis:\n  artifactName: ${productName}-Setup-${version}-${arch}.${ext}\nportable:\n  artifactName: ${productName}-Portable-${version}-${arch}.${ext}\n'
  )
  await writeFile(path.join(resourceDir, 'ucli-dsh-bridge-0.11.0.tgz'), 'legacy cleanup resource')
  await writeFile(path.join(integrationDir, 'package.json'), JSON.stringify({
    name: '@ucli/dsh-bridge',
    version: '0.11.0'
  }))
  await writeFile(path.join(rootDir, 'placeholder'), '')
  return { rootDir, distDir }
}

test('release verification retains only the quarantined 0.11.0 bridge resource', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))

  const result = await verifyDshReleaseResources({ rootDir: fixture.rootDir })

  assert.deepEqual(result, {
    resourceNames: ['resources/deepseek-harness/ucli-dsh-bridge-0.11.0.tgz']
  })
})

test('release verification rejects a missing quarantined bridge resource', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await rm(path.join(
    fixture.rootDir,
    'resources',
    'deepseek-harness',
    'ucli-dsh-bridge-0.11.0.tgz'
  ))

  await assert.rejects(
    () => verifyDshReleaseResources({ rootDir: fixture.rootDir }),
    /legacy DSH bridge resource is missing/
  )
})

test('release verification rejects a bridge manifest version other than 0.11.0', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(
    path.join(fixture.rootDir, 'integrations', 'deepseek-harness-bridge', 'package.json'),
    JSON.stringify({ name: '@ucli/dsh-bridge', version: '0.11.1' })
  )

  await assert.rejects(
    () => verifyDshReleaseResources({ rootDir: fixture.rootDir }),
    /legacy DSH bridge manifest must remain @ucli\/dsh-bridge@0\.11\.0/
  )
})

test('release verification rejects a DSH TUI package or source', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  const tuiPackage = path.join(fixture.rootDir, 'integrations', 'deepseek-harness-tui')
  await mkdir(tuiPackage, { recursive: true })
  await writeFile(path.join(tuiPackage, 'package.json'), JSON.stringify({
    name: '@ucli/deepseek-harness-tui',
    version: '0.11.1'
  }))

  await assert.rejects(
    () => verifyDshReleaseResources({ rootDir: fixture.rootDir }),
    /DSH TUI release content is forbidden/
  )
})

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

test('release verification rejects packaging resources through both files and extraResources', async (t) => {
  const fixture = await createReleaseFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  await writeFile(
    path.join(fixture.rootDir, 'electron-builder.yml'),
    'productName: UCLI\nfiles:\n  - out/**/*\n  - resources/**/*\nextraResources:\n  - from: resources/\n    to: resources/\nwin:\n  target:\n    - nsis\n    - portable\nnsis:\n  artifactName: ${productName}-Setup-${version}-${arch}.${ext}\nportable:\n  artifactName: ${productName}-Portable-${version}-${arch}.${ext}\n'
  )

  await assert.rejects(
    () => verifyReleaseArtifacts({ rootDir: fixture.rootDir }),
    /electron-builder\.yml duplicates resources through files and extraResources/
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
