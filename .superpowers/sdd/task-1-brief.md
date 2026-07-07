# Task 1: Fix resume() _disposed + _statsTimer leak

**Files:**
- Modify: `electron/adapters/claudeAdapter.js` — `start()` method (~line 247) and `dispose()` method (~line 335)

**Problem:** `dispose()` sets `this._disposed = true`, but `start()` never resets it to `false`. `resume()` calls `dispose()` then `start()`, so `emitEvent` (in `cliAdapter.js`, checks `if (this._disposed) return`) silently drops every event. The resumed session is a black hole — no terminal output, no ready event, nothing. Additionally, `dispose()` does not clear `this._statsTimer`, leaving a 2-second timer that fires after disposal.

## Steps

### Step 1: In start(), reset _disposed at the very first line

```js
async start() {
  this._disposed = false
  if (!pty) {
    // ... existing code
```

### Step 2: In dispose(), clear _statsTimer after setting _disposed

```js
async dispose() {
  this._disposed = true
  if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null }
  if (this.ptyProc) {
    // ... existing code
```

### Step 3: Build verification

Run: `npm run build`
Expected: compiles with no errors

### Step 4: Manual verification (resume works)

Run: `npm run dev`
1. Create a Claude session, send one message
2. Click "停止" → session goes offline
3. Click "重新启动"
4. Expected: terminal shows history + claude resumes, can type

### Step 5: Commit

```bash
git add electron/adapters/claudeAdapter.js
git commit -m "fix: reset _disposed in start() and clear _statsTimer in dispose()

Fixes #1 and #4 from code review: resume() left _disposed=true causing
all events to be silently dropped; _statsTimer was not cleared on dispose
causing a resource leak and potential stale stats."
```
