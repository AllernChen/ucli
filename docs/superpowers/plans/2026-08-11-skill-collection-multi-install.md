# Skill Collection Multi-Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to select multiple or all valid Skills discovered in one Git repository and install them to the same CLI targets and scope in one confirmed workflow.

**Architecture:** Keep the existing single-Skill installation implementation as the mutation primitive, exposed to collections through a narrowly validated `skills:install-many` IPC. Enrich collection inspection items with the same preflight metadata as a single Skill, derive deterministic selection state in `skillsPresentation.js`, use a separate `expectedRevision` to pin every selected item to the previewed commit without replacing its logical branch/tag/default source, reuse one repository checkout, and return explicit per-item results before one final state refresh.

**Tech Stack:** Electron, Vue 3, Pinia, Ant Design Vue, Node.js test runner, SQLite-backed existing Skills service.

## Global Constraints

- Release version is `0.9.6`.
- A collection can select multiple Skills and has a one-click “select all / clear all” control.
- Invalid collection candidates are never selectable.
- Every selected Skill must pass existing compatibility and conflict preflight before confirmation is enabled.
- Duplicate selected Skill names are blocked before mutation.
- Batch mutation is sequential within one pinned repository checkout, reports every success/failure, and refreshes Skills state once after the batch.
- A persistence-pending result returns confirmed successes plus an uncertain item and skipped items, then stops the batch immediately; it is never reported as an ordinary retryable failure.
- The bounded `skills:install-many` IPC accepts at most 200 validated requests; repository credentials and error sanitization continue through existing IPC contracts.

---

### Task 1: Collection-wide preflight contract

**Files:**
- Modify: `electron/skills/sourceLoader.js`
- Modify: `electron/skills/service.js`
- Test: `test/skills-source-loader.test.mjs`
- Test: `test/skills-service.test.mjs`

**Interfaces:**
- Consumes: `sourceLoader.inspect(source)` collection preview and existing `installedMatches` / `inspectTargetMatches` service helpers.
- Produces: each `collection.skills[]` item as a complete `kind: 'skill'` preview with `manifest`, `contentSha256`, `source.subdir`, `installedMatches`, and `targetMatches`.

- [x] **Step 1: Write failing loader and service tests**

Assert literal collection item metadata and assert two candidates receive independent target/preflight matches from one collection inspection.

- [x] **Step 2: Run tests to verify RED**

Run: `node --test test/skills-source-loader.test.mjs test/skills-service.test.mjs`

Expected: FAIL because collection candidates do not yet expose complete single-Skill preview metadata.

- [x] **Step 3: Implement collection candidate enrichment**

Add manifest/hash/source metadata in the loader and map each valid candidate through existing service preflight helpers without changing local, ZIP, or root-Skill behavior.

- [x] **Step 4: Run tests to verify GREEN**

Run: `node --test test/skills-source-loader.test.mjs test/skills-service.test.mjs`

Expected: PASS.

### Task 2: Deterministic multi-selection and pinned batch mutation

**Files:**
- Modify: `src/skillsPresentation.js`
- Modify: `src/stores/skills.js`
- Modify: `electron/skills/sourceLoader.js`
- Modify: `electron/skills/service.js`
- Modify: `electron/skills/ipc.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Test: `test/skills-presentation.test.mjs`
- Test: `test/skills-store.test.mjs`

**Interfaces:**
- Produces: `resolveSkillCollectionInstallSelection(options)` returning selected items, blocked items, `allSelected`, and `canInstall`.
- Produces: `buildSkillCollectionInstallRequests(options)` returning ordered existing single-install request payloads.
- Produces: `skills.installMany(requests)` returning `{ installed, failed, refreshError? }` after one final `load()`.

- [x] **Step 1: Write failing selection and store tests**

Cover no selection, partial selection, all selection, conflict/incompatible candidate, case-insensitive duplicate names, stable request order, pinned revision with preserved logical branch/default source, one Git checkout, success/failure collection, persistence-pending abort, shared batch context, and one final state refresh.

- [x] **Step 2: Run tests to verify RED**

Run: `node --test test/skills-presentation.test.mjs test/skills-store.test.mjs`

Expected: FAIL because the batch helpers and store action do not exist.

- [x] **Step 3: Implement minimal helpers and store action**

Reuse `canConfirmSkillInstall` for every selected candidate, preserve collection order, pin requests to the inspected revision, call the bounded batch IPC, reuse one checkout while retaining the existing per-Skill mutation logic, sanitize failure metadata to code/message, and call `load()` once without discarding results if refresh fails.

- [x] **Step 4: Run tests to verify GREEN**

Run: `node --test test/skills-presentation.test.mjs test/skills-store.test.mjs`

Expected: PASS.

### Task 3: Multi-select and select-all UI, release verification

**Files:**
- Modify: `src/views/SkillsCenter.vue`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `test/app-version.test.mjs`
- Modify: `test/release-verification.test.mjs`
- Test: `test/skills-presentation.test.mjs`

**Interfaces:**
- Consumes: collection selection state, batch request builder, and `skills.installMany()`.
- Produces: Ant Design Vue multi-select with `selectedSubdirs`, select-all/clear-all control, selected count, blocked summary, batch progress, and aggregate completion message.

- [x] **Step 1: Write failing UI and version tests**

Assert multi-select mode, select-all handler, batch install handler, disabled confirmation for blocked selections, and literal `0.9.6` release metadata.

- [x] **Step 2: Run tests to verify RED**

Run: `node --test test/skills-presentation.test.mjs test/app-version.test.mjs test/release-verification.test.mjs`

Expected: FAIL because the page is single-select and package version is `0.9.5`.

- [x] **Step 3: Implement UI and release metadata**

Keep the collection preview visible after selection, install all selected subdirectories via ordered requests, retain the drawer when failures occur, and prompt restart once for successful affected installations.

- [x] **Step 4: Run focused and full verification**

Run: `node --test test/skills-presentation.test.mjs test/app-version.test.mjs test/release-verification.test.mjs`

Run: `npm test`

Run: `npm run build`

Expected: all tests and production build pass.

- [x] **Step 5: Review and commit**

Review the full diff for collection safety, sequential failure reporting, and unrelated working-tree preservation; then commit only the listed implementation, test, version, changelog, and plan files.
