# Task 1 Report: Fix resume() _disposed + _statsTimer leak

## What I implemented

Two minimal, surgical edits to `electron/adapters/claudeAdapter.js`:

1. **`start()` — reset `_disposed` at the very first line.** Added `this._disposed = false` before the `if (!pty)` guard (line 248). This is the root-cause fix: `BaseAdapter.emitEvent` (in `cliAdapter.js`) early-returns when `this._disposed` is true, so the previous flow (`resume()` → `await this.dispose()` sets it true → `await this.start()` never reset it) silently dropped every event from the resumed session — terminal output, `ready`, `exit`, `stats_update`, all of it. Resetting at the very top of `start()` guarantees the flag is clear before any subsequent code path (including the `if (!pty)` early return and `_replayHistory()`) can emit.

2. **`dispose()` — clear `_statsTimer` after setting `_disposed`.** Added `if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null }` immediately after `this._disposed = true` (line 338). `_scheduleStatsUpdate()` arms a 2-second `setTimeout` that calls `_extractStats()`; without clearing it on dispose, the timer could fire after the adapter is torn down, attempting to read the transcript and emit a `stats_update` event on a disposed session. Clearing the timer also nulls the field so the next `start()` begins from a clean state.

## Build result

`npm run build` — PASS. All three electron-vite targets compiled with no errors:
- `out/main/index.js` (70.12 kB) — built in 270ms
- `out/preload/index.js` (2.74 kB) — built in 11ms
- `out/renderer/assets/index-U0jkJA0u.js` (4,318.99 kB) + `index-Dscr0C9q.css` (19.90 kB) — built in 9.87s

## Files changed

- `electron/adapters/claudeAdapter.js` — 2 insertions:
  - line 248: `this._disposed = false` (first line of `start()`)
  - line 338: `if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null }` (first line of body in `dispose()`, after `this._disposed = true`)

## Self-review findings

- **Placement of `_disposed = false`**: Put at the absolute first line of `start()`, before the `if (!pty)` early-return branch. This is deliberate — even the error path (`this._write(...)` + `emitEvent({ type: 'error' ... })`) needs the flag clear so those events aren't dropped. Putting it after the guard would leave the no-pty error path still dropping events after a resume.
- **No double-clear risk**: `_scheduleStatsUpdate()` already does `if (this._statsTimer) clearTimeout(this._statsTimer)` before arming a new timer, so nulling the field in `dispose()` is consistent with how the field is managed elsewhere — the next `start()` → `_write()` → `_scheduleStatsUpdate()` will simply arm a fresh timer.
- **`super.dispose()` still called last**: Order preserved — `_disposed` set first, then timer cleared, then PTY killed, then settings dir removed, then `super.dispose()` (which handles engine/listener teardown). No change to that ordering.
- **Scope**: Edit is strictly additive (2 lines) and confined to the two methods named in the brief. No behavioral change to `resume()`, `writeInput()`, or any other path.
- **Manual verification (Step 4 in brief) not run**: The brief lists a manual `npm run dev` resume-flow check as Step 4, but that requires an interactive Electron GUI session with a working `claude` CLI on PATH and cannot be driven headlessly from this task. The build (Step 3) passes; the logic change is minimal and the `_disposed` reset is verifiable by inspection against `BaseAdapter.emitEvent`'s guard.
