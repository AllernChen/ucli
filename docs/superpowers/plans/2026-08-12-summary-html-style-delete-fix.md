# Summary HTML Style and Report Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HTML export failures truthful and actionable, let users choose an HTML style before export, and let users safely delete persisted summary versions.

**Architecture:** Keep AI HTML generation and validation in the main process. The renderer only submits a validated style object and displays safe typed errors. Add report deletion as one transactional persistence operation that rejects active jobs and promotes the newest remaining completed version when the current version is deleted.

**Tech Stack:** Electron IPC, Vue 3, Pinia, Ant Design Vue, sql.js, Node test runner.

## Global Constraints

- Never expose provider stderr, prompts, evidence, raw AI output, secrets, or filesystem credential paths to the renderer.
- AI-generated HTML must pass the existing parse5 structural, content-integrity, and resource-safety validation before any file write.
- A cancelled save dialog must not call the AI runner.
- Deleting a report must not delete sessions, usage events, source CLI history, or other report versions.
- `queued`, `running`, and `awaiting_confirmation` reports cannot be deleted.

---

### Task 1: Truthful HTML export errors

**Files:**
- Modify: `electron/orchestrator.js`
- Test: `test/summary-ipc.test.mjs`

**Interfaces:**
- Consumes: provider runner errors such as `SUMMARY_RUNNER_EXIT`, `SUMMARY_RUNNER_TIMEOUT`, and `SUMMARY_EXECUTOR_AUTH_UNAVAILABLE`.
- Produces: safe IPC errors with stable codes and bounded messages; unknown provider details are discarded.

- [ ] **Step 1: Write the failing IPC test**

Register `registerSummaryIpc` with a fake `exportHtml()` that throws `SUMMARY_RUNNER_EXIT`, invoke the registered `summary:export-html` handler, and assert the response is not `SUMMARY_SERVICE_UNAVAILABLE` and contains no raw provider text.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/summary-ipc.test.mjs`

Expected: the fake runner failure is incorrectly returned as `SUMMARY_SERVICE_UNAVAILABLE`.

- [ ] **Step 3: Add safe error classification**

Map known executor/profile/authentication failures to their existing safe messages. Map `SUMMARY_RUNNER_*` failures to `SUMMARY_HTML_GENERATION_FAILED` with the fixed message `AI CLI failed while generating HTML`. Do not copy `error.message`, stderr, or metadata.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/summary-ipc.test.mjs`

Expected: all tests pass and the raw fake provider message is absent.

### Task 2: HTML style selection workflow

**Files:**
- Modify: `src/components/summaries/WorkSummaryPanel.vue`
- Modify: `src/components/summaries/SummaryReportView.vue`
- Test: `test/summary-view.test.mjs`

**Interfaces:**
- Consumes: `export-html` event with a report ID.
- Produces: `{ mode: 'light' | 'dark' | 'custom', requirement?: string }` passed to `summaries.exportHtml()`.

- [ ] **Step 1: Write the failing component contract test**

Parse the summary SFCs and assert the UI contains the three style choices `浅色`, `深色`, `自定义`, a conditional custom requirement input, a cost disclosure, and a confirm-loading state.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/summary-view.test.mjs`

Expected: style selector and custom requirement bindings are absent.

- [ ] **Step 3: Implement the modal workflow**

Open a modal when `export-html` fires. Default to `light`; show a textarea only for `custom`; disable confirmation when the trimmed custom requirement is empty; submit the chosen style to the existing store action. Keep the modal open while exporting, show `正在生成 HTML`, and close only after success or cancellation.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/summary-view.test.mjs`

Expected: SFC parsing and style workflow assertions pass.

### Task 3: Transactional report deletion

**Files:**
- Modify: `electron/persistence/db.js`
- Modify: `electron/summaries/reportRepository.js`
- Modify: `electron/orchestrator.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Modify: `src/stores/summaries.js`
- Modify: `src/components/summaries/SummaryReportView.vue`
- Modify: `src/components/summaries/SummaryHistory.vue`
- Test: `test/usage-ledger-db.test.mjs`
- Test: `test/summary-job-service.test.mjs`
- Test: `test/summary-ipc.test.mjs`
- Test: `test/summary-view.test.mjs`

**Interfaces:**
- Produces persistence API `deleteSummaryReport(reportId): Promise<{ deletedReportId, currentReportId }>`.
- Produces repository API `delete(reportId)` with the same return shape.
- Produces IPC channel `summary:delete` and renderer method `deleteSummaryReport(reportId)`.

- [ ] **Step 1: Write the failing persistence test**

Create two completed versions for one logical period, make the newer version current, delete it, and assert the older completed version becomes current atomically. Assert active reports are rejected with `SUMMARY_REPORT_ACTIVE` and a missing ID with `SUMMARY_REPORT_NOT_FOUND`.

- [ ] **Step 2: Run the persistence test and verify RED**

Run: `node --test test/usage-ledger-db.test.mjs`

Expected: `deleteSummaryReport` is missing.

- [ ] **Step 3: Implement transactional deletion**

Inside `Db.transaction`, load the target, reject active statuses, delete only its `summary_reports` row, and when it was current set the highest-version remaining completed report for the same `(period_type, period_start, period_end_exclusive, timezone)` key current. Return IDs only.

- [ ] **Step 4: Add repository and IPC vertical tests, then implement the narrow channel**

Add `repository.delete(reportId)`, validate the ID through `validateSummaryId`, register `summary:delete`, expose it through preload and `src/ipc.js`, schedule a database flush, and whitelist `SUMMARY_REPORT_ACTIVE`.

- [ ] **Step 5: Add renderer deletion behavior**

Add a danger `删除总结` action behind `a-popconfirm`. On success, remove stale progress/job state, reload the report list, select `currentReportId` when returned, otherwise select the next report or clear the workspace.

- [ ] **Step 6: Run deletion and UI tests and verify GREEN**

Run: `node --test test/usage-ledger-db.test.mjs test/summary-job-service.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs`

Expected: all deletion, IPC, and UI tests pass.

### Task 4: Release verification and packaging

**Files:**
- Modify only if required by a failing verification: `docs/release-acceptance.md`, release tests, or packaging configuration.

- [ ] **Step 1: Run summary regression tests**

Run all `test/summary*.test.mjs` files and require zero failures.

- [ ] **Step 2: Run production build and full test suite**

Run: `npm run build` and `npm test`.

Expected: both exit 0.

- [ ] **Step 3: Review the diff**

Require an independent read-only review with no unresolved P1/P2, then run `git diff --check`.

- [ ] **Step 4: Commit and package**

Commit the scoped implementation, package a new x64 NSIS installer with a unique artifact name, calculate SHA-256, and report the exact installer path.
