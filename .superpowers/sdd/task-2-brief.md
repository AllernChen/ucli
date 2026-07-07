# Task 2: Fix history replay race condition

**Files:**
- Modify: `electron/orchestrator.js` — `session:create` IPC handler (~line 388)
- Modify: `electron/preload.js` — add `startAdapter` bridge
- Modify: `src/ipc.js` — add `startAdapter` wrapper
- Modify: `src/stores/sessions.js` — call `startAdapter` after creating summary

**Problem:** `hookReady.then(() => adapter.start())` runs as a microtask BEFORE the IPC response carrying `{sessionId}` returns to the renderer. `start()` calls `_replayHistory()` synchronously, emitting `session:terminal-output` events. But the renderer hasn't received `{sessionId}` yet, hasn't created the xterm.js terminal, hasn't registered the `session:terminal-output` listener. The replayed history is silently dropped.

## Fix

Split `session:create` into two steps:
1. `session:create` — creates the session entry, returns `{sessionId}` (renderer creates terminal + registers listener)
2. `session:start-adapter` — renderer calls this AFTER it's ready, then adapter starts

## Steps

### Step 1: Modify session:create handler in orchestrator.js

Find the `session:create` IPC handler (~line 388) and replace it:

```js
ipcMain.handle('session:create', (_e, config) => {
  const { sessionId } = createSession(config)
  return { sessionId }
})

// Renderer calls this after it has registered the terminal-output listener
ipcMain.handle('session:start-adapter', (_e, sessionId) => {
  const e = sessions.get(sessionId)
  if (!e || !e.adapter) return false
  hookReady.then(() => {
    e.adapter.hookPort = hookPort
    return e.adapter.start()
  })
  return true
})
```

### Step 2: Add startAdapter to preload.js

In `electron/preload.js`, after the `createSession` line, add:

```js
startAdapter: (sessionId) => ipcRenderer.invoke('session:start-adapter', sessionId),
```

### Step 3: Add startAdapter to ipc.js

In `src/ipc.js`, after the `createSession` line, add:

```js
startAdapter: (sessionId) => u.startAdapter(sessionId),
```

### Step 4: Call startAdapter from store after creating summary

In `src/stores/sessions.js`, in the `createSession` action, after `this.pendingApprovals[sessionId] = []`, add:

```js
// Start the adapter AFTER the store is ready — the renderer's
// terminal-output listener (registered in SessionDetail onMounted)
// will catch the replayed history.
ipc.startAdapter(sessionId)
return sessionId
```

### Step 5: Build verification

Run: `npm run build`
Expected: compiles with no errors

### Step 6: Manual verification

Run: `npm run dev`
1. New session, pick a directory with history
2. Enter detail page
3. Expected: terminal shows "━━━ 历史记录 ━━━" and prior conversation

### Step 7: Commit

```bash
git add electron/orchestrator.js electron/preload.js src/ipc.js src/stores/sessions.js
git commit -m "fix: defer adapter.start() until renderer subscribes to terminal-output

Fixes #2: history replay events were emitted before the renderer
registered its session:terminal-output listener, so the replayed
transcript was silently dropped on session creation."
```
