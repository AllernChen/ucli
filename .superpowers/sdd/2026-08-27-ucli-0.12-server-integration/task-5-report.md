# Task 5 report — Connection refresh, recovery, and expiry reminders

## Delivered

- Extended the existing Task 4 `ConnectionManager` with in-memory access tokens, refresh/Bootstrap recovery, per-connection single flights, retry backoff, sanitized monotonic runtime state, lifecycle-error mapping, and shutdown fencing.
- Added durable refresh-token persistence-pending recovery. A rotated token is never replaced with its predecessor; recovery retries only the safe flush, then uses the same still-valid access token for Bootstrap.
- Added server-clock-adjusted authorization reminders at 7/3/1/0 days, persistent crossed-threshold state, extension rebuilds, permanent-authorization clearing, and lifecycle-owned timers.
- Persisted refreshed/Bootstrap authorization metadata and reminder state; startup recovery is asynchronous so offline server recovery cannot block local application startup.
- Wired foreground, system-resume, and application activation recovery plus manager shutdown before database flushing.

## TDD evidence

- RED: `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs` initially failed because `expiryReminder.js` and the manager lifecycle methods did not exist.
- GREEN: implemented the smallest lifecycle/reminder path until the focused suite passed.
- Regression cycles added after review cover stale Refresh completion after disconnect and a replacement connection Bootstrap while the old Bootstrap is in flight.

## Verification

- `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs test/server-connection-ipc.test.mjs test/server-credential-store.test.mjs test/server-device-grant-client.test.mjs` — 41 passed, 0 failed.
- `npm run build` — passed (main, preload, renderer bundles).
- `git diff --check` — passed (only existing CRLF conversion warnings).
- `npm test` — passed (exit code 0).

## Self-review

- No access or refresh token is exposed in runtime state, reminders, notification text, or tests.
- Refresh and Bootstrap flights are keyed by immutable connection ID, connection revision, and lifecycle epoch; stale completions cannot update a disconnected or replacement connection.
- Pending refresh persistence retains the new ciphertext in controlled memory/SQLite, blocks lifecycle access, and never retries the old refresh token.
- Registration/deep-link attempt fencing, promotion commit point, and legacy sanitized IPC connection summary remain intact.

## Concerns

- Runtime bearer revocation remains Task 4's existing numeric callback shape for compatibility. Task 6 must upgrade it to the required immutable `{ connectionId, connectionRevision }` identity before proxy sessions are introduced.
- No live server call or invitation secret was used.

## Task 6 carryover correction

- The expiry timer now uses a reminder-only reevaluation path. It preserves the last fresh response's `serverTime`, `receivedLocalTime`, and `serverOffsetMs`; only Redeem, Refresh, and Bootstrap responses replace that server-clock snapshot.
- Reminder ticks persist only crossed-threshold state, so the original fake-scheduler 7/3/1/0 regression progresses without mutating the server clock.
- Verification: `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs` — 13 passed, 0 failed.

## Review fix round 1

- Added a shutdown fence over preview, Redeem, Refresh, Bootstrap, timers, and credential mutation completion. Shutdown invalidates non-committing registration work, waits active lifecycle work, retries a pending safe flush once, then performs a final runtime-secret/cache/timer scrub.
- Added a shared database credential pending-persistence gate and manager continuation for metadata writes. Metadata and rotated-token flush failures both publish `unreachable/PERSISTENCE_PENDING`, block lifecycle access, schedule bounded retry, and resume only against the captured current connection/epoch.
- Added the Electron `powerMonitor` resume listener instead of the incorrect `app` event.

### Review-fix verification

- RED/GREEN: pending Refresh shutdown, metadata safe-write gating/retry scheduling, and `powerMonitor` static integration coverage.
- Focused suite: 48 passed, 0 failed.
- `npm run build`: passed.
- `npm test`: passed (exit code 0).
- `git diff --check`: passed.

## Review fix round 2

- Final shutdown scrub now clears timers installed by a committing Redeem while shutdown waits.
- Credential pending state is shared per database and prevents a second store from decrypting or mutating lifecycle credentials until the shared flush succeeds.
- Failed pending-flush recovery re-arms bounded retry backoff.
