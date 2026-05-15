---
phase: 13-update-pipeline-hardening
plan: 03
subsystem: self-update
tags: [updater, quarantine, admin-api, host-guard, pipe-03, backend]
requirements: [PIPE-03]
dependency_graph:
  requires:
    - "Plan 13-01 — UpdateState.lastQuarantine + UpdateInfoView.lastQuarantine + state_set_quarantine bash helper"
  provides:
    - "DELETE /api/admin/update-state/quarantine (consumed by 13-04 admin page 'Alle löschen' button)"
    - "Response contract { ok:true, removedPath, removedFileCount } | { error, message }"
  affects:
    - src/app/api/admin/update-state/quarantine/route.ts
    - src/app/api/admin/update-state/quarantine/route.test.ts
tech_stack:
  added: []
  patterns:
    - "Browser-facing host guard via isAllowedBrowserHost (LAN allowlist incl. charging-master.local)"
    - "Defense-in-depth path prefix check: refuses rm outside <cwd>/.update-state/quarantine-*"
    - "fs.rm(recursive:true,force:true) + ENOENT-safe via force flag"
    - "UpdateStateStore.write spread-merge preserves every non-patched field (only lastQuarantine cleared)"
    - "Vitest mocking via vi.hoisted to dodge the vi.mock factory hoisting trap"
    - "Partial-failure 500 surface: rm OK but state write fails → 500 state_write_failed so UI does NOT show success"
key_files:
  created:
    - src/app/api/admin/update-state/quarantine/route.ts
    - src/app/api/admin/update-state/quarantine/route.test.ts
  modified: []
decisions:
  - "isAllowedBrowserHost (not isLocalhostHost) — RESEARCH Pitfall 12: this endpoint is browser-reachable from /settings/update-state, must accept charging-master.local"
  - "QUARANTINE_PATH_PREFIX = resolve(cwd, '.update-state') + '/quarantine-' — fail-closed on any state.lastQuarantine.path that escapes this prefix"
  - "removedFileCount is informational only — readdir failure does NOT block rm (returns null in response)"
  - "Idempotent no-op for both null AND undefined lastQuarantine (legacy state.json shape pre-Plan-13-01)"
  - "No DB write — single-purpose per CONTEXT.md §Design Decision 6 (PIPE-04 owns the update_runs audit row)"
  - "lastQuarantine surface on /api/update/status already shipped in Plan 13-01 via deriveUpdateInfoView; no route change needed in this plan"
metrics:
  duration_seconds: 240
  duration_human: "~4m"
  tasks_completed: 2
  files_modified: 2
  commits: 2
  completed_at: "2026-05-15T03:23:00Z"
---

# Phase 13 Plan 03: DELETE /api/admin/update-state/quarantine Summary

Shipped the browser-facing admin DELETE endpoint that backs the "Alle löschen" button on the upcoming `/settings/update-state` admin page (Plan 13-04). On a DELETE call from `http://charging-master.local/...`, the endpoint reads `state.lastQuarantine.path`, rm-rf's that directory, and patches `state.json` to clear the `lastQuarantine` field. Idempotent when state already has no quarantine recorded. Defense-in-depth: refuses to rm any path that does not live inside `<cwd>/.update-state/quarantine-*`.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 1 | Create DELETE handler at `src/app/api/admin/update-state/quarantine/route.ts` (110 lines) | `186b1ee` |
| 2 | Add vitest coverage with 10 cases (220 lines) — happy path, idempotent, forbidden, path-safety, partial failures | `e08ad51` |

## Endpoint Anatomy

```
src/app/api/admin/update-state/quarantine/route.ts — 110 lines

  1- 17  // JSDoc header — purpose, host-guard rationale, side-effects, idempotency
 19- 22  imports (fs/promises rm + readdir, path.resolve, isAllowedBrowserHost, UpdateStateStore)
 24- 25  runtime='nodejs', dynamic='force-dynamic'
 27- 29  NO_CACHE_HEADERS
 31- 35  // QUARANTINE_PATH_PREFIX defense-in-depth doc + constant
 37-107  export async function DELETE(request)
   38- 40    isAllowedBrowserHost guard → 403 { error: 'forbidden' }
   42- 53    store.read() with 500 state_read_failed fallback
   55- 61    null/undefined lastQuarantine → 200 idempotent no-op
   63- 73    QUARANTINE_PATH_PREFIX check → 500 path_not_in_state_dir
   75- 83    best-effort readdir → removedFileCount (null on failure)
   85- 92    fs.rm → 500 rm_failed on rejection
   94-103    store.write({ lastQuarantine: null }) → 500 state_write_failed on throw
  105-108    success → 200 { ok:true, removedPath, removedFileCount }
```

Done-criteria grep (Task 1 verification):
```
$ grep -c "isAllowedBrowserHost\|lastQuarantine: null\|QUARANTINE_PATH_PREFIX\|recursive: true" \
    src/app/api/admin/update-state/quarantine/route.ts
10
```
≥4 required, 10 found. Imports include `isAllowedBrowserHost` from `@/lib/host-guard` (the LAN browser variant, NOT inline localhost-only shape). Exports `runtime`, `dynamic`, `DELETE`.

## Test Results

### New tests — 10/10 passing

```
✓ DELETE /api/admin/update-state/quarantine > allowed host (charging-master.local) → 200, rm called, state patched
✓ DELETE /api/admin/update-state/quarantine > localhost host → 200 (same allowlist as charging-master.local)
✓ DELETE /api/admin/update-state/quarantine > allowed host with lastQuarantine=null → 200 idempotent no-op
✓ DELETE /api/admin/update-state/quarantine > allowed host with no lastQuarantine field (legacy state) → 200 idempotent no-op
✓ DELETE /api/admin/update-state/quarantine > non-allowed host (evil.example.com) → 403 forbidden
✓ DELETE /api/admin/update-state/quarantine > quarantine path outside .update-state/quarantine-* prefix → 500 path_not_in_state_dir
✓ DELETE /api/admin/update-state/quarantine > rm failure → 500 rm_failed, writeFn NOT called
✓ DELETE /api/admin/update-state/quarantine > state.write failure after successful rm → 500 state_write_failed
✓ DELETE /api/admin/update-state/quarantine > readdir failure does NOT block rm (file count is informational)
✓ DELETE /api/admin/update-state/quarantine > state.read failure → 500 state_read_failed
```

The path-safety guard (Test 6) is the load-bearing security assertion: it seeds `state.lastQuarantine.path = '/etc/passwd'` and confirms the response is 500 `path_not_in_state_dir` with NO call to `rm` or `store.write`. Without this guard a corrupted state.json could turn the endpoint into an arbitrary rm-rf primitive.

### Vitest full baseline — 250/250 passing

```
 Test Files  18 passed (18)
      Tests  250 passed (250)
   Start at  05:21:09
   Duration  4.43s
```

Baseline before this plan (per 13-01 SUMMARY): 240 tests. Delta: +10 tests, all green. No regression in the existing 240-test baseline.

### TypeScript

`pnpm exec tsc --noEmit` → exit 0, no errors.

## Vitest Mock Pattern Note (for future PIPE-* tests)

The first mock attempt used naked top-level `const rmFn = vi.fn()` referenced inside `vi.mock('node:fs/promises', () => ({ rm: rmFn, ... }))` and crashed with `ReferenceError: Cannot access 'rmFn' before initialization` because the mock factory is hoisted above the const declarations. The fix is `vi.hoisted(() => ({ rmFn: vi.fn(), ... }))` so the mock targets exist before the factory closures execute. A second attempt with `vi.mock(import('node:fs/promises'), async (importOriginal) => ({ ...actual, rm: rmFn, ... }))` (Vitest 4's partial-mock-via-import-spec syntax) compiled but failed at runtime — the real `fs/promises` `rm`/`readdir` were resolved instead of the mocks, causing readdir to throw "ENOENT" against a nonexistent path. Final shape is the simple full-replacement mock with explicit `default` export to satisfy Vitest 4's CJS interop:

```ts
vi.mock('node:fs/promises', () => ({
  default: { rm: rmFn, readdir: readdirFn },
  rm: rmFn,
  readdir: readdirFn,
}));
```

Document for Plan 13-04 (if it also mocks fs/promises): use this shape, NOT the importOriginal spread.

## lastQuarantine Surface on /api/update/status — Pre-Existing

The user prompt mentioned surfacing `lastQuarantine` on `/api/update/status` as a separate task. Investigation found this was already shipped by Plan 13-01:

- `src/modules/self-update/types.ts:176` — `UpdateInfoView.lastQuarantine?: { ... } | null` (added by 13-01).
- `src/modules/self-update/update-info-view.ts:42` — base view literal includes `lastQuarantine: state.lastQuarantine ?? null` (added by 13-01).
- `src/app/api/update/status/route.ts` — calls `getUpdateInfo()` which calls `deriveUpdateInfoView`, so the field tunnels through automatically with no route-level change.

No additional change to `status/route.ts` was required for this plan. The endpoint already returns `lastQuarantine` when present in state.json. After a successful DELETE, the field is `null`, so subsequent `GET /api/update/status` calls return `lastQuarantine: null` — the must_have invariant from the plan frontmatter is satisfied through the chain (state.json write → store.read → deriveUpdateInfoView base.lastQuarantine).

## Deviations from Plan

None — both tasks executed exactly as specified in the plan body. The only adaptation was the Vitest 4 mock syntax discovery noted above, which is a test-infrastructure detail not a behavioral deviation. No CLAUDE.md rules conflicted.

## Auth Gates

None — endpoint design is host-header-only (LAN browser allowlist).

## Known Stubs

None — the route is fully wired. The UI consumer (admin page + button click) ships in Plan 13-04 (Wave 3); this plan deliberately delivers backend-only. `lastQuarantine` is already exposed via `/api/update/status` (since Plan 13-01) and is now also clearable via the new DELETE endpoint.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-write-surface | `src/app/api/admin/update-state/quarantine/route.ts` | New DELETE endpoint reachable from any LAN host whose Host header matches the `isAllowedBrowserHost` allowlist (defaults: `127.0.0.1`, `localhost`, `::1`, `[::1]`, `charging-master.local`, plus `UPDATE_ALLOWED_HOSTS` env). Side effects: rm-rf of one directory under `<cwd>/.update-state/quarantine-*` + state.json patch. Worst-case abuse without the path-prefix guard would be arbitrary rm-rf — mitigated by `QUARANTINE_PATH_PREFIX.startsWith()` check (Test 6 asserts this). Per CONTEXT.md §Security Model, LAN segmentation is the primary auth gate; this guard is defense-in-depth on top of that. |

## Self-Check: PASSED

- `src/app/api/admin/update-state/quarantine/route.ts` — exists (110 lines).
- `src/app/api/admin/update-state/quarantine/route.test.ts` — exists (220 lines).
- Commit `186b1ee` — found in `git log --oneline -5`.
- Commit `e08ad51` — found in `git log --oneline -5`.
- `pnpm exec tsc --noEmit` → exit 0.
- `pnpm exec vitest run` → 250/250 passing (240 baseline + 10 new).
- Endpoint uses `isAllowedBrowserHost` from `@/lib/host-guard` (not the inline localhost-only shape — confirmed by grep).
- Endpoint imports `rm` and `readdir` from `node:fs/promises` and `UpdateStateStore` from `@/modules/self-update/update-state-store`.
- DELETE handler exported; runtime='nodejs' and dynamic='force-dynamic' declared.
