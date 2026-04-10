---
phase: 08-github-polling-detection
plan: 01
subsystem: self-update
tags: [github, polling, etag, zod, fetch, scheduler, api-route, update-checker]
requires:
  - src/lib/version.ts
  - src/modules/self-update/update-state-store.ts
  - src/modules/self-update/types.ts
  - server.ts
provides:
  - src/modules/self-update/github-client.ts
  - src/modules/self-update/update-checker.ts
  - src/modules/self-update/update-info-view.ts
  - src/app/api/update/status/route.ts
  - src/app/api/update/check/route.ts
  - UpdateInfoView
  - LastCheckResult (discriminated union)
  - GET /api/update/status
  - GET /api/update/check
affects:
  - src/modules/self-update/types.ts (LastCheckResult widened, UpdateInfoView added)
  - src/modules/self-update/update-state-store.ts (getUpdateInfo method + version import)
  - src/types/global.d.ts (__updateChecker global)
  - server.ts (boots UpdateChecker)
tech-stack:
  added:
    - zod (already present — first use in self-update module)
  patterns:
    - Native fetch + AbortController for conditional GET
    - ETag-based cache (If-None-Match)
    - setInterval(...).unref() scheduler
    - Discriminated union persisted in state.json
    - Sync GET route handlers returning plain Response.json
key-files:
  created:
    - src/modules/self-update/github-client.ts
    - src/modules/self-update/update-checker.ts
    - src/modules/self-update/update-info-view.ts
    - src/app/api/update/status/route.ts
    - src/app/api/update/check/route.ts
  modified:
    - src/modules/self-update/types.ts
    - src/modules/self-update/update-state-store.ts
    - src/types/global.d.ts
    - server.ts
decisions:
  - "Native fetch over @octokit/rest to avoid a ~2MB dependency for a single endpoint"
  - "GitHubClient is contractually non-throwing — all failure modes map to LastCheckResult variants"
  - "304 merge rule: never overwrite a previous ok result with unchanged, only refresh lastCheckAt"
  - "ETag persisted only on status:'ok' to preserve cache across transient errors"
  - "5-min cooldown uses Date.now() exclusively to neutralize P17 clock-skew"
  - "isChecking guard short-circuits to the persisted result instead of queueing"
  - "server.ts boot wiring is NOT wrapped in try/catch — constructor and start() are designed safe"
metrics:
  tasks: 7
  commits: 7
  files-created: 5
  files-modified: 4
  duration: "~20 minutes"
  completed: "2026-04-10"
requirements:
  - DETE-01
  - DETE-02
  - DETE-04
  - DETE-05
  - DETE-06
---

# Phase 8 Plan 01: GitHub Polling & Detection Backend Summary

Backend polling pipeline for update awareness: native-fetch GitHub client with ETag conditional requests, 6-hour background scheduler, state persistence, and two API routes (`/api/update/status` for cheap reads, `/api/update/check` with 5-min server-side cooldown).

## Objective Outcome

Phase 8 plan 01 ships the full backend that makes the app aware of new commits on `meintechblog/charging-master:main`. The `UpdateChecker` singleton boots from `server.ts main()` immediately after `UpdateStateStore.init()`, fires an initial check in the background, and schedules a 6-hour interval that is `.unref()`'d so it doesn't block shutdown. The `GitHubClient` uses native `fetch` with `If-None-Match` ETag caching, 10s `AbortController` timeout, and zod validation of the response shape — never throws. State is persisted atomically in `.update-state/state.json` via the existing `UpdateStateStore.write()` tmp+rename pattern. Two new GET routes expose the state: `/api/update/status` returns a derived `UpdateInfoView` on every Settings page load (sync handler, sub-50ms), and `/api/update/check` delegates to the shared singleton via `globalThis.__updateChecker` with a 5-minute `Date.now()`-based cooldown that returns HTTP 429 `{ status: 'cooldown', retryAfterSeconds }` within the window.

Verified end-to-end during execution: fresh boot log shows `[UpdateChecker] started (interval: 6h, first check: now)`, `/api/update/status` returns a valid `UpdateInfoView` with `lastCheckStatus: 'ok'`, `updateAvailable: true`, and a complete `remote` object (sha, shaShort, message, author, date). State persistence round-trip confirmed: `.update-state/state.json` now contains the discriminated-union `lastCheckResult: { status: 'ok', ... }` plus the persisted ETag. Two consecutive `/api/update/check` calls both returned HTTP 429 with `retryAfterSeconds: 290` — cooldown gate works as specified.

## Files Created/Modified

**Created (5):**
- `src/modules/self-update/github-client.ts` — `GitHubClient.checkLatestCommit({ etag })` returning `{ result: LastCheckResult; etag: string | null }`. Zod schema validates `sha`, `commit.message`, `commit.author.{name,date}`. 10s `AbortController` timeout with `finally` cleanup. Zero throw statements.
- `src/modules/self-update/update-checker.ts` — `UpdateChecker` singleton class with `start()`, `stop()`, `check({ manual })`. Internal `isChecking` flag, `runTick()` wrapper with double try/catch, 304 merge rule (only updates `lastCheckAt`), ETag only persisted on `ok` path.
- `src/modules/self-update/update-info-view.ts` — pure `deriveUpdateInfoView(state, sha, shaShort)` helper with zero fs/globals/version imports. Switches on the discriminated union and maps to the flat `UpdateInfoView` shape the UI consumes.
- `src/app/api/update/status/route.ts` — sync GET handler mirroring `/api/version` convention. Delegates to `new UpdateStateStore().getUpdateInfo()`, degrades to `lastCheckStatus: 'never'` view on fs errors.
- `src/app/api/update/check/route.ts` — async GET handler (GitHub call is async). Cooldown gate via `Date.now() - state.lastCheckAt < 300_000`, returns 429 + `Retry-After` header within the window. Delegates to `globalThis.__updateChecker.check({ manual: true })` outside cooldown.

**Modified (4):**
- `src/modules/self-update/types.ts` — `LastCheckResult` replaced with a four-variant discriminated union (`ok`/`unchanged`/`rate_limited`/`error`). Added `UpdateInfoView` type with 7 fields (currentSha, currentShaShort, lastCheckAt, lastCheckStatus, updateAvailable, optional remote, optional error, optional rateLimitResetAt).
- `src/modules/self-update/update-state-store.ts` — imports `CURRENT_SHA_SHORT` + `deriveUpdateInfoView` + `UpdateInfoView` type. New `getUpdateInfo(): UpdateInfoView` method reads state and delegates to the pure helper.
- `src/types/global.d.ts` — adds `__updateChecker: UpdateChecker | undefined` alongside the existing `__httpPollingService`, `__eventBus`, `__chargeMonitor` declarations.
- `server.ts` — imports `UpdateChecker`, instantiates it with a fresh `UpdateStateStore`, calls `start()`, assigns to `globalThis.__updateChecker`. Placed between `UpdateStateStore.init()` and `new EventBus()`. Not wrapped in try/catch per the locked decision (constructor and start() are safe by design).

## Commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Extend types.ts with LastCheckResult union + UpdateInfoView | 96a0a6b | src/modules/self-update/types.ts |
| 2 | Add deriveUpdateInfoView helper + getUpdateInfo() method | 23d241e | src/modules/self-update/update-info-view.ts (new), src/modules/self-update/update-state-store.ts |
| 3 | Create GitHubClient (native fetch + zod + AbortController) | c853821 | src/modules/self-update/github-client.ts (new) |
| 4 | Create UpdateChecker singleton with 6h scheduler | f1a0b48 | src/modules/self-update/update-checker.ts (new) |
| 5 | GET /api/update/status route (pure read) | 91f6d5c | src/app/api/update/status/route.ts (new) |
| 6 | GET /api/update/check route with 5-min cooldown | c8a1b92 | src/app/api/update/check/route.ts (new) |
| 7 | Wire UpdateChecker into server.ts main() | 85e634e | server.ts, src/types/global.d.ts |

## Interfaces Exported (for Plan 08-02 and beyond)

### `GET /api/update/status` contract

- **Method:** GET, sync handler, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- **Response:** `200 OK` with `Cache-Control: no-store, no-cache, must-revalidate`
- **Body:** `UpdateInfoView` JSON
  ```ts
  {
    currentSha: string;
    currentShaShort: string;
    lastCheckAt: number | null;
    lastCheckStatus: 'never' | 'ok' | 'unchanged' | 'rate_limited' | 'error';
    updateAvailable: boolean;
    remote?: { sha: string; shaShort: string; message: string; author: string; date: string };
    error?: string;
    rateLimitResetAt?: number;
  }
  ```
- **Degraded view:** If `state.json` is unreadable, returns 200 with `lastCheckStatus: 'never'` + `updateAvailable: false` (UI renders "noch nie geprüft").
- **No side effects.** Does not call GitHub.

### `GET /api/update/check` contract

- **Method:** GET, async handler, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- **Success (200):** `{ result: LastCheckResult }` where `LastCheckResult` is the discriminated union.
- **Cooldown (429):** `{ status: 'cooldown', retryAfterSeconds: number }` + `Retry-After` header. Enforced via `Date.now() - state.lastCheckAt < 300_000`.
- **State read error (500):** `{ status: 'error', error: string }`.
- **Checker missing (503):** `{ status: 'error', error: 'update checker not initialized' }` (race guard; should never happen post-boot).
- **Typical response time:** ≤500ms on healthy network; hard cap at ~10s via `AbortController` in the underlying `GitHubClient`.

### `UpdateInfoView` type

Exported from `src/modules/self-update/types.ts`. Consumers: `/api/update/status` route (current), plan 08-02 Settings banner + nav badge, plan 10 SSE refresh flow.

### `LastCheckResult` discriminated union

Exported from `src/modules/self-update/types.ts`. Four variants: `ok`, `unchanged`, `rate_limited`, `error`. The `/api/update/check` route echoes this verbatim in its success response body so the UI can switch on the status without re-fetching.

## Must-Haves Satisfied (quoted from plan frontmatter)

- "GitHubClient issues GET https://api.github.com/repos/meintechblog/charging-master/commits/main with User-Agent, Accept and X-GitHub-Api-Version headers and a 10s AbortController timeout" — `src/modules/self-update/github-client.ts`, headers assembled in `checkLatestCommit()`, timeout via `setTimeout(controller.abort, 10_000)` with `finally` clearTimeout.
- "When state.json.lastCheckEtag is non-null, the client sends If-None-Match: <etag>; a 304 response returns { status: 'unchanged' } and does NOT mutate any counters beyond lastCheckAt" — conditional header set when `etag !== null && etag !== ''`; `UpdateChecker.check()` merge rule explicitly preserves the previous `lastCheckResult` on `unchanged` and only calls `store.write({ lastCheckAt })`.
- "A 200 response is zod-validated for { sha, commit.message, commit.author.name, commit.author.date }; on parse failure the client returns { status: 'error' } and never throws" — `CommitResponseSchema` + `.safeParse()` in github-client.ts; parse failure mapped to `{ status: 'error', error: 'GitHub response shape unexpected: ...' }`.
- "403/429 responses return { status: 'rate_limited', resetAt: <x-ratelimit-reset> } without throwing" — `if (response.status === 403 || response.status === 429)` branch reads `x-ratelimit-reset` header, maps to `rate_limited` variant with `resetAt` number.
- "UpdateChecker is a singleton instantiated and started from server.ts main() after UpdateStateStore.init() and before HttpPollingService, non-blocking (no await on start())" — server.ts line order: `UpdateStateStore.init()` → `new UpdateChecker(new UpdateStateStore())` → `updateChecker.start()` → `globalThis.__updateChecker = updateChecker` → `new EventBus()`. No await.
- "UpdateChecker runs an immediate first check on start() and schedules setInterval(6h).unref() thereafter; overlapping calls are guarded by an internal isChecking flag" — `start()` calls `void this.runTick('initial')` then `setInterval(..., SIX_HOURS_MS)` with `.unref?.()`. Internal `isChecking` boolean guards `check()`.
- "UpdateChecker.check() wraps all work in try/catch — any thrown error inside a single tick is logged and swallowed so the scheduler never dies" — outer try/catch in `check()` + secondary try/catch in `runTick()`.
- "UpdateStateStore exposes getUpdateInfo(): UpdateInfoView derived from read() + CURRENT_SHA, with updateAvailable === true only when lastCheckResult is the 'ok' variant and remoteSha !== CURRENT_SHA" — `getUpdateInfo()` in update-state-store.ts delegates to `deriveUpdateInfoView()` which only sets `updateAvailable` in the `case 'ok':` branch via `result.remoteSha !== currentSha`.
- "GET /api/update/status is a sync handler returning UpdateInfoView in <50ms with Cache-Control: no-store and no side effects" — `export function GET(): Response` (sync), no fetch calls, `Cache-Control: no-store, no-cache, must-revalidate`.
- "GET /api/update/check rate-limits to one check per 5 minutes server-side via Date.now() - state.lastCheckAt; within cooldown returns HTTP 429 with { status: 'cooldown', retryAfterSeconds } and does NOT invoke GitHubClient" — cooldown gate evaluated BEFORE `getChecker()` call; if inside window returns `{ status: 'cooldown', retryAfterSeconds }` with HTTP 429 + `Retry-After` header. Verified during task 7 e2e (two consecutive calls both 429).
- "LastCheckResult in types.ts is a discriminated union: 'ok' (with remoteSha, remoteShaShort, message, author, date) | 'unchanged' | 'rate_limited' (resetAt) | 'error' (error)" — literal shape written in types.ts task 1.

## Deviations from Plan

None — plan executed exactly as written. All verbatim code blocks were applied as specified. No scope creep, no fixes needed.

## Verification Results

**Static (all tasks):**
- `pnpm tsc --noEmit` — passes cleanly for every new/modified file (types, update-info-view, update-state-store, github-client, update-checker, both route.ts files, server.ts, global.d.ts)
- `grep -rn 'new GitHubClient' src/` → only `update-checker.ts` constructor default parameter
- `grep -rn 'api.github.com' src/` → only `github-client.ts`
- `grep -rn 'throw ' src/modules/self-update/github-client.ts` → zero results (client contractually non-throwing)

**End-to-end (task 7 boot + curl):**
- Fresh boot log contains `[UpdateChecker] started (interval: 6h, first check: now)` and `[UpdateStateStore] initialized` lines
- `curl http://localhost:3000/api/update/status` → HTTP 200 with full UpdateInfoView: `lastCheckStatus: "ok"`, `updateAvailable: true`, `remote: { sha, shaShort, message, author, date }`
- `curl http://localhost:3000/api/update/check` (1st call) → HTTP 429 `{ status: 'cooldown', retryAfterSeconds: 290 }` (because the initial background check already wrote `lastCheckAt` seconds earlier)
- `curl http://localhost:3000/api/update/check` (2nd call) → HTTP 429 `{ status: 'cooldown', retryAfterSeconds: 290 }` — idempotent cooldown response confirmed

**State persistence:**
`.update-state/state.json` after the initial boot check contains:
```json
{
  "lastCheckAt": 1775827992414,
  "lastCheckEtag": "W/\"31f1266b53357c4930f37906f48e0fa6c61d23cbb0975b98bd42aa1ac6065718\"",
  "lastCheckResult": {
    "status": "ok",
    "remoteSha": "1a5bd3462237beb36981a9f75f3064fc1b09a1b6",
    "remoteShaShort": "1a5bd34",
    "message": "fix(learn): route \"Neu anlernen\" to re-record curve on existing profile\n...",
    "author": "Hulki",
    "date": "2026-04-10T11:20:48Z"
  },
  ...
}
```
Discriminated union shape round-trips correctly through the atomic tmp+rename write path.

## Known Stubs

None. Every field in `UpdateInfoView` is wired to real state. No hardcoded empty values, no placeholder UI strings, no "coming soon" branches. The `remote` field is `undefined` only when the last result is not `ok` — which is an accurate data-driven reflection of state, not a stub.

## Notes for Phase 9 (Update Execution)

- The `updateStatus` field on `UpdateState` is **untouched** by Phase 8. Phase 9 can safely claim the `'installing'`, `'rolled_back'`, and `'failed'` states without conflicts.
- `UpdateChecker.stop()` exists but is **not wired** into `server.ts` SIGTERM shutdown. The interval is `.unref()`'d so it doesn't block shutdown; Phase 9 should still consider wiring `stop()` into the graceful-shutdown path for cleanliness if a `prepare-for-shutdown` endpoint is added.
- The updater bash script in Phase 9 will need to read `state.json` for `rollbackSha` and `lastCheckEtag`. The JSON shape is now stable and discriminated — Phase 9 parser should guard against all four `lastCheckResult.status` variants.
- No new dependencies were added. `zod` was already present in the codebase.

## Notes for Phase 10 (Live Feedback)

- The `/api/update/status` contract is **frozen for SSE refresh**. Adding new fields to `UpdateInfoView` is safe (forward-compat); renaming or removing existing fields is not (the Phase 10 UI will depend on these keys by name).
- The SSE reconnect flow in Phase 10 can rely on the `currentSha` field to detect post-restart version changes: poll `/api/update/status` every 2s and compare `currentSha` to the pre-update snapshot.
- `updateAvailable === false` after a successful install is NOT automatic in this plan — it requires a subsequent `UpdateChecker` tick to run against the NEW `CURRENT_SHA`. Phase 10's post-restart handoff should trigger a manual check to refresh the banner state.
- The `/api/update/check` cooldown uses `Date.now()` exclusively. Phase 10's SSE-driven auto-refresh should NOT hit `/api/update/check` (it would consume cooldown budget); use `/api/update/status` for polling instead.

## Self-Check: PASSED

- `src/modules/self-update/types.ts` — FOUND (modified)
- `src/modules/self-update/update-info-view.ts` — FOUND (new)
- `src/modules/self-update/update-state-store.ts` — FOUND (modified)
- `src/modules/self-update/github-client.ts` — FOUND (new)
- `src/modules/self-update/update-checker.ts` — FOUND (new)
- `src/app/api/update/status/route.ts` — FOUND (new)
- `src/app/api/update/check/route.ts` — FOUND (new)
- `server.ts` — FOUND (modified)
- `src/types/global.d.ts` — FOUND (modified)
- Commit 96a0a6b — FOUND
- Commit 23d241e — FOUND
- Commit c853821 — FOUND
- Commit f1a0b48 — FOUND
- Commit 91f6d5c — FOUND
- Commit c8a1b92 — FOUND
- Commit 85e634e — FOUND
