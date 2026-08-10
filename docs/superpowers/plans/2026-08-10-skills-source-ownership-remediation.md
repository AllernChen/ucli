# Skills Source Ownership Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make UCLI accurately distinguish where a Skill is stored, which AI CLI discovers it, how it becomes visible, and whether links or plugin registrations are healthy.

**Architecture:** Replace directory-name inference with explicit discovery-location metadata. Claude user/project roots, Codex Agent Skills roots, installed-plugin roots, and CLI built-ins remain separate source kinds; the presentation layer derives the CLI matrix from valid locations instead of treating physical storage as ownership. Broken links remain visible as health issues, while plugins containing only commands or MCP servers are excluded from the Skill catalog.

**Tech Stack:** Electron 32, Node.js filesystem APIs, Vue 3, Pinia, Ant Design Vue 4, Node.js ESM test runner, electron-vite.

## Global Constraints

- Claude personal Skills are discovered from `~/.claude/skills/<name>/SKILL.md`.
- Claude project Skills are discovered from `<project>/.claude/skills/<name>/SKILL.md`.
- Claude plugin Skills are discovered only from active entries in `~/.claude/plugins/installed_plugins.json`.
- `~/.agents/skills` is a Codex/Agent Skills location, not a Claude-owned location.
- A valid link under `~/.claude/skills` may point into `~/.agents/skills`; the Claude entry and physical target must both be shown without changing ownership semantics.
- A dangling symlink/junction must be shown as `broken_link`, not silently discarded and not treated as CLI-visible.
- Installed Claude plugins are user/project-installed extensions, not CLI built-ins; plugin Skills appear in the default catalog.
- Plugins with commands, agents, hooks, or MCP servers but no `SKILL.md` do not become fake Skills.
- Project-scoped plugin entries appear only when their normalized `projectPath` matches the selected project.
- Nested plugin layouts such as `skills/engineering/diagnose/SKILL.md` are supported with bounded recursive traversal.
- Existing managed packages, source-project grouping, update handling, and safe apply-to-CLI behavior remain compatible.
- Existing uncommitted user changes must be preserved.
- Every behavior change follows red-green-refactor; final acceptance requires focused tests, `npm test`, `npm run build`, and `git diff --check`.

## File Structure

- Create `electron/skills/discovery.js`: filesystem and plugin-registry discovery; produces normalized location records only.
- Modify `electron/skills/service.js`: supplies managed-installation context, groups discovery records, and exposes state.
- Modify `src/skillsPresentation.js`: source-kind labels, default visibility, health aggregation, and CLI matrix derivation.
- Modify `src/views/SkillsCenter.vue`: source ownership, link health, plugin identity, and explanatory UI.
- Modify `test/skills-service.test.mjs`: real filesystem discovery regression coverage.
- Modify `test/skills-presentation.test.mjs`: catalog and matrix behavior coverage.

---

### Task 1: Normalize Skill discovery locations

**Files:**
- Create: `electron/skills/discovery.js`
- Modify: `electron/skills/service.js`
- Modify: `test/skills-service.test.mjs`

**Interfaces:**
- Produces: `createSkillDiscovery({ home, env, inspectSkillDirectory })`.
- Produces: `discovery.discover({ projectPath, managedInstallations })` returning `SkillLocation[]`.
- `SkillLocation` fields: `key`, `name`, `description`, `adapterId`, `sourceKind`, `scopeType`, `scopeKey`, `entryPath`, `resolvedPath`, `origin`, `health`, `contentSha256`, `installationId`, `visibility`, `link`, and optional `plugin`.
- Private discovery units: `scanDeclaredRoot(options)`, `discoverRootLocations(options)`, `discoverProjectLocations(projectPath)`, `discoverClaudePluginLocations(projectPath)`, and `discoverBundledLocations()`; each returns `SkillLocation[]`.
- Test helpers added beside `createSkill`: `findSources(state, name)`, `findSource(state, name, adapterId)`, `createDirectoryLink(target, entry)`, and `writeInstalledPlugins(pluginsRoot, plugins)`.

- [x] **Step 1: Write failing ownership tests**

```js
function findSources(state, name) {
  return state.discovered.find(group => group.name === name)?.sources || []
}

function findSource(state, name, adapterId) {
  return findSources(state, name).find(source => source.adapterId === adapterId) || null
}

function createDirectoryLink(target, entry) {
  mkdirSync(dirname(entry), { recursive: true })
  symlinkSync(target, entry, process.platform === 'win32' ? 'junction' : 'dir')
}

function writeInstalledPlugins(pluginsRoot, plugins) {
  mkdirSync(pluginsRoot, { recursive: true })
  writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
}

test('agents root is Codex-owned and does not imply Claude visibility', async () => {
  createSkill(join(root, 'home', '.agents', 'skills', 'diagnose'), 'Diagnose bugs', 'diagnose')
  const source = findSource(await service.getState(), 'diagnose', 'codex')
  assert.equal(source.sourceKind, 'codex_user')
  assert.equal(source.visibility.codex.direct, true)
  assert.equal(source.visibility.claude.visible, false)
})

test('Claude root remains Claude-owned when its entry links into agents storage', async () => {
  const target = join(root, 'home', '.agents', 'skills', 'diagnose')
  const entry = join(root, 'home', '.claude', 'skills', 'diagnose')
  createSkill(target, 'Diagnose bugs', 'diagnose')
  createDirectoryLink(target, entry)
  const sources = findSources(await service.getState(), 'diagnose')
  assert.deepEqual(sources.map(item => item.adapterId).sort(), ['claude', 'codex'])
  assert.equal(sources.find(item => item.adapterId === 'claude').link.status, 'valid')
})
```

- [x] **Step 2: Run `node --test test/skills-service.test.mjs` and confirm RED**

- [x] **Step 3: Implement normalized location discovery**

```js
export function createSkillDiscovery({ home, env, inspectSkillDirectory }) {
  function discoverRootLocations({ adapterId, sourceKind, scopeType, root }) {
    return scanDeclaredRoot({ adapterId, sourceKind, scopeType, root, inspectSkillDirectory })
  }

  function discoverProjectLocations(projectPath) {
    if (!projectPath) return []
    return [
      ...discoverRootLocations({ adapterId: 'claude', sourceKind: 'claude_project', scopeType: 'project', root: join(projectPath, '.claude', 'skills') }),
      ...discoverRootLocations({ adapterId: 'codex', sourceKind: 'codex_project', scopeType: 'project', root: join(projectPath, '.agents', 'skills') })
    ]
  }

  return {
    discover({ projectPath, managedInstallations = [] } = {}) {
      return [
        ...discoverRootLocations({ adapterId: 'claude', sourceKind: 'claude_user', scopeType: 'user', root: join(home, '.claude', 'skills') }),
        ...discoverRootLocations({ adapterId: 'codex', sourceKind: 'codex_user', scopeType: 'user', root: join(home, '.agents', 'skills') }),
        ...discoverProjectLocations(projectPath),
        ...discoverClaudePluginLocations(projectPath),
        ...discoverBundledLocations()
      ]
    }
  }
}
```

- [x] **Step 4: Move filesystem discovery helpers out of `service.js` without changing package/install APIs**

- [x] **Step 5: Run the service tests and confirm GREEN**

### Task 2: Surface valid and broken links

**Files:**
- Modify: `electron/skills/discovery.js`
- Modify: `test/skills-service.test.mjs`

**Interfaces:**
- `link`: `null | { type: 'symlink' | 'junction', targetPath: string, status: 'valid' | 'broken' }`.
- `health`: `ready | invalid | broken_link` for unmanaged locations.

- [x] **Step 1: Write a failing dangling-junction regression test**

```js
test('dangling Claude Skill links remain visible as broken locations', async () => {
  createDirectoryLink(join(root, 'home', '.agents', 'skills', 'missing'), join(root, 'home', '.claude', 'skills', 'missing'))
  const source = findSource(await service.getState(), 'missing', 'claude')
  assert.equal(source.health, 'broken_link')
  assert.equal(source.visibility.claude.visible, false)
  assert.equal(source.link.status, 'broken')
})
```

- [x] **Step 2: Run the single test and confirm RED because dangling entries are currently skipped**

- [x] **Step 3: Inspect directory entries with `lstatSync`/`readlinkSync` before following them**

```js
function inspectLink(entryPath) {
  const stat = lstatSync(entryPath)
  if (!stat.isSymbolicLink()) return null
  const targetPath = resolve(dirname(entryPath), readlinkSync(entryPath))
  return { type: process.platform === 'win32' ? 'junction' : 'symlink', targetPath, status: existsSync(targetPath) ? 'valid' : 'broken' }
}
```

- [x] **Step 4: Emit metadata-only records for broken entries and never hash or traverse missing targets**

- [x] **Step 5: Run the service tests and confirm GREEN on platforms with link privileges; retain the existing permission-aware skip only for link creation**

### Task 3: Correct Claude plugin discovery and scope

**Files:**
- Modify: `electron/skills/discovery.js`
- Modify: `test/skills-service.test.mjs`

**Interfaces:**
- `readInstalledClaudePlugins(projectPath)` returns `{ pluginId, marketplace, scopeType, scopeKey, installPath }[]`.
- Plugin locations use `origin: 'plugin'`, `sourceKind: 'claude_plugin'`, and `plugin: { id, marketplace }`.

- [x] **Step 1: Write failing plugin classification, scope, and nesting tests**

```js
test('user plugin Skills are user-installed and nested Skills are discovered', async () => {
  createSkill(join(pluginRoot, 'skills', 'engineering', 'diagnose'), 'Diagnose bugs', 'diagnose')
  writeInstalledPlugins({ 'mattpocock-skills@mattpocock-skills': [{ scope: 'user', installPath: pluginRoot }] })
  const source = findSource(await service.getState(), 'diagnose', 'claude')
  assert.equal(source.origin, 'plugin')
  assert.equal(source.scopeType, 'user')
  assert.equal(source.plugin.id, 'mattpocock-skills')
})

test('project plugin Skills appear only for their registered project', async () => {
  writeInstalledPlugins({ 'superpowers@marketplace': [{ scope: 'project', projectPath: projectA, installPath: pluginRoot }] })
  assert.ok(findSource(await service.getState({ projectPath: projectA }), 'writing-plans', 'claude'))
  assert.equal(findSource(await service.getState({ projectPath: projectB }), 'writing-plans', 'claude'), null)
})
```

- [x] **Step 2: Run the plugin tests and confirm RED**

- [x] **Step 3: Preserve registry metadata instead of reducing entries to install paths**

- [x] **Step 4: Traverse directories below a `skills` container with a maximum depth of 6; stop descending once a directory containing `SKILL.md` is accepted**

- [x] **Step 5: Add a negative fixture where `commands/*.md` and `.mcp.json` exist without `SKILL.md`; assert no Skill is emitted**

```js
test('commands and MCP-only plugins do not create fake Skills', async () => {
  mkdirSync(join(pluginRoot, 'commands'), { recursive: true })
  writeFileSync(join(pluginRoot, 'commands', 'commit.md'), '# Commit')
  writeFileSync(join(pluginRoot, '.mcp.json'), '{"mcpServers":{}}')
  writeInstalledPlugins(pluginsRoot, {
    'commit-commands@official': [{ scope: 'user', installPath: pluginRoot }]
  })
  const sources = (await service.getState()).discovered.flatMap(group => group.sources)
  assert.equal(sources.some(source => source.plugin?.id === 'commit-commands'), false)
})
```

- [x] **Step 6: Run the service tests and confirm GREEN**

### Task 4: Derive catalog and CLI matrix from ownership plus health

**Files:**
- Modify: `src/skillsPresentation.js`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- Produces: `skillSourceKindLabel(sourceKind)`.
- `aggregateSkillCatalog` includes `plugin` sources by default and hides only true `bundled/system` sources.
- `buildSkillCliMatrix` marks a CLI direct only when a location owned by that adapter has usable health or a healthy managed projection exists.

- [x] **Step 1: Write failing presentation tests**

```js
test('installed plugin Skills remain in the default catalog', () => {
  const catalog = aggregateSkillCatalog({ discovered: [pluginGroup] })
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].builtinOnly, false)
})

test('agents storage alone does not make Claude direct', () => {
  const matrix = buildSkillCliMatrix(codexOnlyEntry, adapters)
  assert.equal(matrix.find(cell => cell.adapterId === 'claude').state, 'unavailable')
  assert.equal(matrix.find(cell => cell.adapterId === 'codex').state, 'external')
})

test('broken Claude link is visible as a health issue but not CLI availability', () => {
  const matrix = buildSkillCliMatrix(brokenClaudeEntry, adapters)
  assert.equal(matrix.find(cell => cell.adapterId === 'claude').state, 'broken_link')
  assert.equal(matrix.find(cell => cell.adapterId === 'claude').visible, false)
})
```

- [x] **Step 2: Run `node --test test/skills-presentation.test.mjs` and confirm RED**

- [x] **Step 3: Add source labels for Claude 用户目录, Claude 项目目录, Codex / Agent Skills, Claude 插件, and CLI 内置**

- [x] **Step 4: Add `broken_link` matrix/status presentation and exclude it from effective visibility**

- [x] **Step 5: Run presentation tests and confirm GREEN**

### Task 5: Rework the Skills page ownership presentation

**Files:**
- Modify: `src/views/SkillsCenter.vue`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- Consumes normalized `sourceKind`, `entryPath`, `resolvedPath`, `link`, `plugin`, and `health` fields.

- [x] **Step 1: Add a failing page contract test for ownership and link-health copy**

```js
assert.match(page, /来源与入口/)
assert.match(page, /物理位置/)
assert.match(page, /链接目标已失效/)
assert.match(page, /Claude 插件/)
assert.match(page, /Codex \/ Agent Skills/)
```

- [x] **Step 2: Replace the ambiguous location list with explicit source rows**

Each row renders:

```text
[Claude 用户目录] [用户级] [有效/失效]
入口：C:\Users\...\.claude\skills\diagnose
物理位置：C:\Users\...\.agents\skills\diagnose   (only when linked)
```

- [x] **Step 3: Render plugin identity as `<pluginId>@<marketplace>` and keep it in the default catalog**

- [x] **Step 4: Render broken links with a red health tag and explanatory text; do not expose 接管/应用 actions from the broken source itself**

- [x] **Step 5: Keep the Skill × AI CLI matrix and package-specific apply menus unchanged except for corrected states**

- [x] **Step 6: Run focused presentation/service tests and `npm run build`**

### Task 6: Real-machine fixture audit and regression verification

**Files:**
- Create: `scripts/audit-skill-discovery.mjs`
- Create: `test/skills-audit.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `auditSkills({ home, projectPath, discovery })` returning `{ countsBySourceKind, countsByHealth, locations }`.
- Produces read-only command: `npm run audit:skills`.
- Output contains counts only plus safe paths under known Skill roots; it never mutates Skill directories or UCLI persistence.

- [x] **Step 1: Add a fixture-mode test for deterministic audit output**

```js
function snapshotDirectory(root) {
  return readdirSync(root, { recursive: true })
    .map(value => String(value).replaceAll('\\', '/'))
    .sort()
}

test('Skill audit summarizes source kinds and health without mutation', async () => {
  const before = snapshotDirectory(fixtureHome)
  const report = await auditSkills({ home: fixtureHome, projectPath: fixtureProject })
  assert.deepEqual(report.countsBySourceKind, {
    claude_user: 1,
    codex_user: 1,
    claude_plugin: 1
  })
  assert.equal(report.countsByHealth.broken_link, 1)
  assert.deepEqual(snapshotDirectory(fixtureHome), before)
})
```

- [x] **Step 2: Implement the read-only audit command using the same discovery module as production**

```json
{
  "scripts": {
    "audit:skills": "node scripts/audit-skill-discovery.mjs",
    "test:skills-audit": "node --test test/skills-audit.test.mjs"
  }
}
```

- [x] **Step 3: Run `npm run audit:skills` on the current machine and verify these classifications**

```text
~/.claude/skills/*        => Claude user entry
~/.agents/skills/*        => Codex / Agent Skills entry
installed plugin Skills   => Claude plugin entry
commands/MCP-only plugin  => zero Skill records
dangling links            => broken_link records
```

- [x] **Step 4: Run `npm test` and require zero failures**

- [x] **Step 5: Run `npm run build` and require exit code 0**

- [x] **Step 6: Run `git diff --check` and inspect the scoped diff**

- [x] **Step 7: Request code review focused on ownership semantics, bounded traversal, link safety, and project-plugin isolation**

## Explicit Follow-up Boundary

Claude plugins that contain only commands, agents, hooks, or MCP servers belong in a separate **AI CLI Extensions** inventory, not the Skill catalog. Implement that inventory as a separate plan after this remediation so its lifecycle and enable/disable semantics are not conflated with `SKILL.md` management.
