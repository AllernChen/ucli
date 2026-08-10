# UCLI Session Maintenance Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move routine session lifecycle actions out of the settings modal and into each populated session pane while making the difference between interrupting a turn and stopping the CLI process explicit.

**Architecture:** Add a renderer-only maintenance presentation contract and a compact pane action menu. The menu calls the existing session store operations, owns pending-action protection and destructive confirmation, while `SessionDetail` continues to own the layout-only close-pane operation. No IPC, database, or persisted state changes are required.

**Tech Stack:** Electron, Vue 3 `<script setup>`, Pinia, Ant Design Vue, Node test runner, Vue SFC compiler tests.

## Global Constraints

- `中断当前任务` sends the adapter interrupt signal and keeps the CLI process/session alive.
- `停止进程` disposes the CLI/PTY and changes the session to offline; it is not an alias for interrupt.
- `重启会话` may stop an active process before starting it again.
- `关闭窗格` changes only the workbench layout and never stops or removes the session.
- `移除 UCLI 记录` remains destructive only to the UCLI record and retains native CLI history and usage statistics.
- All five actions are reachable from a populated session pane; none appear in the settings modal.
- Keep the pane header compact by grouping interrupt, stop, restart, and remove under one `会话操作` menu; keep `关闭窗格` as a separate direct action.
- Disable actions that do not apply to the current status and prevent concurrent lifecycle requests.
- Do not change SQLite, IPC, preload, adapter, or persisted session contracts.

---

### Task 1: Define Maintenance Action Availability

**Files:**
- Create: `src/sessionMaintenancePresentation.js`
- Create: `test/session-maintenance-presentation.test.mjs`

**Interfaces:**
- Produces `deriveSessionMaintenanceState(session)` with `canInterrupt`, `canStop`, `canRestart`, and `canRemove` booleans.

- [x] Write literal tests for running, starting, offline, exited, error, and unavailable sessions.
- [x] Run the test and verify it fails because the module is missing.
- [x] Implement the minimal status-to-action derivation.
- [x] Run the test and verify it passes.

### Task 2: Build the Compact Pane Maintenance Menu

**Files:**
- Create: `src/components/SessionMaintenanceActions.vue`
- Modify: `test/session-config-template.test.mjs`

**Interfaces:**
- Props: `sessionId: String`.
- Emits: `removed(sessionId)`.
- Calls: `sessions.interrupt`, `sessions.stop`, `sessions.restart`, and `sessions.deleteSession`.

- [x] Add a failing template contract requiring one `会话操作` menu with the four lifecycle actions, pending-action protection, clear interrupt/stop help text, and removal confirmation.
- [x] Run the template test and verify the missing component fails.
- [x] Implement the menu and its lifecycle handlers with visible success/error feedback.
- [x] Run presentation and template tests and verify they pass.

### Task 3: Integrate the Menu and Remove Maintenance from Settings

**Files:**
- Modify: `src/views/SessionDetail.vue`
- Modify: `src/components/SessionConfigModal.vue`
- Modify: `src/sessionConfigPresentation.js`
- Modify: `test/session-config-presentation.test.mjs`
- Modify: `test/session-config-template.test.mjs`

**Interfaces:**
- `SessionDetail` hosts one maintenance menu per populated pane and compacts panes after `removed`.
- `SessionConfigModal` retains information, runtime configuration, Gateway relay, diagnostics, and profile-triggered restart decisions, but no general maintenance section.

- [x] Add failing assertions that the pane contains the maintenance menu and close-pane action, while the settings modal contains no interrupt, stop, general restart, or remove controls.
- [x] Run the focused tests and verify the old maintenance section causes failure.
- [x] Integrate `SessionMaintenanceActions`, remove the old interrupt handler and maintenance section, and keep profile-change restart behavior intact.
- [x] Run focused tests, the full suite, and the production build.
- [x] Commit the implementation without changing the already prepared `0.9.1` version.

## Acceptance Matrix

| Session status | Interrupt current task | Stop process | Restart session | Close pane | Remove record |
| --- | --- | --- | --- | --- | --- |
| running / idle / waiting | enabled | enabled | enabled | enabled | enabled |
| starting | disabled | enabled | enabled | enabled | enabled |
| offline / exited / error | disabled | disabled | enabled when `canStart !== false` | enabled | enabled |

The implementation is accepted when interrupt leaves the CLI process available, stop makes the session offline, restart restores it, close changes only pane assignment, remove clears the UCLI record after confirmation, and settings contains no routine maintenance block.
