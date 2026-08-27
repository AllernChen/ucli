# Task 6 report — loopback model proxy and immutable runtime identity

## Delivered

- Repaired the carried reminder-clock defect in separate commit `6144eac` (`fix(server): preserve reminder clock snapshot`). Timer ticks now preserve the last fresh server-clock receipt and persist only reminder crossings.
- Added `localGatewayProxy.js`: IPv4 loopback-only listener on an OS-selected port; per-session 256-bit in-memory bearers bound to immutable connection identity; exact route/method/query allowlist; sanitized bearer injection; root-preserving gateway URL construction; streamed request/response forwarding; client-abort propagation; GET-models-only one-refresh retry; and cross-origin redirect rejection.
- Migrated runtime revocation and pending revocations from numeric revisions to immutable `{ connectionId, connectionRevision }` values. The manager now exposes its live runtime identity without exposing credentials.
- Started and shut down the proxy with the initialized connection manager. The orchestrator exposes only deferred Task 7 facades: `createServerGatewaySession` and `revokeServerGatewaySession`.

## TDD evidence

- Reminder regression RED: `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs` failed with only the existing 7/3/1/0 scheduler assertion (actual `[7, 3]`, expected `[7, 3, 1, 0]`), then passed after the reminder-only path.
- Proxy RED: `node --test test/server-local-proxy.test.mjs` initially failed with `ERR_MODULE_NOT_FOUND` for `localGatewayProxy.js`.
- Identity migration RED: updated manager IPC assertions to require `{ connectionId: 'old', connectionRevision: 7 }`; the old numeric callback/pending value failed until the manager migration was implemented.
- Stale-identity RED: the proxy initially returned 502 after calling the injected upstream; it now returns 401 before upstream access when the connection changes during gateway resolution.

## Verification

- `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs` — 13 passed, 0 failed.
- `node --test test/server-local-proxy.test.mjs test/gateway-root-lifecycle.test.mjs test/gateway-session-routing.test.mjs` — 22 passed, 0 failed.
- `npm run build` — passed.
- `npm test` — passed (pretest 115 passed; full suite exited 0).
- `git diff --check` — passed.

## Self-review

- No invitation, access token, refresh token, session bearer, model body, header, or query is persisted or logged. Proxy diagnostic entries contain only origin, route category, status, duration, and a one-way session fingerprint.
- Model upstream 401/5xx responses are relayed as model responses and do not call lifecycle-error handling. POST is never replayed; only `GET /v1/models` performs exactly one forced refresh retry.
- The proxy rechecks immutable identity after async Bootstrap/access-token resolution, closing the replacement/disconnect race before it can reach upstream.

## Concerns

- Task 7 must call the supplied orchestrator session create/revoke facade from every server-profile launch/end path. This task intentionally does not modify profile selection or launch behavior.
- No live network request or real invitation secret was used.

## Review fix round 1

- Forced upstream `Accept-Encoding: identity` and strip `content-encoding`/`content-length` from fetched responses, because undici decodes response bodies before the loopback stream writes them. Response filtering now also removes every token named by upstream `Connection`.
- Reject every 3xx response, including relative and same-origin locations, so a loopback client never receives an upstream `Location` header.
- Reissuing a session ID now revokes its prior bearer before issuing the replacement.
- Disconnect now clears runtime identity, token/cache/timers, and revokes the immutable identity before waiting for credential deletion. A failed deletion stays detached and retries persistence/deletion without restoring runtime authority.
- Added real gzip, response `Connection` token, all-redirect, session-supersession, deferred deletion, pending-deletion retry, and reminder-clock snapshot regressions.

### Review-fix verification

- `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs` — 15 passed, 0 failed.
- `node --test test/server-local-proxy.test.mjs test/gateway-root-lifecycle.test.mjs test/gateway-session-routing.test.mjs` — 24 passed, 0 failed.
- `npm run build` — passed.
- `npm test` — passed (exit 0).
- `git diff --check` — passed.

## Review fix round 2

- Added an operation-epoch ownership marker for runtime connections. Disconnect captures its epoch, immediately fences the prior runtime, then finalizes after queued credential deletion. Finalization clears and revokes only a connection committed by an older operation, so it cannot target a later reconnection.
- Promotion startup now verifies that its committed connection is still current before installing an access token, preventing a late Bootstrap continuation from restoring authority after disconnect finalization.
- Added deterministic success and `PERSISTENCE_PENDING` promotion/disconnect interleavings. Both prove the database delete is attempted, old and late immutable identities are revoked, and the final runtime has no current connection, token, cache, or timers.

### Review-fix round 2 verification

- `node --test test/server-connection-manager.test.mjs test/server-expiry-reminder.test.mjs test/server-connection-ipc.test.mjs` — 29 passed, 0 failed.
- `node --test test/server-local-proxy.test.mjs test/gateway-root-lifecycle.test.mjs test/gateway-session-routing.test.mjs` — 24 passed, 0 failed.
- `npm run build` — passed.
- `npm test` — passed (exit 0).
- `git diff --check` — passed.
