# Skills Source Project Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the Skills catalog by normalized GitHub source repository and provide a safe “打开项目” entry for each GitHub group.

**Architecture:** Keep persisted Skill packages unchanged and derive repository identity from the existing `sourceType` and `sourceLocator` fields in the renderer presentation layer. Split aggregated Skill entries into GitHub repository groups while retaining per-package refs, installations, status, visibility, and actions; place local, adopted, external, and built-in sources in one non-linkable fallback group. Open repository pages through the existing validated `ipc.openExternal` boundary.

**Tech Stack:** Vue 3, Ant Design Vue 4, Electron IPC, Node.js ESM test runner, electron-vite.

## Global Constraints

- Repositories are grouped by normalized GitHub owner/repository identity, ignoring URL case, trailing slash, and `.git` suffix.
- Different refs from the same repository remain in one source-project group; each Skill retains its own ref and update behavior.
- Only valid GitHub HTTPS repository URLs receive an external navigation entry.
- External navigation must use the existing main-process HTTP(S) allowlist through `ipc.openExternal`.
- Non-GitHub sources are not assigned a guessed repository.
- Existing user-first filtering, built-in opt-in behavior, same-name aggregation, and all management actions remain available.
- Existing uncommitted work must be preserved.
- Behavior changes follow red-green-refactor and must pass the full test suite and production build.

---

### Task 1: Source-project presentation model

**Files:**
- Modify: `src/skillsPresentation.js`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- Consumes: filtered entries returned by `filterSkillCatalog`.
- Produces: `normaliseGitHubRepository(sourceLocator)` returning `{ key, label, repositoryUrl }` or `null`.
- Produces: `groupSkillCatalogBySourceProject(entries)` returning `{ key, kind, label, repositoryUrl, entries }[]`.

- [ ] **Step 1: Write failing repository normalization and grouping tests**

```js
test('source projects normalize GitHub URL variants into one repository group', () => {
  const groups = groupSkillCatalogBySourceProject(entriesFromSameRepository)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, 'Acme/skills')
  assert.equal(groups[0].repositoryUrl, 'https://github.com/Acme/skills')
  assert.deepEqual(groups[0].entries.map(entry => entry.name), ['diagnose', 'release-notes'])
})

test('non-GitHub catalog locations remain in a non-linkable fallback group', () => {
  const groups = groupSkillCatalogBySourceProject(localAndExternalEntries)
  assert.equal(groups[0].kind, 'other')
  assert.equal(groups[0].repositoryUrl, null)
})
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test test/skills-presentation.test.mjs`
Expected: FAIL because the source-project functions are not exported.

- [ ] **Step 3: Implement minimal normalization and grouping**

```js
export function normaliseGitHubRepository(sourceLocator) {
  // Accept only https://github.com/{owner}/{repository}[.git] and return a
  // canonical browser URL plus a case-insensitive grouping key.
}

export function groupSkillCatalogBySourceProject(entries = []) {
  // Split packages/installations by repository and preserve other sources in
  // a fallback group, then derive each group entry's status and visibility.
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `node --test test/skills-presentation.test.mjs`
Expected: PASS.

### Task 2: Source-project sections and navigation

**Files:**
- Modify: `src/views/SkillsCenter.vue`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- Consumes: `groupSkillCatalogBySourceProject(visibleCatalog)`.
- Produces: project sections with repository label, Skill count, and an “打开项目” button calling `ipc.openExternal(repositoryUrl)`.

- [ ] **Step 1: Write failing page contract test**

```js
test('Skills page renders source-project groups with a safe external navigation action', () => {
  assert.match(page, /groupSkillCatalogBySourceProject/)
  assert.match(page, /打开项目/)
  assert.match(page, /ipc\.openExternal\(sourceProject\.repositoryUrl\)/)
})
```

- [ ] **Step 2: Run test and confirm RED**

Run: `node --test test/skills-presentation.test.mjs`
Expected: FAIL because the page still renders one flat catalog grid.

- [ ] **Step 3: Render source-project sections**

```vue
<section v-for="sourceProject in sourceProjects" :key="sourceProject.key">
  <header>
    <strong>{{ sourceProject.label }}</strong>
    <a-button v-if="sourceProject.repositoryUrl" @click="openSourceProject(sourceProject)">打开项目</a-button>
  </header>
  <div class="skills-grid">
    <a-card v-for="entry in sourceProject.entries" :key="entry.key">
      <!-- preserve existing aggregate Skill card content and actions -->
    </a-card>
  </div>
</section>
```

- [ ] **Step 4: Route navigation through the existing safe IPC**

```js
async function openSourceProject(sourceProject) {
  const opened = await ipc.openExternal(sourceProject.repositoryUrl)
  if (!opened) message.error('无法打开项目地址')
}
```

- [ ] **Step 5: Run focused tests and build**

Run: `node --test test/skills-presentation.test.mjs test/external-links.test.mjs`
Expected: PASS.

Run: `npm run build`
Expected: exit 0.

### Task 3: Verification and review

**Files:**
- Review: all changed Skills presentation, page, and test files.

**Interfaces:**
- Consumes: completed source-project grouping.
- Produces: test/build evidence and independent review findings.

- [ ] **Step 1: Run full tests**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 2: Run production build and diff check**

Run: `npm run build`
Expected: exit 0.

Run: `git diff --check`
Expected: exit 0.

- [ ] **Step 3: Confirm requirement coverage**

Verify repository URL normalization, one group per repository, preservation of per-Skill refs/actions, fallback grouping for non-GitHub sources, and safe external navigation.
