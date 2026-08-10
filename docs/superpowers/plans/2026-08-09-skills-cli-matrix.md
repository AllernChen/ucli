# Skills × AI CLI Unified Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Skills page into a local Skill control plane that shows every user Skill once, makes its usage across supported AI CLIs immediately visible, and can apply a managed Skill to another CLI safely.

**Architecture:** Keep the existing canonical-package and projection model. Add one service command that creates a direct projection for an existing package at a chosen CLI without overwriting conflicting files, expose it through IPC/store, and add a pure presentation model for a `Skill × CLI` matrix. Source-project grouping remains secondary navigation around the catalog.

**Tech Stack:** Electron 32, Vue 3, Pinia, Ant Design Vue 4, Node.js ESM test runner, electron-vite.

## Global Constraints

- A Skill is the primary row/card; Claude Code, Codex, OpenCode, and U-Code are the matrix columns.
- Each CLI state distinguishes direct managed deployment, indirect compatibility visibility, external discovery, disabled deployment, and unavailable.
- “应用” creates a direct projection for the selected CLI in the Skill's existing user/project scope.
- Existing target content is never overwritten. Identical unmanaged content may be adopted as the new projection; different content is a conflict.
- External Skills must be adopted before UCLI can apply them elsewhere.
- Existing source-project grouping, update, drift, enable/disable, remove, scope filtering, and restart behavior remain available.
- Every behavior change follows red-green-refactor and must pass the full test suite and production build.

---

### Task 1: Safe apply-to-CLI service

**Files:**
- Modify: `test/skills-service.test.mjs`
- Modify: `electron/skills/service.js`

**Interface:** `service.applyToAdapter(packageId, targetAdapterId)` returns the updated package view.

- [x] **Step 1: Write failing service tests**
  - Applying a project-scoped Codex Skill to Claude creates the Claude projection and preserves the Codex projection.
  - Applying into identical unmanaged content adopts that location.
  - Applying into different content rejects with `SKILL_TARGET_CONFLICT` and changes neither files nor database.

- [x] **Step 2: Run `node --test test/skills-service.test.mjs` and confirm RED**

- [x] **Step 3: Implement the smallest safe projection operation**
  - Validate package, adapter, scope, compatibility, canonical integrity, and duplicate direct installation.
  - Resolve the target from the package's existing scope.
  - Copy atomically when absent; register identical content when present; reject different content.
  - Roll back newly copied content if persistence fails.

- [x] **Step 4: Run `node --test test/skills-service.test.mjs` and confirm GREEN**

### Task 2: IPC and renderer command surface

**Files:**
- Modify: `test/skills-ipc.test.mjs`
- Modify: `test/skills-renderer-ipc.test.mjs`
- Modify: `electron/skills/ipc.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Modify: `src/stores/skills.js`

**Interface:** `skills:apply-to-adapter` with `{ packageId, targetAdapterId }`; store action `applyToAdapter(packageId, targetAdapterId)`.

- [x] **Step 1: Add failing contract and validation tests**
- [x] **Step 2: Run the two IPC test files and confirm RED**
- [x] **Step 3: Add validated main/preload/renderer/store forwarding**
- [x] **Step 4: Run the two IPC test files and confirm GREEN**

### Task 3: Skill × CLI presentation model

**Files:**
- Modify: `test/skills-presentation.test.mjs`
- Modify: `src/skillsPresentation.js`

**Interface:** `buildSkillCliMatrix(entry, adapters)` returns ordered CLI cells with state, direct installation/source, visibility origin, and actionability.

- [x] **Step 1: Write failing pure-model tests for direct, inherited, external, disabled, and unavailable states**
- [x] **Step 2: Run `node --test test/skills-presentation.test.mjs` and confirm RED**
- [x] **Step 3: Implement the minimal deterministic matrix builder**
- [x] **Step 4: Run the presentation tests and confirm GREEN**

### Task 4: Unified actionable Skills page

**Files:**
- Modify: `src/views/SkillsCenter.vue`

- [x] **Step 1: Render a four-column CLI matrix on every Skill card**
- [x] **Step 2: Show clear labels for 已应用 / 可用（继承） / 已发现 / 已停用 / 未应用**
- [x] **Step 3: Wire 应用 / 直接应用 to the new store action and keep existing location controls**
- [x] **Step 4: Preserve source-project links and filters as secondary context**
- [x] **Step 5: Run focused tests and `npm run build`**

### Task 5: Verification and review

- [x] **Step 1: Run `npm test`**
- [x] **Step 2: Run `npm run build`**
- [x] **Step 3: Run `git diff --check` and inspect the scoped diff**
- [x] **Step 4: Review acceptance criteria and report any remaining limitations**
