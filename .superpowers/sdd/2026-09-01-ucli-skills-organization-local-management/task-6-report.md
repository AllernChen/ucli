# Task 6 report: organization catalog synchronization

## Delivered

- Added the TTL-bound, single-flight organization Skills synchronization coordinator with safe change events, stale-completion fencing, and shutdown cancellation.
- Routed connection lifecycle synchronization through the coordinator and exposed bounded sync-state/refresh IPC plus renderer subscriptions.
- Made the Skills page render cached catalog entries first, refresh in the background and on focus, and keep its sync state independent from connection-wide busy/model error state.
- Preserved cached organization catalog entries during transient `unreachable`; explicit `disconnected` clears the online catalog.

## Approved scope deviation

`electron/serverConnection/skillsCatalogAdapter.js` and its focused test were changed with primary-agent authorization. The existing adapter cleared durable catalog rows whenever runtime credentials were unavailable, including temporary `unreachable`. The narrow seam now uses persisted connection identity for cached reads and clears rows only on the explicit `disconnected` lifecycle event; all network, parsing, and download operations still require the runtime identity.

## Verification

- `node --test test/server-skills-sync-coordinator.test.mjs test/server-connection-ipc.test.mjs test/server-connection-store.test.mjs test/server-skills-catalog.test.mjs`
- `node --test test/server-settings-template.test.mjs test/skills-presentation.test.mjs`
- `npm run build`
- `git diff --check`
