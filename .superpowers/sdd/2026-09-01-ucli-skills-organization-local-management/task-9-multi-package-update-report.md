# Task 9 multi-package organization-update report

## Scope

An organization catalog update can mutate more than one installed package when those packages share its exact server origin, organization id, and persisted slug.  The batch coordinator now preserves every matching package mapping rather than selecting only the first one.

## Behavior

- Exact catalog-version mappings and persisted-slug mappings are combined, deduplicated by package id, and ordered deterministically.
- The organization entry revision includes the matched package snapshots, so a package-mapping change invalidates an old preview.
- Before an organization update, the coordinator collects installations from every matched package, restricted to the requested scope and target adapters, then resolves all affected sessions once before the mutation.

## TDD and verification

The new same-slug regression was first run against the prior implementation and failed because it returned only `session-first-codex`; the expected second package session was absent.  It now proves both matching package sessions are returned, while a project-scope and a different-adapter installation remain excluded.

- Focused regression: passed (1 test).
- Focused Skills suite: passed (118 tests).
- `npm run build`: passed.
- `git diff --check`: passed.
