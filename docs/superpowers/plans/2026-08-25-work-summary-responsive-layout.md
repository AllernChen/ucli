# Work Summary Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded fixed 7/17 work-summary layout with a compact, responsive task rail and flexible report detail while preserving every management action.

**Architecture:** `WorkSummaryPanel` owns a semantic CSS Grid shell, places task versions in a bounded rail, and moves selected-period history into the detail context. The task card collapses secondary operations behind one menu; `SummaryReportView` owns responsive metadata, wrapped actions and overflow-safe Markdown. Store and IPC contracts remain unchanged.

**Tech Stack:** Vue 3 SFC, Pinia, Ant Design Vue, CSS Grid/Flexbox, @vue/test-utils, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-work-summary-reliability-layout-design.md`

## Global Constraints

- Do not change summary IPC, database ownership, generation state, version semantics or delete behavior.
- Preserve edit, retry, conversation, delete, cancel, set-current, Markdown export and HTML export actions.
- Keep every destructive delete behind explicit confirmation.
- The task rail is 300–360px on desktop and becomes a bounded full-width region below 960px.
- Avoid adding a browser-test dependency; use mounted behavior tests plus real desktop/narrow-window visual acceptance.
- Preserve unrelated tracked and untracked user files.

---

### Task 1: Compact Task Card

**Files:**
- Modify: `src/components/summaries/SummaryReportListItem.vue`
- Modify: `test/summary-view-mounted.test.mjs:135-220`

**Interfaces:**
- Consumes: the existing report, progress, selected, deleting and deleteReport props.
- Produces: existing `select`, `edit`, `retry`, `open-conversation` events and confirmed deletion through `deleteReport`/`delete-report`.

- [ ] **Step 1: Write a failing real-component behavior test**

Mount the real task card with a failed report. Assert that title/status/version/time are visible, title and note have dedicated clamp elements, retry remains directly available, secondary actions are absent until “更多操作” is triggered, and choosing edit/conversation/delete preserves the existing emitted payloads and delete confirmation.

Name the break explicitly: removing the compact action boundary or bypassing delete confirmation must fail the test.

- [ ] **Step 2: Run the mounted test and verify RED**

```powershell
node --test test/summary-view-mounted.test.mjs
```

Expected: fail because the current card renders every action directly and has no clamp/menu structure.

- [ ] **Step 3: Implement the compact card**

Use semantic containers and an Ant dropdown menu:

```vue
<a-list-item class="summary-task-card" :class="{ 'is-selected': selected }" @click="emit('select', report.id)">
  <div class="summary-task-card__body">
    <div class="summary-task-card__title-row">
      <span class="summary-task-card__title">{{ report.title }}</span>
      <a-tag>v{{ report.version }}</a-tag>
    </div>
    <div class="summary-task-card__meta">
      <a-tag :color="status.color">{{ status.label }}</a-tag>
      <span>{{ report.executorId || '—' }} · {{ createdAt }}</span>
    </div>
    <div v-if="report.taskNote" class="summary-task-card__note">{{ report.taskNote }}</div>
    <div class="summary-task-card__actions">
      <a-button v-if="retryable" size="small" @click.stop="emit('retry', report)">重试</a-button>
      <a-dropdown :trigger="['click']">
        <template #overlay>
          <a-menu @click="handleMenuClick">
            <a-menu-item key="edit">编辑任务</a-menu-item>
            <a-menu-item key="conversation">查看关联对话</a-menu-item>
            <a-menu-divider />
            <a-menu-item key="delete" danger>删除任务</a-menu-item>
          </a-menu>
        </template>
        <a-button size="small" aria-label="更多操作" @click.stop>更多</a-button>
      </a-dropdown>
    </div>
  </div>
</a-list-item>
<a-modal
  :open="deleteConfirmOpen"
  :title="deleteTitle"
  ok-text="确认删除"
  cancel-text="取消"
  :confirm-loading="deleting"
  @ok="confirmDelete"
  @cancel="deleteConfirmOpen = false"
/>
```

The dropdown exposes edit and conversation immediately. Selecting delete opens a local controlled confirmation modal; `confirmDelete()` awaits the existing delete callback and closes only after it settles. Add two-line clamps with `-webkit-line-clamp: 2`, `min-width: 0`, and selected/hover/focus-visible states.

- [ ] **Step 4: Run mounted tests and verify GREEN**

```powershell
node --test test/summary-view-mounted.test.mjs test/summary-view.test.mjs
```

Expected: compact interactions and all existing management behavior pass.

- [ ] **Step 5: Commit the compact card**

```powershell
git add src/components/summaries/SummaryReportListItem.vue test/summary-view-mounted.test.mjs test/summary-view.test.mjs
git commit -m "refactor: compact work summary task cards"
```

---

### Task 2: Responsive Master-Detail Shell

**Files:**
- Modify: `src/components/summaries/WorkSummaryPanel.vue:1-37,172-175`
- Modify: `src/components/summaries/SummaryHistory.vue`
- Modify: `test/summary-view-mounted.test.mjs:333-470`

**Interfaces:**
- Consumes: existing summaries store reports, versions, selected report and progress.
- Produces: `.summary-workspace`, `.summary-task-rail`, `.summary-detail`, and `.summary-detail__history` regions; no store/API changes.

- [ ] **Step 1: Write a failing panel structure test**

Mount the real panel with task, history and report-view stubs that expose their slot location. Assert one task rail and one detail region exist, the report list is inside the rail, and both report view and version history are inside the detail. Assert the history stub is not a descendant of the rail.

- [ ] **Step 2: Run the panel test and verify RED**

```powershell
node --test test/summary-view-mounted.test.mjs
```

Expected: fail because the current `a-row` places version history in the left column and has no semantic shell regions.

- [ ] **Step 3: Replace the fixed Ant grid**

Use this structural boundary:

```vue
<section class="work-summary-panel">
  <header class="work-summary-header">
    <div>
      <h2>工作总结</h2>
      <p>按周期生成、管理和导出规范工作总结。</p>
    </div>
    <div class="work-summary-header__actions">
      <a-button @click="refresh">刷新</a-button>
      <a-button type="primary" @click="dialogOpen = true">生成总结</a-button>
    </div>
  </header>
  <a-alert
    v-if="summaries.error"
    type="error"
    show-icon
    message="无法完成总结操作，请稍后重试。"
  />
  <a-spin :spinning="summaries.loading">
    <div class="summary-workspace">
      <aside class="summary-task-rail" aria-label="总结任务列表">
        <a-list :data-source="summaries.reports" row-key="id">
          <template #renderItem="{ item }">
            <SummaryReportListItem
              :report="item"
              :progress="summaries.progress[item.id] || null"
              :selected="item.id === summaries.selectedReportId"
              :deleting="deletingReportIds.has(item.id)"
              :delete-report="remove"
              @select="select"
              @edit="openEdit"
              @retry="retry"
              @open-conversation="openConversation"
            />
          </template>
        </a-list>
      </aside>
      <main class="summary-detail">
        <SummaryReportView
          :report="summaries.selectedReport"
          :progress="selectedProgress"
          :html-exporting="htmlExporting"
          :deleting="deletingReportIds.has(summaries.selectedReportId)"
          :delete-report="remove"
          @cancel="cancel"
          @edit="openEdit"
          @export-markdown="exportMarkdown"
          @export-html="openHtmlExport"
          @open-conversation="openConversation"
        />
        <SummaryHistory
          class="summary-detail__history"
          :versions="summaries.versions"
          :progress="summaries.progress"
          @select="select"
          @retry="retry"
          @set-current="setCurrent"
        />
      </main>
    </div>
  </a-spin>
</section>
```

Add desktop and narrow-window CSS:

```css
.summary-workspace {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.summary-task-rail { min-width: 0; max-height: calc(100vh - 220px); overflow: auto; }
.summary-detail { min-width: 0; display: grid; gap: 14px; }
@media (max-width: 959px) {
  .summary-workspace { grid-template-columns: minmax(0, 1fr); }
  .summary-task-rail { max-height: 360px; }
}
```

Simplify `SummaryHistory` to version selection/status/current/retry actions; edit and delete remain available from the selected detail and task card, so history no longer repeats the full management toolbar.

- [ ] **Step 4: Run panel and store tests and verify GREEN**

```powershell
node --test test/summary-view-mounted.test.mjs test/summary-view.test.mjs test/summary-task-contracts.test.mjs
```

Expected: task selection, versions, retry and current-version promotion still work with the new placement.

- [ ] **Step 5: Commit the master-detail shell**

```powershell
git add src/components/summaries/WorkSummaryPanel.vue src/components/summaries/SummaryHistory.vue test/summary-view-mounted.test.mjs test/summary-view.test.mjs
git commit -m "refactor: organize work summaries as master detail"
```

---

### Task 3: Responsive Report Detail

**Files:**
- Modify: `src/components/summaries/SummaryReportView.vue:1-62,74-121`
- Modify: `test/summary-view-mounted.test.mjs`
- Modify: `test/summary-view.test.mjs`

**Interfaces:**
- Consumes: existing report/progress/export/deleting props and emits.
- Produces: responsive descriptions, grouped/wrapped actions and overflow-safe Markdown.

- [ ] **Step 1: Write failing detail behavior tests**

Mount the real report view with a completed report containing a wide Markdown table. Assert the metadata component receives the responsive column object `{ xs: 1, sm: 1, md: 2, lg: 2, xl: 3, xxl: 3 }`, actions are split into primary/export/danger groups inside a wrapping toolbar, and the rendered table is contained by an overflow boundary. Keep existing export-disable and delete-confirmation assertions.

- [ ] **Step 2: Run the detail tests and verify RED**

```powershell
node --test test/summary-view-mounted.test.mjs test/summary-view.test.mjs
```

Expected: fail because descriptions use fixed `column=3`, actions are one unwrapped row, and tables have no horizontal containment.

- [ ] **Step 3: Implement responsive detail structure**

Set descriptions to:

```vue
<a-descriptions
  size="small"
  :column="{ xs: 1, sm: 1, md: 2, lg: 2, xl: 3, xxl: 3 }"
  bordered
>
```

Group actions in `.summary-detail-actions` with `display:flex`, `flex-wrap:wrap`, and logical subgroups. Wrap the article in `.summary-markdown-shell`; set `min-width:0`, and render tables with `display:block; width:max-content; min-width:100%; max-width:100%; overflow-x:auto`. Preserve DOMPurify and link handling unchanged.

- [ ] **Step 4: Run all summary view tests and verify GREEN**

```powershell
node --test test/summary-view-mounted.test.mjs test/summary-view.test.mjs test/summary-export.test.mjs test/summary-theme-renderer.test.mjs
```

Expected: all detail, export, sanitization and theme behaviors pass.

- [ ] **Step 5: Commit responsive detail**

```powershell
git add src/components/summaries/SummaryReportView.vue test/summary-view-mounted.test.mjs test/summary-view.test.mjs
git commit -m "refactor: make work summary detail responsive"
```

---

### Task 4: Layout Verification and Release Acceptance

**Files:**
- Modify only after all evidence passes: `docs/qa/2026-08-24-work-summary-closure-acceptance.md`

**Interfaces:**
- Consumes: completed reliability and layout changes.
- Produces: final automated, visual, real-model and installed-app evidence.

- [ ] **Step 1: Run focused tests**

```powershell
node --test test/summary-markdown-canonicalizer.test.mjs test/interactive-summary-artifact.test.mjs test/interactive-summary-job-service.test.mjs test/summary-task-contracts.test.mjs test/summary-view-mounted.test.mjs test/summary-view.test.mjs test/summary-export.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run full automated gates**

```powershell
npm test
npm run build
npm run verify:release
git diff --check
```

Expected: zero test failures, successful main/preload/renderer build, verified v0.11.6 artifacts and no whitespace errors.

- [ ] **Step 3: Perform desktop and narrow-window visual acceptance**

Open the development work-summary page with existing real data. At approximately 1280px width, verify a 300–360px independently scrollable task rail, flexible detail, compact task operations and version history under the detail. At approximately 820px width, verify one-column stacking, bounded task height, wrapped actions, one/two-column metadata as applicable, and horizontally contained tables. Capture screenshots without recording prompts, transcripts or local paths.

- [ ] **Step 4: Perform real Claude and installed-app acceptance**

Generate one weekly report with Claude and require a completed canonical report without refresh. Only after that passes, open Setup and Portable builds and verify list loading, edit/delete, preview and Markdown/HTML export.

- [ ] **Step 5: Record evidence and commit closure only if every gate passes**

Update the QA document with timestamps, safe report IDs, terminal statuses and artifact filenames. If any real or installed check fails, keep the release blocked and return to diagnosis. If all pass:

```powershell
git add docs/qa/2026-08-24-work-summary-closure-acceptance.md
git commit -m "test: close work summary reliability and layout acceptance"
```
