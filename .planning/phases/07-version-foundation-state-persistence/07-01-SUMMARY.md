---
phase: 07-version-foundation-state-persistence
plan: 01
subsystem: infra
tags: [self-update, drizzle, sqlite, versioning, atomic-writes, prebuild]

requires:
  - phase: 06-discovery-mqtt-cleanup
    provides: MQTT-free schema baseline (enables generated 0001 migration to land cleanly)

provides:
  - Generated src/lib/version.ts with CURRENT_SHA, CURRENT_SHA_SHORT, BUILD_TIME
  - pnpm gen:version script chained into dev and build
  - Drizzle updateRuns sqliteTable + committed 0001 migration creating update_runs
  - UpdateStateStore class with atomic tmp+rename writes for .update-state/state.json
  - UpdateState/UpdateStatus/LastCheckResult shared types
  - DEFAULT_UPDATE_STATE seed constant

affects: [07-02, 08-github-polling, 09-updater-pipeline, 10-live-feedback-ui]

tech-stack:
  added: [server-only]  # already a dep; first use in this plan
  patterns:
    - "Build-time constant generation via prebuild ESM script + git-ignored TS file"
    - "Atomic cross-process JSON state via writeFileSync(tmp) + renameSync(final)"
    - "Drizzle sqliteTable enum columns via text(col, { enum: [...] as const })"

key-files:
  created:
    - scripts/build/generate-version.mjs
    - src/modules/self-update/types.ts
    - src/modules/self-update/update-state-store.ts
    - drizzle/0000_wide_screwball.sql  # previously untracked due to gitignore bug
    - drizzle/0001_nappy_stepford_cuckoos.sql
    - drizzle/meta/_journal.json
    - drizzle/meta/0000_snapshot.json
    - drizzle/meta/0001_snapshot.json
    - .planning/phases/07-version-foundation-state-persistence/deferred-items.md
  modified:
    - package.json  # gen:version script + dev/build chain
    - .gitignore    # +version.ts, +.update-state/, -drizzle/
    - src/db/schema.ts  # +updateRuns table + row types

key-decisions:
  - "Version baking uses a git-ignored generated file (src/lib/version.ts), NOT NEXT_PUBLIC_* env vars — single source of truth for server and client, explicitly overriding STACK.md"
  - "State persistence uses POSIX tmp+rename for atomicity instead of zod-validated reads, because the only writers are trusted (Node process + Phase 9 bash updater)"
  - "server-only guard on UpdateStateStore ensures fs imports can never leak to the client bundle"
  - "Drizzle timestamp_ms mode on startAt/endAt so Phase 9 queries receive native Date objects"
  - "UpdateStateStore.init() never overwrites existing state.json — preserves rollbackSha and lastCheckEtag across reboots"

patterns-established:
  - "Prebuild ESM scripts: scripts/build/*.mjs, ESM imports, no TypeScript (runs before tsc)"
  - "Self-update module layout: src/modules/self-update/{types,update-state-store}.ts"
  - "Drizzle migrations live in drizzle/ and are committed (after fixing the .gitignore bug)"

requirements-completed: [VERS-01, VERS-02, INFR-03, INFR-04]

duration: ~3.5 min
completed: 2026-04-10
---

# Phase 7 Plan 01: Version Foundation & State Persistence Summary

**Generated src/lib/version.ts baked at every build, Drizzle update_runs audit table with committed migration, and UpdateStateStore class with POSIX atomic (tmp+rename) writes — the self-update plumbing Phases 7-10 depend on.**

## Performance

- **Duration:** ~3.5 min
- **Started:** 2026-04-10T12:36:43Z
- **Completed:** 2026-04-10T12:40:06Z
- **Tasks:** 3 / 3
- **Files created:** 9 (scripts, module files, migrations, deferred-items log)
- **Files modified:** 3 (package.json, .gitignore, src/db/schema.ts)

## Accomplishments

- Prebuild script `scripts/build/generate-version.mjs` bakes full SHA + 7-char short SHA + ISO build time into `src/lib/version.ts` on every `pnpm dev` and `pnpm build`. Gracefully falls back to `"unknown"` in non-git environments.
- `updateRuns` Drizzle table landed with an auto-generated, committed migration (`drizzle/0001_nappy_stepford_cuckoos.sql`). Applied locally via `pnpm db:push`; verified with `sqlite3 .schema update_runs`.
- `UpdateStateStore` class provides synchronous `init()`/`read()`/`write(patch)` with atomic POSIX rename semantics — a mid-write crash can never leave a partially-written `state.json`.
- Shared `UpdateState`, `UpdateStatus`, `LastCheckResult` types and `DEFAULT_UPDATE_STATE` constant exported for reuse by plan 07-02 and Phases 8-10.
- Pre-existing `.gitignore` bug (drizzle/ ignored) fixed so migrations are now tracked — baseline 0000 migration is now committed alongside 0001.

## Task Commits

Each task was committed atomically:

1. **Task 1: Version generation script + package.json + .gitignore** — `fad685f` (feat)
2. **Task 2: Drizzle updateRuns table + generated migration** — `e89436d` (feat)
3. **Task 3: Self-update module — types + UpdateStateStore with atomic writes** — `f1acdbb` (feat)

## Files Created/Modified

### Created
- `scripts/build/generate-version.mjs` — ESM prebuild script; `execSync('git rev-parse HEAD')` + `new Date().toISOString()` → writes `src/lib/version.ts` with `JSON.stringify` for paranoia-safe escaping.
- `src/modules/self-update/types.ts` — `UpdateState`, `UpdateStatus`, `LastCheckResult`, `DEFAULT_UPDATE_STATE` (locked shape from 07-CONTEXT.md).
- `src/modules/self-update/update-state-store.ts` — `UpdateStateStore` class: `server-only` import guard, `mkdirSync` for `.update-state/`, atomic `writeFileSync(tmp) + renameSync(final)` writes, `init()` that never overwrites an existing file.
- `drizzle/0001_nappy_stepford_cuckoos.sql` — generated migration creating `update_runs` (9 columns, autoincrement PK, enum-validated status).
- `drizzle/0000_wide_screwball.sql`, `drizzle/meta/*` — baseline migration files that were previously un-committable due to the `drizzle/` gitignore bug.
- `.planning/phases/07-version-foundation-state-persistence/deferred-items.md` — logs out-of-scope `.next/types/` MQTT stubs.

### Modified
- `package.json` — added `"gen:version": "node scripts/build/generate-version.mjs"` and chained it into `dev` (`pnpm gen:version && tsx watch server.ts`) and `build` (`pnpm gen:version && next build`). `start` intentionally unchanged — production builds already ran gen:version.
- `.gitignore` — ADDED `/src/lib/version.ts` and `/.update-state/`; REMOVED `drizzle/`. Fix for the pre-existing gitignore bug per plan Task 1.
- `src/db/schema.ts` — appended `updateRuns` sqliteTable + `UpdateRunRow` / `NewUpdateRunRow` inferred types after `sessionEvents`.

## Decisions Made

All decisions pre-locked by 07-CONTEXT.md — no new decisions needed during execution. Key locked decisions honored:

- Generated file (not env vars) for version baking.
- Atomic writes via tmp+rename (not in-place writeFileSync).
- No zod validation on state.json reads (trusted writers only).
- `server-only` import guard on UpdateStateStore.
- Drizzle `timestamp_ms` mode on `startAt`/`endAt`.
- `init()` never overwrites existing state.json.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Drizzle migration also dropped a stale plugs.mqtt_topic_prefix column**

- **Found during:** Task 2 (`pnpm db:generate`)
- **Issue:** Drizzle detected drift between `src/db/schema.ts` (which Phase 6 left MQTT-free) and the dev database (which still had the legacy `plugs.mqtt_topic_prefix` column from before Phase 6). The generated 0001 migration therefore included an `ALTER TABLE plugs DROP COLUMN mqtt_topic_prefix` statement alongside the `CREATE TABLE update_runs`.
- **Fix:** Accepted the drizzle-kit output as-is. Editing the migration by hand would mean an un-reproducible schema state. Plan 07-01 requires committing whatever `db:generate` produces from the locked schema.
- **Impact:** Zero — the column was already removed from Phase 6's schema; this just catches the dev DB up. Production will apply both statements cleanly on first `drizzle-kit migrate`.
- **Files modified:** `drizzle/0001_nappy_stepford_cuckoos.sql` (generated)
- **Verification:** `sqlite3 data/charging-master.db '.schema update_runs'` returns the expected table; `.schema plugs` no longer shows `mqtt_topic_prefix`.
- **Committed in:** `e89436d`

**2. [Rule 3 - Blocking] Committed previously-untracked 0000 baseline migration**

- **Found during:** Task 2 staging
- **Issue:** Task 1 removed `drizzle/` from `.gitignore`, which exposed the pre-existing `drizzle/0000_wide_screwball.sql` + `drizzle/meta/0000_snapshot.json` as untracked. Leaving them untracked would mean the migration chain starts from 0001 in git history but 0000 exists on disk — a broken audit trail.
- **Fix:** Staged both 0000 files alongside the 0001 files so the migration chain is complete in git.
- **Files modified:** `drizzle/0000_wide_screwball.sql`, `drizzle/meta/0000_snapshot.json` (added to git)
- **Committed in:** `e89436d`

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking/scope).
**Impact on plan:** Both deviations are mechanical consequences of applying the plan verbatim in a repo that had pre-existing drift. No scope creep, no decision changes.

## Issues Encountered

- `pnpm tsc --noEmit` surfaced 6 errors in `.next/types/app/api/mqtt/{status,test}/route.ts` and `.next/types/validator.ts` referencing deleted Phase 6 MQTT routes. Root cause: stale `.next/` build cache from before Phase 6 removed those routes. Per plan scope boundary (only auto-fix issues directly caused by current task), logged to `.planning/phases/07-version-foundation-state-persistence/deferred-items.md` rather than fixed here. The plan's verify command explicitly filters out errors touching anything other than `self-update` and `version.ts`, and that filtered check passes cleanly.

## Must-Haves Satisfied

Quoting the `must_haves.truths` from the plan frontmatter:

- ✅ "Running `pnpm gen:version` regenerates src/lib/version.ts with CURRENT_SHA, CURRENT_SHA_SHORT (7 chars), BUILD_TIME (ISO)" — verified via `grep -qE 'CURRENT_SHA_SHORT = "[a-f0-9]{7}"' src/lib/version.ts`.
- ✅ "src/lib/version.ts is git-ignored (never committed)" — `git ls-files src/lib/version.ts` returns 0 entries.
- ✅ "`pnpm dev` and `pnpm build` both run gen:version before their main command" — `grep -E '"(dev|build)":' package.json` shows both chained.
- ✅ "Drizzle schema exports updateRuns table matching the locked shape (status enum, fromSha/toSha, stages, error_message, rollback_stage)" — `src/db/schema.ts` lines appended verbatim from CONTEXT.md locked shape.
- ✅ "A committed migration under drizzle/ creates the update_runs table" — `drizzle/0001_nappy_stepford_cuckoos.sql` tracked.
- ✅ "UpdateStateStore can read() and write(patch) state.json atomically via tmp-file + rename" — `renameSync(TMP_FILE, STATE_FILE)` in `writeAtomic`.
- ✅ "UpdateStateStore.init() creates .update-state/state.json with default record when missing, never overwrites an existing file" — `if (!existsSync(STATE_FILE))` guard in `init()`.

## Interfaces Exported for Downstream Plans

| Symbol | File | Consumer |
|---|---|---|
| `CURRENT_SHA`, `CURRENT_SHA_SHORT`, `BUILD_TIME` | `@/lib/version` | 07-02 `/api/version` route, `<VersionBadge />`; 08 GitHub poller; 10 reconnect UI |
| `UpdateState`, `UpdateStatus`, `LastCheckResult` | `@/modules/self-update/types` | 07-02, 08, 09, 10 (all self-update consumers) |
| `DEFAULT_UPDATE_STATE` | `@/modules/self-update/types` | 07-02 `UpdateStateStore.init()` integration in server.ts |
| `UpdateStateStore` | `@/modules/self-update/update-state-store` | 07-02 (server.ts boot wiring); 08 (poller persists ETag); 09 (bash script reads/writes); 10 (UI reads rollback banner) |
| `updateRuns`, `UpdateRunRow`, `NewUpdateRunRow` | `@/db/schema` | 09 (updater pipeline logs runs); 10 (UI queries audit history) |

## User Setup Required

None — this plan changes only build plumbing, database schema, and internal module code. No environment variables, no external services, no credentials.

## Next Phase Readiness

**Ready for plan 07-02:**
- `CURRENT_SHA`, `CURRENT_SHA_SHORT`, `BUILD_TIME` are importable from `@/lib/version`.
- `UpdateStateStore.init()` is a one-liner to add to `server.ts` `main()`.
- `updateRuns` table exists in the dev DB for 07-02 queries.
- No blockers.

**Ready for Phase 8 (GitHub polling):**
- `lastCheckAt`, `lastCheckEtag`, `lastCheckResult` fields on `UpdateState` already match Phase 8's needs.

**Ready for Phase 9 (updater pipeline):**
- The bash updater script can read `.update-state/state.json` as plain JSON — same shape this plan defined.
- `updateRuns` table ready for run audit logging.

## Self-Check: PASSED

All 7 claimed files exist on disk. All 3 task commits (`fad685f`, `e89436d`, `f1acdbb`) exist in git history. All 7 phase-level verification checks pass (gen:version idempotent, version.ts git-ignored, 0001 migration tracked, package.json chains correct, update_runs in sqlite, no NEXT_PUBLIC_COMMIT_SHA references).

---
*Phase: 07-version-foundation-state-persistence*
*Completed: 2026-04-10*
