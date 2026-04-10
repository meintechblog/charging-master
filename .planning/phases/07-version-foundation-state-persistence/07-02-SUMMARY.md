---
phase: 07-version-foundation-state-persistence
plan: 02
subsystem: self-update
tags: [self-update, api, boot, ui, version-badge, health-probe]

requires:
  - phase: 07-version-foundation-state-persistence
    plan: 01
    provides: "src/lib/version.ts, UpdateStateStore, updateRuns table, DEFAULT_UPDATE_STATE"

provides:
  - GET /api/version endpoint (5-field response, live DB probe, <50ms)
  - UpdateStateStore.init() wired into server.ts main() before HttpPollingService
  - VersionBadge client component on Settings page with hover-for-full + click-to-copy
  - Established server.ts -> self-update module import path (no server-only guard)

affects:
  - 08-github-polling          # reads/writes lastCheckEtag via UpdateStateStore
  - 09-updater-pipeline        # post-restart health gate probes GET /api/version
  - 10-live-feedback-ui        # consumes rollbackHappened to render rollback banner

tech-stack:
  added: []  # no new runtime deps
  patterns:
    - "Synchronous route handler (not async) for sub-50ms hot paths (better-sqlite3 + sync fs reads)"
    - "Cache-Control: no-store on health endpoints to keep Phase 9 post-restart probe honest"
    - "Literal-type widening via `as string` cast when comparing generated constants to sentinel values"

key-files:
  created:
    - src/app/api/version/route.ts
    - src/app/settings/version-badge.tsx
    - .planning/phases/07-version-foundation-state-persistence/07-02-SUMMARY.md
  modified:
    - server.ts                                      # +UpdateStateStore.init() in main()
    - src/modules/self-update/update-state-store.ts  # removed `import 'server-only'`
    - src/app/settings/page.tsx                      # mount <VersionBadge /> in header row

key-decisions:
  - "Removed `import 'server-only'` from update-state-store.ts because server.ts (the Node custom entrypoint imported by tsx) is not a React Server Component, and server-only throws in non-RSC contexts. node:fs imports provide equivalent bundle-leak protection."
  - "VersionBadge CURRENT_SHA_SHORT === 'unknown' comparison requires `as string` cast because the generator writes a literal-typed export, making the direct comparison a TS compile error."
  - "GET /api/version is a synchronous (non-async) function — better-sqlite3 is sync, UpdateStateStore.read() is sync, no awaitable work. Saves a microtask on every probe."
  - "Clipboard fallback is silent on non-secure context (no execCommand shim). Hover tooltip remains the fallback path per CONTEXT.md Claude's Discretion."

patterns-established:
  - "Health endpoints in this app use plain `Response.json(...)` (not NextResponse) with explicit Cache-Control: no-store headers"
  - "Custom-server-imported modules MUST NOT use `import 'server-only'`; rely on platform imports (node:fs) for bundle exclusion instead"
  - "Generated build constants need literal-type widening when compared against non-matching string literals"

requirements-completed: [VERS-03, VERS-04]

duration: ~5.7 min
completed: 2026-04-10
---

# Phase 7 Plan 02: Wave 2 Integration Summary

**Wired the Phase 7 foundation (built in plan 07-01) into the running app: `/api/version` serves a live health-probed version/rollback payload, `UpdateStateStore.init()` runs on every boot before any other service, and Settings ships a subtle `<VersionBadge />` with hover-for-full-SHA + click-to-copy.**

## Performance

- **Duration:** ~5.7 min (from plan start 12:43:56Z to SUMMARY write 12:49:something)
- **Tasks:** 3 automated (committed) + 1 human-verify checkpoint (pending)
- **Files created:** 2 source files + this SUMMARY
- **Files modified:** 3 (server.ts, update-state-store.ts, settings/page.tsx)

## Accomplishments

- `GET /api/version` returns the locked 5-field shape `{sha, shaShort, buildTime, rollbackSha, dbHealthy}` in ~8–25ms (measured). Live `SELECT 1` probe via the raw better-sqlite3 handle; both the DB probe and the rollbackSha read are wrapped in try/catch so the endpoint is guaranteed to return 200 even if SQLite or state.json is in a degraded state.
- `server.ts main()` now initializes `.update-state/state.json` via `UpdateStateStore.init()` as the first action after `await app.prepare()`. Fresh boot logs `[UpdateStateStore] initialized .../state.json with currentSha=<short>`; subsequent boots are silent and leave mtime unchanged (verified 1775825190 == 1775825190 across two boots).
- Settings page at `/settings` now renders a compact monospace badge (`v <shaShort> · YYYY-MM-DD`) in the top-right of the "Einstellungen" header row. Hover reveals the full 40-char SHA plus "Klicken zum Kopieren" via the native `title` attribute; click writes the full SHA to the clipboard and flashes "Kopiert ✓" for 1.5s.
- End-to-end consistency verified: the SHA shown in the badge (`3c6b624` / `bd06a96` during testing) matches `sha`/`shaShort` in `GET /api/version`, matches `CURRENT_SHA`/`CURRENT_SHA_SHORT` in `src/lib/version.ts`, and matches `currentSha` in `.update-state/state.json` on fresh-boot inits.

## Task Commits

Each task committed atomically:

1. **Task 1: GET /api/version route** — `5b33411` (feat)
2. **Task 2: UpdateStateStore.init() in server.ts main()** — `3c6b624` (feat) — also includes the `server-only` removal from update-state-store.ts
3. **Task 3: VersionBadge client component + Settings mount** — `bd06a96` (feat) — also includes the `as string` cast fix
4. **Task 4: Human-verify checkpoint** — PENDING (awaiting user confirmation per the how-to-verify checklist)

## Files Created/Modified

### Created
- `src/app/api/version/route.ts` — Synchronous GET handler; imports `CURRENT_SHA`, `CURRENT_SHA_SHORT`, `BUILD_TIME` from `@/lib/version`, `sqlite` from `@/db/client`, `UpdateStateStore` from `@/modules/self-update/update-state-store`. `export const runtime = 'nodejs'` and `dynamic = 'force-dynamic'` per CONTEXT.md lock. `Cache-Control: no-store, no-cache, must-revalidate` header.
- `src/app/settings/version-badge.tsx` — `'use client'` React component, 55 lines. Imports generated constants, formats build date to YYYY-MM-DD, renders a `<button>` with hover tooltip + click-to-copy, `useState` for the 1.5s "Kopiert ✓" confirmation.

### Modified
- `server.ts` — added `import { UpdateStateStore } from './src/modules/self-update/update-state-store'` and called `UpdateStateStore.init()` as the first line inside `main()` after `await app.prepare()`. NOT wrapped in try/catch (locked decision: fail loud on broken state store).
- `src/modules/self-update/update-state-store.ts` — removed `import 'server-only'` (see deviations). Added a multi-line comment explaining why.
- `src/app/settings/page.tsx` — added `import { VersionBadge } from './version-badge'`, wrapped the existing `<h1>` in a `flex items-center justify-between` div with `<VersionBadge />` as its sibling.

## Decisions Made

All primary decisions were pre-locked by 07-CONTEXT.md and 07-02-PLAN.md. Two sub-decisions were forced during execution by the two Rule 3 deviations below:

1. **`server-only` removal over lazy-import wrapper** (update-state-store.ts): The alternative was to keep `server-only` and introduce a lazy `await import('./update-state-store')` inside `main()`, but that would put a top-level await dance on every boot for zero gain. The `node:fs` direct import already blocks client-bundle leakage at webpack/turbopack build time — `server-only` was redundant belt-and-suspenders. Dropped the belt.

2. **`as string` cast over type-widening the generator output**: The alternative was to have `scripts/build/generate-version.mjs` emit `export const CURRENT_SHA_SHORT: string = "..."` with an explicit annotation. That would be a nicer long-term fix but touches plan 07-01's frozen artifact. Cast is localized to the one consumer that actually compares against a sentinel, leaves the generator alone, and comments document the reason for the next reader.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `server-only` throws from custom Node entrypoint**

- **Found during:** Task 2 first verification boot
- **Issue:** `update-state-store.ts` had `import 'server-only'` at the top. When `server.ts` (the tsx-run custom Node entrypoint) imports `UpdateStateStore`, the transitive `server-only` import throws `Error: This module cannot be imported from a Client Component module.` because tsx evaluates server.ts outside Next.js's RSC module graph. Boot crashed before reaching `UpdateStateStore.init()`.
- **Fix:** Removed `import 'server-only'` from `update-state-store.ts` and added a 6-line comment explaining why. `node:fs` imports still prevent any client-bundle import attempt at build time.
- **Files modified:** `src/modules/self-update/update-state-store.ts`
- **Verification:** Fresh `rm -rf .update-state && pnpm dev` now produces `[UpdateStateStore] initialized ... with currentSha=5b33411` and a valid state.json.
- **Committed in:** `3c6b624` (together with the server.ts change that introduced the import)

**2. [Rule 3 - Blocking] TS literal-type mismatch on CURRENT_SHA_SHORT === 'unknown'**

- **Found during:** Task 3 `pnpm tsc --noEmit` verification
- **Issue:** The generator writes `export const CURRENT_SHA_SHORT = "5b33411"` which TS narrows to the literal string type `"5b33411"`. The `CURRENT_SHA_SHORT === 'unknown'` comparison in `version-badge.tsx` became a TS2367 "This comparison appears to be unintentional" error because the two literal types have no overlap.
- **Fix:** Cast to `string` in the comparison: `(CURRENT_SHA_SHORT as string) === 'unknown'`. Localized, commented, one line changed.
- **Files modified:** `src/app/settings/version-badge.tsx`
- **Verification:** `pnpm tsc --noEmit` filtered for plan files returns `NO RELATED TSC ERRORS`.
- **Committed in:** `bd06a96`

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking). No architectural changes, no scope creep, no user decisions required.

## Issues Encountered

None beyond the two deviations above. Pre-existing stale `.next/types/` errors from deleted Phase 6 MQTT routes still surface on a raw `pnpm tsc --noEmit` run — filtered out here per plan 07-01's established scope boundary (they remain logged in `deferred-items.md`).

## Must-Haves Satisfied

Quoting the `must_haves.truths` from the plan frontmatter:

- ✅ "GET /api/version returns 200 with {sha, shaShort, buildTime, rollbackSha, dbHealthy} in under 50ms" — measured 5 sequential curls: 24ms, 9ms, 8ms, 8ms, 8ms.
- ✅ "dbHealthy reflects a live SELECT 1 probe against the SQLite database, wrapped in try/catch" — `probeDb()` in route.ts uses `sqlite.prepare('SELECT 1 as ok').get()` inside try/catch; returns `row?.ok === 1`.
- ✅ "rollbackSha is read from .update-state/state.json (null on fresh install, non-null after an auto-rollback has persisted)" — `readRollbackSha()` in route.ts constructs a new UpdateStateStore and reads `rollbackSha`. Fresh boot returns `null` (verified).
- ✅ "First boot after this plan creates .update-state/state.json via UpdateStateStore.init() before HttpPollingService starts" — verified by `rm -rf .update-state && pnpm dev` + log line `[UpdateStateStore] initialized .../state.json with currentSha=5b33411` emitted before `NotificationService started` / `SessionRecorder started` / `Charging Master ready`.
- ✅ "Subsequent boots do NOT overwrite an existing .update-state/state.json" — verified `MTIME1=1775825190` == `MTIME2=1775825190` across two boots with no state.json deletion in between.
- ✅ "Settings page displays the short SHA prominently as the first element on the page" — `<VersionBadge />` is now in the header row next to the `<h1>`. HTML inspection shows the rendered `<button>` with `font-mono text-xs`.
- ✅ "Hovering the short SHA reveals the full SHA via native title tooltip" — `title={\`Vollständiger SHA: ${CURRENT_SHA}\nKlicken zum Kopieren\`}` verified in rendered HTML.
- ⏳ "Clicking the badge copies the full SHA to the clipboard and shows a transient 'Kopiert ✓' state" — PENDING task 4 human verification. Code path is in place (`navigator.clipboard.writeText(CURRENT_SHA)` + `setCopied(true)` + 1.5s timeout) but clipboard writes require an actual browser + user gesture, not curl.

## Interfaces Exported for Downstream Plans

| Symbol / Contract | Location | Downstream Consumer |
|---|---|---|
| `GET /api/version` → `{sha, shaShort, buildTime, rollbackSha, dbHealthy}` with `Cache-Control: no-store` | `src/app/api/version/route.ts` | Phase 9 post-restart health gate (EXEC-04/ROLL-04), Phase 10 auto-reload poll |
| `UpdateStateStore.init()` boot contract | `server.ts main()` | Phase 8 poller can assume `.update-state/state.json` exists and has current shape; Phase 9 bash updater reads/writes the same file |
| `<VersionBadge />` component | `src/app/settings/version-badge.tsx` | Phase 10 may add sibling badges next to it (e.g., "Update verfügbar") but should not modify it |
| `server-only` guidance for self-update module | n/a (convention) | Phase 8 (update checker) and Phase 9 (orchestrator) MUST NOT add `import 'server-only'` to any file that is transitively imported by `server.ts` — use `node:fs` direct imports for equivalent protection |

## User Setup Required

None. All changes are code-only. No environment variables, no external services, no credentials.

## Clipboard Fallback Decision (Documented for Phase 10)

On the production LXC (`http://charging-master.local:3000`), browsers treat the host as a non-secure context and may refuse `navigator.clipboard.writeText`. The badge handles this silently: the `try/catch` around the clipboard call swallows the rejection and the button simply does not show "Kopiert ✓". The native title tooltip continues to expose the full SHA on hover, which is sufficient for operator needs (copy-from-tooltip via triple-click or DevTools).

Phase 10 MUST NOT add an `execCommand('copy')` legacy fallback — it's flagged deprecated and introduces a selection/iframe dance for one field. If Phase 10 wants first-class clipboard support, the right fix is to serve the app over HTTPS (or trust `http://localhost` on the LXC host binding) — out of scope for Phase 7.

## Next Phase Readiness

**Ready for Phase 8 (GitHub Polling):**
- `GET /api/version` is stable and fast; the 6h poller can hit it locally for a self-check if needed.
- `UpdateStateStore` is guaranteed-initialized before any service boots, so the Phase 8 poller can call `new UpdateStateStore().write({ lastCheckAt, lastCheckEtag, ... })` from its first tick without an init dance.
- No MQTT-style broker wiring or lifecycle concerns — this is all sync fs + in-process state.

**Ready for Phase 9 (Updater Pipeline):**
- Post-restart health probe can hit `http://localhost:3000/api/version` and check `dbHealthy === true` + `sha !== previousSha` for EXEC-04.
- Bash updater can read/write `.update-state/state.json` as plain JSON — same shape verified here.

**Ready for Phase 10 (UI Integration):**
- `<VersionBadge />` is mounted and live on Settings. Phase 10 LIVE-05 ROLL-06 "red rollback banner" can read `rollbackHappened` via a new `/api/version` extension or a sibling endpoint; the current 5-field shape is frozen and must not be broken.

## Known Stubs

None. No hardcoded empty arrays, no "TODO" placeholders, no components wired to mock data. The VersionBadge is fully data-driven from the generated `@/lib/version` constants; the route handler reads live DB and live state.json on every request.

## Self-Check: PASSED

- `src/app/api/version/route.ts` — FOUND
- `src/app/settings/version-badge.tsx` — FOUND
- `server.ts` (modified, contains `UpdateStateStore.init()`) — FOUND
- `src/modules/self-update/update-state-store.ts` (modified, no `server-only` import) — FOUND
- `src/app/settings/page.tsx` (modified, imports `VersionBadge`) — FOUND
- Commit `5b33411` — FOUND in git log
- Commit `3c6b624` — FOUND in git log
- Commit `bd06a96` — FOUND in git log
- `.update-state/state.json` — FOUND (populated with `currentSha` from this run's gen:version output)

---
*Phase: 07-version-foundation-state-persistence*
*Completed: 2026-04-10 (pending task 4 human verification)*
