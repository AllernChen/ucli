# Task 2 Report: Fix history replay race condition

**Status:** DONE_WITH_CONCERNS

## Changes

Modified 4 files per the task brief:

1. **`electron/orchestrator.js`** — Replaced the `session:create` handler so it only creates the session entry and returns `{sessionId}` immediately (no longer kicks off `adapter.start()`). Added a new `session:start-adapter` IPC handler that the renderer calls after it is ready; it schedules `hookReady.then(() => e.adapter.start())` and assigns `hookPort`.

2. **`electron/preload.js`** — Added `startAdapter: (sessionId) => ipcRenderer.invoke('session:start-adapter', sessionId)` after the `createSession` bridge.

3. **`src/ipc.js`** — Added `startAdapter: (sessionId) => u.startAdapter(sessionId)` after the `createSession` wrapper.

4. **`src/stores/sessions.js`** — In `createSession`, after `this.pendingApprovals[sessionId] = []`, added a fire-and-forget `ipc.startAdapter(sessionId)` call before `return sessionId`.

## Build

`npm run build` — PASS. All three targets (main, preload, renderer) compiled with no errors. Main 70.22 kB, preload 2.83 kB, renderer 4,319.09 kB.

## Commit

`77969d6` on branch `fix/code-review-fixes`:
> fix: defer adapter.start() until renderer subscribes to terminal-output

## Concerns

1. **Residual race on terminal-output listener.** The fix correctly resolves the original race (microtask firing before the IPC response carrying `{sessionId}` reached the renderer). However, `ipc.startAdapter(sessionId)` is called fire-and-forget from the store's `createSession`, which runs in the Workbench view *before* `router.push('/session/:id')`. The `session:terminal-output` listener is registered later, inside `SessionDetail.vue` `onMounted` (after `await store.init()` + `await nextTick()` + `initTerminal()`). Since `hookReady` is almost certainly already resolved by the time a session is created, the `hookReady.then(cb)` microtask in main fires promptly: `adapter.start()` → `_replayHistory()` (synchronous) → `webContents.send('session:terminal-output', ...)` emits the replayed history before SessionDetail mounts and registers its listener. The replayed chunks may still be dropped. The original "microtask before IPC response" race is fixed, but a "replay before listener registered" race appears to remain. Manual verification (Step 6) is needed to confirm whether timing in practice allows the listener to win; if not, a follow-up (e.g., buffer terminal output in main until a renderer attaches, or have SessionDetail call `startAdapter` from `onMounted` after registering the listener) may be required.

2. **Manual verification (Step 6) not performed.** This is a GUI Electron app; interactive `npm run dev` testing (creating a session in a directory with history and observing the terminal) could not be exercised in this context.
