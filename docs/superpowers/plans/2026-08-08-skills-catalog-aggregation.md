# Skills Catalog Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split managed/discovered Skills page with one aggregated catalog that shows user-installed Skills by default and hides CLI built-ins until explicitly requested.

**Architecture:** Keep discovery and persistence contracts unchanged. Add pure renderer presentation functions that merge managed packages and discovered sources by Skill name, deduplicate managed projections, derive aggregate status/visibility, and filter built-in-only sources. Render that catalog from `SkillsCenter.vue` while preserving existing install, adopt, update, enable, drift, remove, project-scope, and detail actions.

**Tech Stack:** Electron 32, Vue 3, Pinia, Ant Design Vue 4, Node.js ESM test runner, electron-vite.

## Global Constraints

- Default catalog content is user-installed Skills: UCLI-managed packages plus external user/project Skills.
- Sources whose origin is `bundled` or `system` are hidden by default and appear only after the user enables “显示内置 Skills”.
- Same-name managed packages and discovered sources render as one aggregate Skill entry.
- Existing filesystem discovery, SQLite persistence, IPC contracts, installation/update/adoption behavior, and session restart behavior remain unchanged.
- Existing uncommitted user changes must be preserved.
- Every behavior change follows red-green-refactor and must pass the full test suite and production build.

---

### Task 1: Aggregated catalog presentation model

**Files:**
- Modify: `src/skillsPresentation.js`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- Consumes: `packages` from `skills:get-state` and `discovered` name groups from the Skills service.
- Produces: `aggregateSkillCatalog({ packages, discovered, includeBuiltIn })` returning catalog entries with `name`, `description`, `packages`, `installations`, `sources`, `visibility`, `status`, and `builtinOnly`.
- Produces: `filterSkillCatalog(entries, { search, adapterId, status, scopeType })` returning filtered entries and filtered child sources/installations.

- [ ] **Step 1: Write failing aggregate tests**

```js
test('catalog aggregates same-name managed and external projections once', () => {
  const catalog = aggregateSkillCatalog({ packages: [managedPackage], discovered: [discoveredGroup] })
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].installations.length, 1)
  assert.equal(catalog[0].sources.filter(source => source.origin === 'external').length, 1)
})

test('catalog hides built-in-only skills by default and includes them on request', () => {
  assert.deepEqual(aggregateSkillCatalog({ discovered: [bundledGroup] }), [])
  assert.equal(aggregateSkillCatalog({ discovered: [bundledGroup], includeBuiltIn: true }).length, 1)
})
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test test/skills-presentation.test.mjs`
Expected: FAIL because `aggregateSkillCatalog` and `filterSkillCatalog` are not exported.

- [ ] **Step 3: Implement the minimal pure aggregation and filtering functions**

```js
export function aggregateSkillCatalog({ packages = [], discovered = [], includeBuiltIn = false } = {}) {
  // Merge by exact manifest name, keep managed installations once, and omit
  // bundled/system sources unless includeBuiltIn is true.
}

export function filterSkillCatalog(entries, filters = {}) {
  // Apply search, CLI visibility, aggregate status, and scope filters while
  // retaining only matching child locations.
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `node --test test/skills-presentation.test.mjs`
Expected: PASS.

### Task 2: Unified Skills catalog page

**Files:**
- Modify: `src/views/SkillsCenter.vue`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- Consumes: `aggregateSkillCatalog` and `filterSkillCatalog` from Task 1.
- Produces: one catalog grid with aggregate cards and a default-off `showBuiltIn` control.

- [ ] **Step 1: Write failing page contract test**

```js
test('Skills page uses one aggregate catalog and keeps built-ins opt-in', () => {
  assert.match(page, /aggregateSkillCatalog/)
  assert.match(page, /showBuiltIn/)
  assert.match(page, /显示内置 Skills/)
  assert.doesNotMatch(page, /activeTab/)
})
```

- [ ] **Step 2: Run test and confirm RED**

Run: `node --test test/skills-presentation.test.mjs`
Expected: FAIL because the page still renders separate managed and discovered tabs.

- [ ] **Step 3: Replace the split tabs with aggregate cards**

```vue
<div class="skills-catalog-toolbar">
  <span>用户安装的 Skills</span>
  <a-switch v-model:checked="showBuiltIn" />
  <span>显示内置 Skills</span>
</div>
<div v-if="visibleCatalog.length" class="skills-grid">
  <a-card v-for="entry in visibleCatalog" :key="entry.name">
    <!-- aggregate status, locations, managed actions, external adopt actions -->
  </a-card>
</div>
```

- [ ] **Step 4: Preserve all existing management actions**

Keep installation toggles, drift resolution, removal, update preview, detail drawer, external adoption, install flow, project selection, update checks, and session restart prompts connected to the same store methods.

- [ ] **Step 5: Run focused tests and build**

Run: `node --test test/skills-presentation.test.mjs test/skills-service.test.mjs`
Expected: PASS.

Run: `npm run build`
Expected: exit 0.

### Task 3: Full verification and review

**Files:**
- Review: all files changed relative to the starting worktree.

**Interfaces:**
- Consumes: completed catalog implementation.
- Produces: verification evidence and a review report separating pre-existing findings from introduced changes.

- [ ] **Step 1: Check the final diff and whitespace**

Run: `git diff --check`
Expected: exit 0.

- [ ] **Step 2: Run the full automated suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 3: Run the production build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Review requirements and regression risks**

Confirm default built-in exclusion, opt-in inclusion, same-name aggregation, preservation of all management actions, and no backend contract changes. Record any existing Skills-service defects separately instead of silently expanding the page refactor.
