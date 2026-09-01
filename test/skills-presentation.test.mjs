import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import * as skillsPresentation from '../src/skillsPresentation.js'

import {
  aggregateSkillCatalog,
  buildPluginCopyInstallRequest,
  buildSkillCollectionInstallRequests,
  buildSourceProjectCliSummary,
  buildSkillCliMatrix,
  canConfirmSkillInstall,
  createLatestRequestGuard,
  dshSkillSourcePresentation,
  filterSkillCatalog,
  groupSkillCatalogBySourceProject,
  normaliseGitLabRepository,
  normaliseGitHubRepository,
  resolveSkillInstallPreflight,
  resolveSkillCollectionInstallSelection,
  skillOriginLabel,
  skillInstallAffectedInstallationIds,
  skillPackageApplyTargets,
  skillSourceKindLabel,
  skillStatusPresentation,
  skillVisibilitySummary
} from '../src/skillsPresentation.js'

const adapters = [
  { id: 'claude', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex' },
  { id: 'opencode', displayName: 'OpenCode' },
  { id: 'ucode', displayName: 'U-Code' }
]

test('install preflight offers missing CLIs when identical content is already installed in scope', () => {
  const preflight = resolveSkillInstallPreflight({
    installedMatches: [{
      packageId: 'package-1',
      matchType: 'same_source_and_content',
      installations: [{ scopeType: 'project', scopeKey: 'F:\\demo' }],
      visibility: {
        codex: { visible: true },
        claude: { visible: false }
      }
    }]
  }, {
    scopeType: 'project',
    projectPath: 'f:/DEMO/',
    targetAdapterIds: ['codex', 'claude']
  })

  assert.equal(preflight.kind, 'already_installed')
  assert.equal(preflight.match.packageId, 'package-1')
  assert.deepEqual(preflight.missingAdapterIds, ['claude'])
})

test('install preflight blocks a second package when the same source has changed', () => {
  const preflight = resolveSkillInstallPreflight({
    installedMatches: [{
      packageId: 'package-1',
      matchType: 'same_source_changed',
      installations: [{ scopeType: 'user', scopeKey: '*' }],
      visibility: {}
    }]
  }, {
    scopeType: 'user',
    targetAdapterIds: ['claude']
  })

  assert.equal(preflight.kind, 'source_changed')
  assert.equal(preflight.match.packageId, 'package-1')
  assert.deepEqual(preflight.missingAdapterIds, [])
})

test('install preflight does not reuse an identical package from another project scope', () => {
  const preflight = resolveSkillInstallPreflight({
    installedMatches: [{
      packageId: 'package-1',
      matchType: 'same_content',
      installations: [{ scopeType: 'project', scopeKey: 'F:\\project-a' }],
      visibility: { codex: { visible: true } }
    }]
  }, {
    scopeType: 'project',
    projectPath: 'F:\\project-b',
    targetAdapterIds: ['codex']
  })

  assert.equal(preflight.kind, 'new_install')
  assert.equal(preflight.match, null)
})

test('install preflight offers safe adoption for identical unmanaged target content', () => {
  const preflight = resolveSkillInstallPreflight({
    installedMatches: [],
    targetMatches: [{
      adapterId: 'codex',
      targetPath: 'F:\\project\\.agents\\skills\\demo',
      matchType: 'same_content'
    }]
  }, {
    scopeType: 'project',
    projectPath: 'F:\\project',
    targetAdapterIds: ['codex']
  })

  assert.equal(preflight.kind, 'existing_target')
  assert.deepEqual(preflight.targetMatches.map((item) => item.adapterId), ['codex'])
})

test('install preflight blocks conflicting unmanaged target content', () => {
  const preflight = resolveSkillInstallPreflight({
    installedMatches: [],
    targetMatches: [{
      adapterId: 'codex',
      targetPath: 'F:\\project\\.agents\\skills\\demo',
      matchType: 'conflict'
    }]
  }, {
    scopeType: 'project',
    projectPath: 'F:\\project',
    targetAdapterIds: ['codex']
  })

  assert.equal(preflight.kind, 'target_conflict')
  assert.equal(preflight.match, null)
})

test('source-project summary counts Skills usable by each AI CLI', () => {
  const summary = buildSourceProjectCliSummary({
    entries: [
      {
        status: 'ready', packages: [],
        installations: [{ targetAdapterId: 'codex', enabled: true, status: 'ready' }],
        sources: [{ adapterId: 'claude', origin: 'external', health: 'ready' }],
        visibility: {
          claude: { visible: true, direct: true, inheritedFrom: [] },
          codex: { visible: true, direct: true, inheritedFrom: [] }
        }
      },
      {
        status: 'ready', packages: [],
        installations: [{ targetAdapterId: 'codex', enabled: true, status: 'ready' }],
        sources: [],
        visibility: {
          codex: { visible: true, direct: true, inheritedFrom: [] },
          opencode: { visible: true, direct: false, inheritedFrom: ['codex'] }
        }
      }
    ]
  }, adapters)

  assert.deepEqual(summary.map((item) => [item.adapterId, item.used, item.total, item.state]), [
    ['claude', 1, 2, 'partial'],
    ['codex', 2, 2, 'all'],
    ['opencode', 1, 2, 'partial'],
    ['ucode', 0, 2, 'none']
  ])
})

test('CLI matrix distinguishes managed, external, inherited and unapplied Skill usage', () => {
  const matrix = buildSkillCliMatrix({
    status: 'ready',
    packages: [{ id: 'pkg-1', compatibility: { opencode: { compatible: true } } }],
    installations: [{ id: 'install-1', targetAdapterId: 'codex', enabled: true, status: 'ready' }],
    sources: [{ key: 'external-1', adapterId: 'claude', origin: 'external' }],
    visibility: {
      claude: { visible: true, direct: true, inheritedFrom: [] },
      codex: { visible: true, direct: true, inheritedFrom: [] },
      opencode: { visible: true, direct: false, inheritedFrom: ['codex'] },
      ucode: { visible: false, direct: false, inheritedFrom: [] }
    }
  }, adapters)

  assert.deepEqual(matrix.map((cell) => [cell.adapterId, cell.state, cell.action]), [
    ['claude', 'external', 'apply'],
    ['codex', 'managed', null],
    ['opencode', 'inherited', 'apply'],
    ['ucode', 'unavailable', 'apply']
  ])
  assert.equal(matrix[0].actionLabel, '纳入管理')
  assert.equal(matrix[2].actionLabel, '直接应用')
})

test('DeepSeek Harness is a native skill target and inherited project visibility can be applied', () => {
  const dshAdapter = { id: 'deepseek-harness', displayName: 'DeepSeek Harness' }
  const matrix = buildSkillCliMatrix({
    status: 'ready',
    packages: [{ id: 'pkg-1', compatibility: {} }],
    installations: [],
    sources: [{
      key: 'codex:project:diagnose', adapterId: 'codex', scopeType: 'project',
      sourceKind: 'codex_project', origin: 'external', health: 'ready'
    }],
    visibility: {
      codex: { visible: true, direct: true, inheritedFrom: [] },
      'deepseek-harness': { visible: true, direct: false, inheritedFrom: ['codex'] }
    }
  }, [dshAdapter])

  assert.equal(matrix[0].adapterId, 'deepseek-harness')
  assert.equal(matrix[0].state, 'inherited')
  assert.equal(matrix[0].visible, true)
  assert.equal(matrix[0].action, 'apply')
  assert.equal(matrix[0].actionLabel, '直接应用')
  assert.deepEqual(skillPackageApplyTargets({ compatibility: {} }, [dshAdapter]), [dshAdapter])
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /skills\.adapters[\s\S]*\.filter\(item => !item\.virtual\)/)
})

test('DSH physical sources use bounded consumer badges and effective conflict labels', () => {
  const fixtures = [
    ['project-dsh', 'DSH 项目专属'],
    ['project-agents', 'Codex / DSH 项目共享'],
    ['user-dsh', 'DSH 用户专属'],
    ['user-agents', 'Codex / DSH 用户共享'],
    ['custom', '自定义 / 内置（只读）'],
    ['bundled', '自定义 / 内置（只读）']
  ]
  for (const [dshSource, badge] of fixtures) {
    const view = dshSkillSourcePresentation({
      dshSource,
      effective: true,
      path: 'C:\\Users\\private\\skills',
      resolvedPath: 'C:\\secret\\skills'
    })
    assert.deepEqual(view, {
      badge,
      status: '生效',
      readOnly: ['custom', 'bundled'].includes(dshSource)
    })
    assert.doesNotMatch(JSON.stringify(view), /Users|private|secret|path/u)
  }

  assert.deepEqual(dshSkillSourcePresentation({
    dshSource: 'user-dsh', effective: false, shadowedBy: 'project-agents'
  }), {
    badge: 'DSH 用户专属',
    status: '被 Codex / DSH 项目共享 遮蔽',
    readOnly: false
  })
})

test('managed DSH locations retain effective-source metadata for bounded UI rows', () => {
  const [entry] = aggregateSkillCatalog({
    packages: [{
      id: 'pkg-dsh', name: 'diagnose', installations: [{
        id: 'install-dsh', targetAdapterId: 'deepseek-harness', status: 'ready', enabled: true
      }]
    }],
    discovered: [{
      name: 'diagnose', sources: [{
        key: 'dsh:managed', installationId: 'install-dsh', adapterId: 'deepseek-harness',
        dshSource: 'project-dsh', effective: false, shadowedBy: 'project-agents',
        entryPath: 'C:\\private\\entry', resolvedPath: 'C:\\private\\physical'
      }]
    }]
  })

  assert.equal(entry.installations[0].dshSource, 'project-dsh')
  assert.equal(entry.installations[0].effective, false)
  assert.equal(entry.installations[0].shadowedBy, 'project-agents')
})

test('Skills UI badges DSH sources and suppresses their absolute location cells', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /dshSkillSourcePresentation/)
  assert.match(page, /v-if="item\.dshSource"[\s\S]*dshSkillSourcePresentation\(item\)\.badge/)
  assert.match(page, /v-if="source\.dshSource"[\s\S]*dshSkillSourcePresentation\(source\)\.status/)
  assert.match(page, /v-if="!item\.dshSource"[\s\S]*item\.entryPath \|\| item\.targetPath/)
  assert.match(page, /v-if="!source\.dshSource"[\s\S]*source\.entryPath \|\| source\.path/)
})

test('CLI matrix offers enable for disabled projections and blocks incompatible targets', () => {
  const matrix = buildSkillCliMatrix({
    status: 'disabled',
    packages: [{ id: 'pkg-1', compatibility: { opencode: { compatible: false, reason: 'Invalid name' } } }],
    installations: [{ id: 'install-1', targetAdapterId: 'codex', enabled: false, status: 'disabled' }],
    sources: [],
    visibility: {}
  }, adapters)

  assert.equal(matrix.find((cell) => cell.adapterId === 'codex').state, 'disabled')
  assert.equal(matrix.find((cell) => cell.adapterId === 'codex').action, 'enable')
  assert.equal(matrix.find((cell) => cell.adapterId === 'opencode').action, null)
  assert.equal(matrix.find((cell) => cell.adapterId === 'opencode').disabledReason, 'Invalid name')
})

test('CLI matrix reports missing and invalid projections instead of claiming they are applied', () => {
  const matrix = buildSkillCliMatrix({
    status: 'missing',
    packages: [{ id: 'pkg-1' }],
    installations: [
      { id: 'missing-1', targetAdapterId: 'claude', enabled: true, status: 'missing' },
      { id: 'invalid-1', targetAdapterId: 'codex', enabled: true, status: 'invalid' }
    ],
    sources: [],
    visibility: {}
  }, adapters)

  assert.equal(matrix.find((cell) => cell.adapterId === 'claude').state, 'missing')
  assert.equal(matrix.find((cell) => cell.adapterId === 'claude').visible, false)
  assert.equal(matrix.find((cell) => cell.adapterId === 'codex').state, 'invalid')
  assert.equal(matrix.find((cell) => cell.adapterId === 'codex').visible, false)
})

test('CLI matrix prefers a healthy deployment across versions and exposes package choices', () => {
  const matrix = buildSkillCliMatrix({
    status: 'ready',
    packages: [
      { id: 'pkg-old', sourceRef: 'v1', compatibility: {} },
      { id: 'pkg-new', sourceRef: 'v2', compatibility: {} }
    ],
    installations: [
      { id: 'old-disabled', packageId: 'pkg-old', targetAdapterId: 'codex', enabled: false, status: 'disabled' },
      { id: 'new-ready', packageId: 'pkg-new', targetAdapterId: 'codex', enabled: true, status: 'ready' }
    ],
    sources: [],
    visibility: { codex: { visible: true, direct: true, inheritedFrom: [] } }
  }, adapters)

  const codex = matrix.find((cell) => cell.adapterId === 'codex')
  const claude = matrix.find((cell) => cell.adapterId === 'claude')
  assert.equal(codex.state, 'managed')
  assert.equal(codex.installation.id, 'new-ready')
  assert.deepEqual(codex.installations.map((item) => item.id), ['new-ready', 'old-disabled'])
  assert.equal(claude.action, null)
  assert.deepEqual(claude.packageOptions.map((pkg) => pkg.id), ['pkg-old', 'pkg-new'])
  assert.match(claude.disabledReason, /具体版本/)
})

test('package apply targets depend only on the selected version deployments', () => {
  const oldProjectVersion = {
    id: 'pkg-old',
    compatibility: {},
    installations: [{ targetAdapterId: 'codex', scopeKey: 'C:/project-old' }]
  }
  const newProjectVersion = {
    id: 'pkg-new',
    compatibility: {},
    installations: [{ targetAdapterId: 'claude', scopeKey: 'C:/project-new' }]
  }

  assert.deepEqual(
    skillPackageApplyTargets(oldProjectVersion, adapters).map((adapter) => adapter.id),
    ['claude', 'opencode', 'ucode']
  )
  assert.deepEqual(
    skillPackageApplyTargets(newProjectVersion, adapters).map((adapter) => adapter.id),
    ['codex', 'opencode', 'ucode']
  )
})

test('Skills presentation makes managed states actionable', () => {
  assert.deepEqual(skillStatusPresentation('ready'), { label: '可用', color: 'green' })
  assert.deepEqual(skillStatusPresentation('update_available'), { label: '有可用更新', color: 'blue' })
  assert.equal(skillStatusPresentation('drifted').label, '已被外部修改')
  assert.equal(skillStatusPresentation('conflict').color, 'red')
  assert.equal(skillOriginLabel('bundled'), 'CLI 内置')
})

test('source kinds distinguish CLI ownership from physical storage', () => {
  assert.equal(skillSourceKindLabel('claude_user'), 'Claude 用户目录')
  assert.equal(skillSourceKindLabel('claude_project'), 'Claude 项目目录')
  assert.equal(skillSourceKindLabel('codex_user'), 'Codex / Agent Skills')
  assert.equal(skillSourceKindLabel('claude_plugin'), 'Claude 插件')
  assert.equal(skillSourceKindLabel('codex_builtin'), 'CLI 内置')
})

test('installed plugin Skills offer independent copies only to other AI CLIs', () => {
  const catalog = aggregateSkillCatalog({
    discovered: [{
      name: 'diagnose',
      description: 'Diagnose bugs',
      sources: [{
        key: 'claude:plugin:diagnose',
        adapterId: 'claude',
        sourceKind: 'claude_plugin',
        scopeType: 'user',
        origin: 'plugin',
        health: 'ready',
        path: 'C:/claude/plugins/diagnose',
        resolvedPath: 'C:/claude/plugins/diagnose',
        contentSha256: 'plugin',
        visibility: { claude: { visible: true, direct: true, inheritedFrom: [] } }
      }]
    }]
  })

  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].builtinOnly, false)
  const claude = buildSkillCliMatrix(catalog[0], adapters).find((cell) => cell.adapterId === 'claude')
  const codex = buildSkillCliMatrix(catalog[0], adapters).find((cell) => cell.adapterId === 'codex')
  assert.equal(claude.action, null)
  assert.equal(codex.action, 'install_copy')
  assert.equal(codex.actionLabel, '安装独立副本')
  assert.equal(codex.copySource.resolvedPath, 'C:/claude/plugins/diagnose')
})

test('plugin copy requests preserve scope and reject unusable sources', () => {
  const userSource = {
    origin: 'plugin', health: 'ready', scopeType: 'user',
    path: 'C:/claude/plugins/diagnose', resolvedPath: 'C:/claude/plugins/diagnose'
  }
  assert.deepEqual(buildPluginCopyInstallRequest(userSource, 'codex'), {
    source: { type: 'local', path: 'C:/claude/plugins/diagnose' },
    targetAdapterIds: ['codex'], scopeType: 'user', projectPath: ''
  })

  const projectSource = { ...userSource, scopeType: 'project' }
  assert.equal(buildPluginCopyInstallRequest(projectSource, 'ucode'), null)
  assert.deepEqual(buildPluginCopyInstallRequest(projectSource, 'ucode', 'D:/project'), {
    source: { type: 'local', path: 'C:/claude/plugins/diagnose' },
    targetAdapterIds: ['ucode'], scopeType: 'project', projectPath: 'D:/project'
  })
  assert.equal(buildPluginCopyInstallRequest({ ...userSource, health: 'broken_link' }, 'codex'), null)
})

test('plugin copies do not offer an incompatible OpenCode target', () => {
  const matrix = buildSkillCliMatrix({
    name: 'Invalid Skill Name', status: 'ready', packages: [], installations: [],
    sources: [{
      adapterId: 'claude', origin: 'plugin', health: 'ready', scopeType: 'user',
      path: 'C:/claude/plugins/invalid', resolvedPath: 'C:/claude/plugins/invalid'
    }],
    visibility: { claude: { visible: true, direct: true, inheritedFrom: [] } }
  }, adapters)

  const opencode = matrix.find((cell) => cell.adapterId === 'opencode')
  assert.equal(opencode.action, null)
  assert.match(opencode.disabledReason, /OpenCode/)
})

test('agents storage alone does not make Claude direct', () => {
  const matrix = buildSkillCliMatrix({
    status: 'ready',
    packages: [],
    installations: [],
    sources: [{
      key: 'codex:user:diagnose',
      adapterId: 'codex',
      sourceKind: 'codex_user',
      origin: 'external',
      health: 'ready',
      visibility: { codex: { visible: true, direct: true, inheritedFrom: [] } }
    }],
    visibility: { codex: { visible: true, direct: true, inheritedFrom: [] } }
  }, adapters)

  assert.equal(matrix.find((cell) => cell.adapterId === 'claude').state, 'unavailable')
  assert.equal(matrix.find((cell) => cell.adapterId === 'codex').state, 'external')
})

test('broken Claude link is visible as a health issue but not CLI availability', () => {
  const catalog = aggregateSkillCatalog({
    discovered: [{
      name: 'lark-doc',
      description: 'Broken link',
      sources: [{
        key: 'claude:user:lark-doc',
        adapterId: 'claude',
        sourceKind: 'claude_user',
        origin: 'external',
        health: 'broken_link',
        status: 'broken_link',
        link: { status: 'broken', targetPath: 'C:/missing/lark-doc' },
        visibility: { claude: { visible: false, direct: false, inheritedFrom: [] } }
      }]
    }]
  })
  const matrix = buildSkillCliMatrix(catalog[0], adapters)
  const claude = matrix.find((cell) => cell.adapterId === 'claude')

  assert.equal(catalog[0].status, 'broken_link')
  assert.equal(claude.state, 'broken_link')
  assert.equal(claude.visible, false)
  assert.equal(claude.direct, false)
  assert.equal(claude.action, null)
})

test('visibility summary distinguishes direct and inherited CLI access', () => {
  assert.equal(skillVisibilitySummary({ direct: true, inheritedFrom: [] }), '直接投放')
  assert.equal(skillVisibilitySummary({ direct: false, inheritedFrom: ['codex'] }), '从 Codex 兼容继承')
  assert.equal(skillVisibilitySummary({ visible: false, direct: false, inheritedFrom: [] }), '不可见')
})

test('Skills is a first-level route with install, adopt and aggregate workflows', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const router = readFileSync(new URL('../src/router.js', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(router, /path:\s*'\/skills'/)
  assert.match(app, /key="\/skills"/)
  assert.match(page, /Skills 聚合视图/)
  assert.match(page, /安装 Skill/)
  assert.match(page, /接管/)
  assert.match(page, /兼容继承/)
  assert.doesNotMatch(page, /编辑 SKILL\.md/)
})

test('aggregate catalog exposes scope and status filters including mirror and invalid states', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /scopeFilter/)
  assert.match(page, /scopeOptions/)
  assert.match(page, /现有 Skill/)
  assert.match(page, /CLI 内置/)
  assert.match(page, /用户级/)
  assert.match(page, /项目级/)
  assert.match(page, /全部范围/)
  assert.match(page, /mirror/)
  assert.match(page, /invalid/)
  assert.match(page, /value: 'missing'/)
})

test('Skills page uses one aggregate catalog and keeps built-ins opt-in', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /aggregateSkillCatalog/)
  assert.match(page, /filterSkillCatalog/)
  assert.match(page, /showBuiltIn/)
  assert.match(page, /显示内置 Skills/)
  assert.match(page, /用户安装/)
  assert.doesNotMatch(page, /activeTab/)
})

const visibleFromCodex = {
  claude: { visible: false, direct: false, inheritedFrom: [] },
  codex: { visible: true, direct: true, inheritedFrom: [] },
  opencode: { visible: true, direct: false, inheritedFrom: ['codex'] },
  ucode: { visible: true, direct: false, inheritedFrom: ['codex'] }
}

test('catalog aggregates a managed package and same-name discovered locations once', () => {
  const catalog = aggregateSkillCatalog({
    packages: [{
      id: 'pkg-1',
      name: 'diagnose',
      description: 'Diagnose hard bugs',
      sourceType: 'local',
      visibility: visibleFromCodex,
      installations: [{
        id: 'installation-1',
        targetAdapterId: 'codex',
        targetPath: 'C:/Users/test/.agents/skills/diagnose',
        scopeType: 'user',
        scopeKey: '*',
        enabled: true,
        status: 'ready'
      }]
    }],
    discovered: [{
      name: 'diagnose',
      description: 'Diagnose hard bugs',
      status: 'mirror',
      sources: [
        {
          key: 'codex:user:managed',
          name: 'diagnose',
          adapterId: 'codex',
          path: 'C:/Users/test/.agents/skills/diagnose',
          entryPath: 'C:/Users/test/.agents/skills/diagnose',
          resolvedPath: 'D:/shared/diagnose',
          sourceKind: 'codex_user',
          health: 'ready',
          link: { status: 'valid', targetPath: 'D:/shared/diagnose' },
          scopeType: 'user',
          origin: 'managed',
          installationId: 'installation-1',
          contentSha256: 'same',
          visibility: visibleFromCodex
        },
        {
          key: 'claude:user:external',
          name: 'diagnose',
          adapterId: 'claude',
          path: 'C:/Users/test/.claude/skills/diagnose',
          scopeType: 'user',
          origin: 'external',
          installationId: null,
          contentSha256: 'same',
          visibility: {
            claude: { visible: true, direct: true, inheritedFrom: [] },
            codex: { visible: false, direct: false, inheritedFrom: [] },
            opencode: { visible: true, direct: false, inheritedFrom: ['claude'] },
            ucode: { visible: true, direct: false, inheritedFrom: ['claude'] }
          }
        }
      ]
    }]
  })

  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, 'diagnose')
  assert.equal(catalog[0].packages.length, 1)
  assert.equal(catalog[0].installations.length, 1)
  assert.equal(catalog[0].installations[0].sourceKind, 'codex_user')
  assert.equal(catalog[0].installations[0].resolvedPath, 'D:/shared/diagnose')
  assert.equal(catalog[0].installations[0].link.status, 'valid')
  assert.deepEqual(catalog[0].sources.map((source) => source.key), ['claude:user:external'])
  assert.equal(catalog[0].status, 'ready')
  assert.equal(catalog[0].visibility.claude.visible, true)
  assert.equal(catalog[0].visibility.codex.visible, true)
})

test('catalog hides built-in-only skills by default and includes them on request', () => {
  const bundledGroup = {
    name: 'system-helper',
    description: 'Built into the CLI',
    status: 'ready',
    sources: [{
      key: 'codex:system:system-helper',
      name: 'system-helper',
      adapterId: 'codex',
      path: 'C:/Users/test/.codex/skills/.system/system-helper',
      scopeType: 'system',
      origin: 'bundled',
      installationId: null,
      contentSha256: 'builtin',
      visibility: visibleFromCodex
    }]
  }

  assert.deepEqual(aggregateSkillCatalog({ discovered: [bundledGroup] }), [])
  const included = aggregateSkillCatalog({ discovered: [bundledGroup], includeBuiltIn: true })
  assert.equal(included.length, 1)
  assert.equal(included[0].builtinOnly, true)
  assert.deepEqual(included[0].sources.map((source) => source.origin), ['bundled'])
})

test('catalog keeps user-installed sources but removes same-name built-ins by default', () => {
  const catalog = aggregateSkillCatalog({
    discovered: [{
      name: 'writing-plans',
      description: 'Write plans',
      status: 'mirror',
      sources: [
        {
          key: 'claude:user:writing-plans', name: 'writing-plans', adapterId: 'claude',
          path: 'C:/Users/test/.claude/skills/writing-plans', scopeType: 'user', origin: 'external',
          installationId: null, contentSha256: 'same', visibility: visibleFromCodex
        },
        {
          key: 'opencode:system:writing-plans', name: 'writing-plans', adapterId: 'opencode',
          path: 'C:/cache/plugin/writing-plans', scopeType: 'system', origin: 'bundled',
          installationId: null, contentSha256: 'same', visibility: visibleFromCodex
        }
      ]
    }]
  })

  assert.equal(catalog.length, 1)
  assert.deepEqual(catalog[0].sources.map((source) => source.origin), ['external'])
  assert.equal(catalog[0].builtinOnly, false)
})

test('catalog filters aggregate entries and their locations by search, CLI, status and scope', () => {
  const entries = aggregateSkillCatalog({
    discovered: [{
      name: 'release-notes',
      description: 'Prepare a release',
      status: 'ready',
      sources: [
        {
          key: 'codex:user:release-notes', name: 'release-notes', adapterId: 'codex',
          path: 'C:/Users/test/.agents/skills/release-notes', scopeType: 'user', origin: 'external',
          installationId: null, contentSha256: 'release', visibility: visibleFromCodex
        },
        {
          key: 'claude:project:release-notes', name: 'release-notes', adapterId: 'claude',
          path: 'D:/project/.claude/skills/release-notes', scopeType: 'project', origin: 'external',
          installationId: null, contentSha256: 'release', visibility: {
            claude: { visible: true, direct: true, inheritedFrom: [] },
            codex: { visible: false, direct: false, inheritedFrom: [] },
            opencode: { visible: true, direct: false, inheritedFrom: ['claude'] },
            ucode: { visible: true, direct: false, inheritedFrom: ['claude'] }
          }
        }
      ]
    }]
  })

  const filtered = filterSkillCatalog(entries, {
    search: 'release', adapterId: 'codex', status: 'ready', scopeType: 'user'
  })
  assert.equal(filtered.length, 1)
  assert.deepEqual(filtered[0].sources.map((source) => source.key), ['codex:user:release-notes'])
  assert.equal(filtered[0].status, 'ready')
  assert.equal(filtered[0].visibility.codex.visible, true)
  assert.equal(filtered[0].visibility.claude?.visible || false, false)
  assert.deepEqual(filterSkillCatalog(entries, { search: 'missing' }), [])
  assert.deepEqual(filterSkillCatalog(entries, { adapterId: 'codex', scopeType: 'project' }), [])
})

test('CLI ownership filter keeps broken locations even when effective visibility is false', () => {
  const entries = aggregateSkillCatalog({
    discovered: [{
      name: 'lark-doc',
      description: 'Broken Claude entry',
      sources: [{
        key: 'claude:user:lark-doc', adapterId: 'claude', sourceKind: 'claude_user',
        scopeType: 'user', origin: 'external', health: 'broken_link', status: 'broken_link',
        visibility: { claude: { visible: false, direct: false, inheritedFrom: [] } }
      }]
    }]
  })

  assert.equal(filterSkillCatalog(entries, { adapterId: 'claude' }).length, 1)
  assert.equal(filterSkillCatalog(entries, { adapterId: 'codex' }).length, 0)
})

test('managed broken links retain discovery health and invalid sources are never visible or actionable', () => {
  const managedCatalog = aggregateSkillCatalog({
    packages: [{
      id: 'pkg-1', name: 'lark-doc', description: 'Managed link', visibility: {},
      installations: [{
        id: 'install-1', targetAdapterId: 'claude', scopeType: 'user', enabled: true,
        status: 'missing', targetPath: 'C:/Users/test/.claude/skills/lark-doc', visibility: {}
      }]
    }],
    discovered: [{
      name: 'lark-doc', description: 'Managed link', sources: [{
        key: 'claude:user:lark-doc', adapterId: 'claude', sourceKind: 'claude_user',
        scopeType: 'user', origin: 'managed', installationId: 'install-1',
        entryPath: 'C:/Users/test/.claude/skills/lark-doc', resolvedPath: 'D:/missing/lark-doc',
        health: 'broken_link', status: 'broken_link', link: { status: 'broken' }, visibility: {}
      }]
    }]
  })
  const managed = managedCatalog[0].installations[0]
  const managedCell = buildSkillCliMatrix(managedCatalog[0], adapters).find((cell) => cell.adapterId === 'claude')
  assert.equal(managed.status, 'broken_link')
  assert.equal(managed.resolvedPath, 'D:/missing/lark-doc')
  assert.equal(managedCell.state, 'broken_link')
  assert.equal(managedCell.direct, false)

  const invalidEntry = {
    status: 'invalid', packages: [], installations: [],
    sources: [{
      adapterId: 'claude', origin: 'external', health: 'invalid', status: 'invalid',
      visibility: { claude: { visible: true, direct: true, inheritedFrom: [] } }
    }],
    visibility: { claude: { visible: true, direct: true, inheritedFrom: [] } }
  }
  const invalidCell = buildSkillCliMatrix(invalidEntry, adapters).find((cell) => cell.adapterId === 'claude')
  assert.equal(invalidCell.state, 'invalid')
  assert.equal(invalidCell.visible, false)
  assert.equal(invalidCell.direct, false)
  assert.equal(invalidCell.action, null)
})

test('status filters match any managed location in a mixed aggregate', () => {
  const entries = aggregateSkillCatalog({
    packages: [{
      id: 'pkg-mixed', name: 'mixed-status', description: 'Mixed installation states',
      visibility: visibleFromCodex,
      installations: [
        {
          id: 'ready-installation', targetAdapterId: 'codex', targetPath: 'C:/ready',
          scopeType: 'user', enabled: true, status: 'ready', deployedSha256: 'same',
          visibility: visibleFromCodex
        },
        {
          id: 'disabled-installation', targetAdapterId: 'claude', targetPath: 'C:/disabled',
          scopeType: 'user', enabled: false, status: 'disabled', deployedSha256: null,
          visibility: {}
        }
      ]
    }]
  })

  assert.equal(entries[0].status, 'ready')
  assert.equal(filterSkillCatalog(entries, { status: 'disabled' }).length, 1)
  assert.equal(filterSkillCatalog(entries, { adapterId: 'claude' }).length, 1)
  assert.equal(filterSkillCatalog(entries, { adapterId: 'codex' }).length, 1)
})

test('GitHub repository URL variants normalize to one safe source-project identity', () => {
  assert.deepEqual(normaliseGitHubRepository('https://github.com/Acme/skills.git'), {
    key: 'github:acme/skills',
    label: 'Acme/skills',
    repositoryUrl: 'https://github.com/Acme/skills'
  })
  assert.deepEqual(normaliseGitHubRepository('https://github.com/acme/SKILLS/'), {
    key: 'github:acme/skills',
    label: 'acme/SKILLS',
    repositoryUrl: 'https://github.com/acme/SKILLS'
  })
  assert.equal(normaliseGitHubRepository('https://example.com/Acme/skills'), null)
  assert.equal(normaliseGitHubRepository('file:///C:/skills'), null)
})

test('GitLab repository URL variants preserve nested groups in one source-project identity', () => {
  assert.deepEqual(normaliseGitLabRepository('https://gitlab.com/Platform/Agent/skills.git'), {
    key: 'gitlab:platform/agent/skills',
    label: 'Platform/Agent/skills',
    repositoryUrl: 'https://gitlab.com/Platform/Agent/skills'
  })
  assert.equal(normaliseGitLabRepository('https://github.com/Platform/skills'), null)

  const entries = aggregateSkillCatalog({
    packages: [{
      id: 'pkg-gitlab', name: 'gitlab-skill', description: 'GitLab skill', sourceType: 'gitlab',
      sourceLocator: 'https://gitlab.com/Platform/Agent/skills.git', visibility: visibleFromCodex,
      installations: [{
        id: 'install-gitlab', targetAdapterId: 'codex', targetPath: 'C:/gitlab-skill',
        scopeType: 'user', enabled: true, status: 'ready', deployedSha256: 'gitlab', visibility: visibleFromCodex
      }]
    }]
  })
  const groups = groupSkillCatalogBySourceProject(entries)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'gitlab:platform/agent/skills')
  assert.equal(groups[0].repositoryUrl, 'https://gitlab.com/Platform/Agent/skills')
})

test('self-hosted GitLab repository identity retains its private HTTP origin', () => {
  assert.deepEqual(normaliseGitLabRepository('http://10.44.51.32:8080/AI/pr-skills'), {
    key: 'gitlab:10.44.51.32:8080/ai/pr-skills',
    label: '10.44.51.32:8080/AI/pr-skills',
    repositoryUrl: 'http://10.44.51.32:8080/AI/pr-skills'
  })
})

test('catalog groups different Skills from the same GitHub repository once', () => {
  const entries = aggregateSkillCatalog({
    packages: [
      {
        id: 'pkg-diagnose', name: 'diagnose', description: 'Diagnose bugs', sourceType: 'github',
        sourceLocator: 'https://github.com/Acme/skills.git', visibility: visibleFromCodex,
        installations: [{
          id: 'install-diagnose', targetAdapterId: 'codex', targetPath: 'C:/diagnose',
          scopeType: 'user', enabled: true, status: 'ready', deployedSha256: 'diagnose', visibility: visibleFromCodex
        }]
      },
      {
        id: 'pkg-release', name: 'release-notes', description: 'Prepare releases', sourceType: 'github',
        sourceLocator: 'https://github.com/acme/SKILLS/', visibility: visibleFromCodex,
        installations: [{
          id: 'install-release', targetAdapterId: 'codex', targetPath: 'C:/release',
          scopeType: 'user', enabled: true, status: 'ready', deployedSha256: 'release', visibility: visibleFromCodex
        }]
      }
    ]
  })

  const groups = groupSkillCatalogBySourceProject(entries)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'github:acme/skills')
  assert.equal(groups[0].label, 'Acme/skills')
  assert.equal(groups[0].repositoryUrl, 'https://github.com/Acme/skills')
  assert.deepEqual(groups[0].entries.map((entry) => entry.name), ['diagnose', 'release-notes'])
})

test('catalog keeps different refs of the same Skill grouped with independent package actions', () => {
  const entries = aggregateSkillCatalog({
    packages: [
      {
        id: 'pkg-main', name: 'diagnose', description: 'Diagnose bugs', sourceType: 'github',
        sourceLocator: 'https://github.com/acme/skills.git', sourceRef: 'main', visibility: visibleFromCodex,
        installations: [{
          id: 'install-main', packageId: 'pkg-main', targetAdapterId: 'codex', targetPath: 'C:/main',
          scopeType: 'user', enabled: true, status: 'ready', deployedSha256: 'main', visibility: visibleFromCodex
        }]
      },
      {
        id: 'pkg-next', name: 'diagnose', description: 'Diagnose bugs', sourceType: 'github',
        sourceLocator: 'https://github.com/acme/skills', sourceRef: 'next', visibility: visibleFromCodex,
        installations: [{
          id: 'install-next', packageId: 'pkg-next', targetAdapterId: 'codex', targetPath: 'C:/next',
          scopeType: 'user', enabled: true, status: 'ready', deployedSha256: 'next', visibility: visibleFromCodex
        }]
      }
    ]
  })

  const groups = groupSkillCatalogBySourceProject(entries)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].entries.length, 1)
  assert.deepEqual(groups[0].entries[0].packages.map((pkg) => pkg.id), ['pkg-main', 'pkg-next'])
  assert.deepEqual(groups[0].entries[0].installations.map((item) => item.id), ['install-main', 'install-next'])
})

test('source-project status filtering is applied after same-name packages are split by repository', () => {
  const entries = aggregateSkillCatalog({
    packages: [
      {
        id: 'pkg-ready', name: 'diagnose', description: 'Diagnose bugs', sourceType: 'github',
        sourceLocator: 'https://github.com/acme/ready-skills.git', visibility: visibleFromCodex,
        installations: [{
          id: 'install-ready', packageId: 'pkg-ready', targetAdapterId: 'codex', targetPath: 'C:/ready',
          scopeType: 'user', enabled: true, status: 'ready', deployedSha256: 'ready', visibility: visibleFromCodex
        }]
      },
      {
        id: 'pkg-disabled', name: 'diagnose', description: 'Diagnose bugs', sourceType: 'github',
        sourceLocator: 'https://github.com/acme/disabled-skills.git', visibility: {},
        installations: [{
          id: 'install-disabled', packageId: 'pkg-disabled', targetAdapterId: 'codex', targetPath: 'C:/disabled',
          scopeType: 'user', enabled: false, status: 'disabled', deployedSha256: null, visibility: {}
        }]
      }
    ]
  })

  const groups = groupSkillCatalogBySourceProject(entries, { status: 'disabled' })
  assert.deepEqual(groups.map((group) => group.key), ['github:acme/disabled-skills'])
  assert.deepEqual(groups[0].entries[0].packages.map((pkg) => pkg.id), ['pkg-disabled'])
  assert.equal(groups[0].entries[0].status, 'disabled')
})

test('catalog separates same-name packages from different repositories and keeps other sources non-linkable', () => {
  const entries = aggregateSkillCatalog({
    packages: [
      {
        id: 'pkg-a', name: 'diagnose', description: 'Diagnose bugs', sourceType: 'github',
        sourceLocator: 'https://github.com/acme/skills-a.git', visibility: visibleFromCodex,
        installations: [{
          id: 'install-a', targetAdapterId: 'codex', targetPath: 'C:/a', scopeType: 'user',
          enabled: true, status: 'ready', deployedSha256: 'a', visibility: visibleFromCodex
        }]
      },
      {
        id: 'pkg-b', name: 'diagnose', description: 'Diagnose bugs', sourceType: 'github',
        sourceLocator: 'https://github.com/acme/skills-b.git', visibility: visibleFromCodex,
        installations: [{
          id: 'install-b', targetAdapterId: 'codex', targetPath: 'C:/b', scopeType: 'user',
          enabled: true, status: 'ready', deployedSha256: 'b', visibility: visibleFromCodex
        }]
      }
    ],
    discovered: [{
      name: 'local-helper', description: 'Local helper', status: 'ready',
      sources: [{
        key: 'codex:user:local-helper', name: 'local-helper', adapterId: 'codex',
        path: 'C:/local-helper', scopeType: 'user', origin: 'external', installationId: null,
        contentSha256: 'local', visibility: visibleFromCodex
      }]
    }]
  })

  const groups = groupSkillCatalogBySourceProject(entries)
  assert.deepEqual(groups.map((group) => group.key), [
    'github:acme/skills-a',
    'github:acme/skills-b',
    'other'
  ])
  assert.deepEqual(groups.slice(0, 2).map((group) => group.entries[0].installations.length), [1, 1])
  assert.deepEqual(groups.slice(0, 2).map((group) => group.entries[0].packages.length), [1, 1])
  assert.equal(groups[2].repositoryUrl, null)
  assert.deepEqual(groups[2].entries.map((entry) => entry.name), ['local-helper'])
})

test('catalog groups discovered external Skills using source-project metadata from the installer lock', () => {
  const discovered = ['diagnose', 'tdd'].map((name) => ({
    name,
    description: `${name} helper`,
    status: 'ready',
    sources: [{
      key: `codex:user:${name}`,
      name,
      adapterId: 'codex',
      path: `C:/${name}`,
      scopeType: 'user',
      origin: 'external',
      installationId: null,
      contentSha256: name,
      visibility: visibleFromCodex,
      sourceProject: { type: 'github', locator: 'https://github.com/mattpocock/skills.git' }
    }]
  }))

  const groups = groupSkillCatalogBySourceProject(aggregateSkillCatalog({ discovered }))
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'github:mattpocock/skills')
  assert.equal(groups[0].repositoryUrl, 'https://github.com/mattpocock/skills')
  assert.deepEqual(groups[0].entries.map((entry) => entry.name), ['diagnose', 'tdd'])
})

test('catalog groups an adopted managed package using restored source-project metadata', () => {
  const entries = aggregateSkillCatalog({
    packages: [{
      id: 'pkg-adopted',
      name: 'executing-plans',
      description: 'Execute implementation plans',
      sourceType: 'adopted',
      sourceLocator: 'C:/executing-plans',
      sourceProject: { type: 'github', locator: 'https://github.com/obra/superpowers' },
      visibility: visibleFromCodex,
      installations: [{
        id: 'install-adopted',
        targetAdapterId: 'codex',
        targetPath: 'C:/executing-plans',
        scopeType: 'user',
        enabled: true,
        status: 'ready',
        deployedSha256: 'adopted',
        visibility: visibleFromCodex
      }]
    }]
  })

  const groups = groupSkillCatalogBySourceProject(entries)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'github:obra/superpowers')
  assert.deepEqual(groups[0].entries[0].packages.map((pkg) => pkg.id), ['pkg-adopted'])
})

test('Skills page renders origin groups with safe external navigation', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /groupSkillCatalogByOrigin/)
  assert.match(page, /打开项目/)
  assert.match(page, /ipc\.openExternal\(sourceProject\.repositoryUrl\)/)
  assert.match(page, /status:\s*'all'/)
  assert.match(page, /groupSkillCatalogByOrigin\(visibleCatalog\.value,\s*\{\s*view:\s*activeView\.value,\s*status:\s*statusFilter\.value\s*\}\)/)
})

test('Skills install workflow auto-detects GitHub or GitLab from the repository address', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /value="git">GitHub \/ GitLab/)
  assert.match(page, /GitHub \/ GitLab 仓库地址/)
  assert.match(page, /https:\/\/github\.com\/owner\/repository\.git/)
  assert.match(page, /https:\/\/gitlab\.com\/group\/project\.git/)
  assert.match(page, /GitLab 源项目/)
  assert.match(page, /自建 GitLab/)
  assert.match(page, /HTTP 仅支持私网/)
  assert.match(page, /type: 'git'/)
})

test('Skills install workflow supports multi-select and select-all for a collection repository', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /sourcePreview\.kind === 'collection'/)
  assert.match(page, /选择要安装的 Skills/)
  assert.match(page, /mode="multiple"/)
  assert.match(page, /collectionSelectedSubdirs/)
  assert.match(page, /collectionSkillOptions/)
  assert.match(page, /toggleCollectionSelectAll/)
  assert.match(page, />全选</)
  assert.match(page, /collectionSelectionState/)
  assert.match(page, /buildSkillCollectionInstallRequests/)
  assert.match(page, /skills\.installMany/)
  assert.match(page, /batchInstallResult/)
  assert.match(page, /failure\.error\.message/)
  assert.match(page, /batchInstallResult\.aborted/)
  assert.match(page, /:disabled="skills\.saving"/)
  assert.match(page, /:keyboard="!skills\.saving"/)
  assert.match(page, /canConfirmSkillInstall/)
  assert.match(page, /inspectionGuard\.isCurrent/)
  assert.match(page, /:disabled="inspecting \|\| skills\.saving"/)
  assert.match(page, /subdir: installDraft\.subdir/)
})

test('Skill source inspection accepts only the latest asynchronous response', () => {
  const guard = createLatestRequestGuard()
  const first = guard.begin()
  const second = guard.begin()

  assert.equal(guard.isCurrent(first), false)
  assert.equal(guard.isCurrent(second), true)
  guard.invalidate()
  assert.equal(guard.isCurrent(second), false)
})

test('Skill collection selection enables install only after matching preflight completes', () => {
  const base = {
    sourceType: 'git',
    subdir: 'skills/productivity/grill-me',
    targetAdapterIds: ['codex'],
    scopeType: 'user',
    projectPath: '',
    preflightKind: 'new_install'
  }
  const collection = {
    kind: 'collection',
    skills: [{ name: 'grill-me', subdir: base.subdir }]
  }
  const staleSkill = {
    kind: 'skill',
    name: 'tdd',
    source: { subdir: 'skills/engineering/tdd' }
  }
  const selectedSkill = {
    kind: 'skill',
    name: 'grill-me',
    source: { subdir: base.subdir }
  }

  assert.equal(canConfirmSkillInstall({ ...base, preview: collection, inspecting: false }), false)
  assert.equal(canConfirmSkillInstall({ ...base, preview: staleSkill, inspecting: true }), false)
  assert.equal(canConfirmSkillInstall({ ...base, preview: staleSkill, inspecting: false }), false)
  assert.equal(canConfirmSkillInstall({ ...base, preview: selectedSkill, inspecting: true }), false)
  assert.equal(canConfirmSkillInstall({ ...base, preview: selectedSkill, inspecting: false }), true)
})

test('Skill collection selection supports partial selection and select all in repository order', () => {
  const collection = {
    kind: 'collection',
    skills: [
      {
        kind: 'skill', name: 'tdd', subdir: 'skills/tdd',
        source: { subdir: 'skills/tdd' }, compatibility: { codex: { compatible: true } },
        installedMatches: [], targetMatches: []
      },
      {
        kind: 'skill', name: 'grill-me', subdir: 'skills/grill-me',
        source: { subdir: 'skills/grill-me' }, compatibility: { codex: { compatible: true } },
        installedMatches: [], targetMatches: []
      }
    ]
  }
  const context = {
    preview: collection, inspecting: false, sourceType: 'git', targetAdapterIds: ['codex'],
    scopeType: 'user', projectPath: ''
  }

  const partial = resolveSkillCollectionInstallSelection({
    ...context, selectedSubdirs: ['skills/grill-me']
  })
  assert.deepEqual(partial.selectedSkills.map((item) => item.name), ['grill-me'])
  assert.equal(partial.allSelected, false)
  assert.equal(partial.partiallySelected, true)
  assert.equal(partial.canInstall, true)

  const all = resolveSkillCollectionInstallSelection({
    ...context, selectedSubdirs: ['skills/grill-me', 'skills/tdd']
  })
  assert.deepEqual(all.selectedSkills.map((item) => item.name), ['tdd', 'grill-me'])
  assert.equal(all.allSelected, true)
  assert.equal(all.partiallySelected, false)
  assert.equal(all.canInstall, true)
})

test('Skill collection selection blocks conflicts, incompatible CLIs and duplicate names', () => {
  const skills = [
    {
      kind: 'skill', name: 'Duplicate', subdir: 'skills/one', source: { subdir: 'skills/one' },
      compatibility: { opencode: { compatible: true } }, installedMatches: [], targetMatches: []
    },
    {
      kind: 'skill', name: 'duplicate', subdir: 'skills/two', source: { subdir: 'skills/two' },
      compatibility: { opencode: { compatible: true } }, installedMatches: [], targetMatches: []
    },
    {
      kind: 'skill', name: 'conflict', subdir: 'skills/conflict', source: { subdir: 'skills/conflict' },
      compatibility: { opencode: { compatible: true } }, installedMatches: [],
      targetMatches: [{ adapterId: 'opencode', matchType: 'conflict' }]
    },
    {
      kind: 'skill', name: 'Bad_Name', subdir: 'skills/incompatible', source: { subdir: 'skills/incompatible' },
      compatibility: { opencode: { compatible: false } }, installedMatches: [], targetMatches: []
    }
  ]
  const state = resolveSkillCollectionInstallSelection({
    preview: { kind: 'collection', skills },
    selectedSubdirs: skills.map((item) => item.subdir),
    inspecting: false,
    sourceType: 'git', targetAdapterIds: ['opencode'], scopeType: 'user', projectPath: ''
  })

  assert.equal(state.canInstall, false)
  assert.deepEqual(state.blockedSkills.map(({ skill, reason }) => ({ name: skill.name, reason })), [
    { name: 'Duplicate', reason: 'duplicate_name' },
    { name: 'duplicate', reason: 'duplicate_name' },
    { name: 'conflict', reason: 'target_conflict' },
    { name: 'Bad_Name', reason: 'incompatible' }
  ])
})

test('Skill collection install requests use selected subdirectories in repository order', () => {
  const requests = buildSkillCollectionInstallRequests({
    preview: {
      kind: 'collection',
      resolvedRevision: 'collection123',
      skills: [
        { name: 'tdd', subdir: 'skills/tdd' },
        { name: 'grill-me', subdir: 'skills/grill-me' },
        { name: 'diagnose', subdir: 'skills/diagnose' }
      ]
    },
    selectedSubdirs: ['skills/diagnose', 'skills/tdd'],
    source: { type: 'git', url: 'https://github.com/example/skills', refType: 'default', ref: '', subdir: '' },
    targetAdapterIds: ['codex', 'claude'],
    scopeType: 'project',
    projectPath: 'C:/project'
  })

  assert.deepEqual(requests, [
    {
      source: { type: 'git', url: 'https://github.com/example/skills', refType: 'default', ref: '', subdir: 'skills/tdd' },
      expectedRevision: 'collection123',
      targetAdapterIds: ['codex', 'claude'], scopeType: 'project', projectPath: 'C:/project'
    },
    {
      source: { type: 'git', url: 'https://github.com/example/skills', refType: 'default', ref: '', subdir: 'skills/diagnose' },
      expectedRevision: 'collection123',
      targetAdapterIds: ['codex', 'claude'], scopeType: 'project', projectPath: 'C:/project'
    }
  ])
})

test('batch install restarts sessions only for newly applied projections', () => {
  const installations = [
    { id: 'claude-installation', targetAdapterId: 'claude' },
    { id: 'codex-installation', targetAdapterId: 'codex' }
  ]
  assert.deepEqual(skillInstallAffectedInstallationIds({ installations }), [
    'claude-installation', 'codex-installation'
  ])
  assert.deepEqual(skillInstallAffectedInstallationIds({
    installations,
    installOutcome: { kind: 'already_installed', appliedAdapterIds: [] }
  }), [])
  assert.deepEqual(skillInstallAffectedInstallationIds({
    installations,
    installOutcome: { kind: 'applied_existing', appliedAdapterIds: ['codex'] }
  }), ['codex-installation'])
  assert.deepEqual(skillInstallAffectedInstallationIds({
    installations,
    installOutcome: { kind: 'adopted_existing', appliedAdapterIds: ['claude'] }
  }), ['claude-installation'])
})

test('Skills page renders an actionable Skill by AI CLI usage matrix', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /buildSkillCliMatrix\(entry, skills\.adapters\)/)
  assert.match(page, /AI CLI 使用情况/)
  assert.match(page, /skills\.applyToAdapter\(cell\.packageId, cell\.adapterId\)/)
  assert.match(page, /packageApplyTargets\(pkg, entry\)/)
  assert.match(page, /applyPackageToAdapter\(entry, pkg, adapter\.id\)/)
  assert.match(page, /直接应用/)
  assert.match(page, /纳入管理/)
})

test('Skill cards open a management drawer while keeping the AI CLI usage summary visible', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /class="skill-card skill-card-summary"/)
  assert.match(page, /@click="openSkillDetail\(sourceProject\.key, entry\)"/)
  assert.match(page, /class="skill-card-cli-summary"/)
  assert.match(page, /class="skill-card-cli-grid"/)
  assert.match(page, /v-model:open="skillDetailOpen"/)
  assert.match(page, /const detailEntry = computed/)
})

test('Skills page presents the online organization catalog with explicit lifecycle actions', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  for (const label of ['组织 Skills', 'REVOKED', 'DEPRECATED', '安装', '更新', '组织提供']) assert.match(page, new RegExp(label))
  assert.match(page, /serverConnection\.skills/)
  assert.match(page, /serverConnection\.installSkill/)
  assert.match(page, /serverConnection\.updateSkill/)
  assert.match(page, /await skills\.load\(projectPath\.value\)/)
})

test('organization Skill actions use catalog version ids and bounded user or project targets', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /serverConnection\.installSkill\(item\.versionId, organizationSkillTargets\(\)\)/)
  assert.match(page, /serverConnection\.updateSkill\(item\.versionId, organizationSkillTargets\(\)\)/)
  assert.doesNotMatch(page, /serverConnection\.(?:installSkill|updateSkill)\(item\.id/)
  assert.match(page, /v-model:value="serverSkillTargets\.scopeType"/)
  assert.match(page, /chooseServerSkillProject/)
  assert.match(page, /serverSkillTargets\.scopeType === 'project' \? serverSkillTargets\.projectPath : ''/)
  assert.doesNotMatch(page, /serverConnection\.error\?\.message \|\| error\?\.message/)
})

test('Skills page explains source ownership, entry paths and broken links', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  assert.match(page, /来源与入口/)
  assert.match(page, /物理位置/)
  assert.match(page, /链接目标已失效/)
  assert.match(page, /skillSourceKindLabel/)
  assert.match(page, /source\.plugin\.id/)
  assert.match(page, /item\.plugin\.id/)
  assert.match(page, /source\.health === 'ready'/)
  assert.match(page, /Skill 无效/)
  assert.match(page, /source\.manageable !== false/)
})

test('management catalog retains installed organization identity and merges only its persisted catalog version', () => {
  assert.equal(typeof skillsPresentation.buildSkillsManagementCatalog, 'function')
  const catalog = skillsPresentation.buildSkillsManagementCatalog({
    packages: [{
      id: 'installed-org', name: 'release-notes', description: 'Installed organization skill',
      sourceIdentity: {
        originKind: 'organization', serverOrigin: 'https://server.example.test/catalog', organizationId: 'org-1',
        organizationName: 'Engineering', identityStatus: 'resolved', catalogVersionId: 'version-1', artifactSha256: 'a'.repeat(64)
      },
      installations: [{ id: 'installation-1', targetAdapterId: 'codex', enabled: true, status: 'ready', scopeType: 'user', visibility: visibleFromCodex }],
      visibility: visibleFromCodex
    }, {
      id: 'unresolved-local', name: 'same-name', description: 'Local copy', sourceType: 'local',
      installations: [], visibility: {}
    }],
    organizationVersions: [{
      versionId: 'version-1', serverOrigin: 'https://server.example.test', organizationId: 'org-1', organizationName: 'Engineering',
      slug: 'release-notes', version: '1.0.0', lifecycleStatus: 'ACTIVE'
    }, {
      versionId: 'version-2', serverOrigin: 'https://server.example.test', organizationId: 'org-1', organizationName: 'Engineering',
      slug: 'release-notes', version: '2.0.0', lifecycleStatus: 'ACTIVE'
    }]
  })

  const organizationEntry = catalog.find((entry) => entry.packages.some((pkg) => pkg.id === 'installed-org'))
  assert.equal(organizationEntry.installed, true)
  assert.equal(organizationEntry.organizationVersions.length, 1)
  assert.equal(organizationEntry.organizationVersions[0].installedPackageId, 'installed-org')
  assert.equal(catalog.find((entry) => entry.organizationVersions?.[0]?.versionId === 'version-2').installed, false)
  assert.equal(catalog.find((entry) => entry.packages.some((pkg) => pkg.id === 'unresolved-local')).originKind, null)
})

test('origin grouping uses stored organization identity and retains distinct local origins', () => {
  assert.equal(typeof skillsPresentation.groupSkillCatalogByOrigin, 'function')
  const entries = skillsPresentation.buildSkillsManagementCatalog({
    packages: [{
      id: 'org-package', name: 'organization-skill', installations: [], visibility: {},
      sourceIdentity: {
        originKind: 'organization', serverOrigin: 'https://server.example.test/path', organizationId: 'org-1',
        organizationName: 'Engineering', identityStatus: 'resolved', catalogVersionId: 'version-1', artifactSha256: 'a'.repeat(64)
      }
    }, {
      id: 'github-package', name: 'git-skill', sourceType: 'github', sourceLocator: 'https://github.com/acme/skills.git', installations: [], visibility: {}
    }, {
      id: 'local-package', name: 'local-skill', sourceType: 'local', installations: [], visibility: {}
    }],
    discovered: [{ name: 'built-in', sources: [{ key: 'builtin', adapterId: 'codex', origin: 'bundled', sourceKind: 'codex_builtin', scopeType: 'system', visibility: {} }] }],
    includeBuiltIn: true
  })
  const groups = skillsPresentation.groupSkillCatalogByOrigin(entries, { view: 'all' })

  assert.deepEqual(groups.map((group) => group.key), [
    'organization:https://server.example.test:org-1',
    'github:acme/skills',
    'local:managed',
    'local:builtin:codex'
  ])
  assert.notEqual(groups[0].key, 'local:unresolved')
  assert.deepEqual(skillsPresentation.groupSkillCatalogByOrigin(entries, { view: 'organization' }).map((group) => group.key), [
    'organization:https://server.example.test:org-1'
  ])
  assert.deepEqual(skillsPresentation.groupSkillCatalogByOrigin(entries, { view: 'local', status: 'ready' }).map((group) => group.key), [
    'github:acme/skills', 'local:managed', 'local:builtin:codex'
  ])
})

test('CLI state cells expose desired, actual and blocked state without a direct installation toggle', () => {
  assert.equal(typeof skillsPresentation.buildSkillCliStateCells, 'function')
  const [claude, codex] = skillsPresentation.buildSkillCliStateCells({
    packages: [{
      id: 'pkg-1',
      cliDesiredStates: [{ packageId: 'pkg-1', scopeType: 'user', scopeKey: '*', adapterId: 'claude', desiredState: 'disabled', enforcementStatus: 'blocked', reasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED' }]
    }],
    installations: [{ id: 'install-1', packageId: 'pkg-1', targetAdapterId: 'codex', scopeType: 'user', scopeKey: '*', enabled: true, status: 'ready' }],
    visibility: { claude: { visible: true, direct: false, inheritedFrom: ['codex'] }, codex: { visible: true, direct: true, inheritedFrom: [] } }
  }, [
    { id: 'claude', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex' }
  ])

  assert.deepEqual({ desiredState: claude.desiredState, actualState: claude.actualState, enforcementStatus: claude.enforcementStatus, actionability: claude.actionability }, {
    desiredState: 'disabled', actualState: 'inherited', enforcementStatus: 'blocked', actionability: 'blocked'
  })
  assert.deepEqual({ desiredState: codex.desiredState, actualState: codex.actualState, enforcementStatus: codex.enforcementStatus, actionability: codex.actionability }, {
    desiredState: 'enabled', actualState: 'enabled', enforcementStatus: 'satisfied', actionability: 'direct'
  })
})

test('Skills page separates organization and local views with preview-based CLI controls', () => {
  const page = readFileSync(new URL('../src/views/SkillsCenter.vue', import.meta.url), 'utf8')
  const matrixPath = new URL('../src/components/skills/SkillCliStateMatrix.vue', import.meta.url)
  assert.equal(existsSync(matrixPath), true)
  const matrix = readFileSync(matrixPath, 'utf8')

  for (const label of ['全部', '组织 Skills', '本地 Skills', '同步组织目录', '重新扫描本地']) assert.match(page, new RegExp(label))
  assert.match(page, /SkillCliStateMatrix/)
  assert.match(page, /buildSkillsManagementCatalog/)
  assert.match(page, /groupSkillCatalogByOrigin/)
  assert.match(matrix, /preview-change/)
  assert.match(matrix, /SKILL_CLI_ISOLATION_UNSUPPORTED/)
  assert.match(matrix, /:checked="cell\.desiredState !== 'disabled'"/)
  assert.doesNotMatch(page, /setSkillEnabled\(item\.id, false\)/)
})
