---
phase: 13-update-pipeline-hardening
plan: 02
subsystem: self-update
tags: [updater, recovery, host-guard, state-json, audit, pipe-04]
requirements: [PIPE-04]
dependency_graph:
  requires:
    - "13-01 (UpdateState.lastQuarantine field — confirms the spread-merge contract for the optional field this endpoint must preserve)"
  provides:
    - "POST /api/internal/reset-update-state — localhost-only emergency recovery endpoint (SSH-from-LXC curl)"
    - "updateRuns.status TypeScript enum widened with 'recovery_reset' (consumed downstream by /api/update/history serializer + UpdateHistory render)"
    - "UpdateHistory client component statusLabel branch for 'recovery_reset' (neutral-400 audit-event styling)"
  affects:
    - src/db/schema.ts
    - src/app/settings/update-history.tsx
    - src/app/api/internal/reset-update-state/route.ts
    - src/app/api/internal/reset-update-state/route.test.ts
tech_stack:
  added: []
  patterns:
    - "Inline localhost-only Host-header guard (verbatim from prepare-for-shutdown/route.ts:15 + 40-49). Deliberately NARROWER than @/lib/host-guard.isAllowedBrowserHost — admitting charging-master.local would let any LAN browser tab trigger recovery."
    - "Read-before-write order: store.read() captures pre-reset currentSha (the audit fromSha) BEFORE store.write() mutates state, so a write failure still has the original currentSha available — though here we hard-bail on read failure with 500."
    - "Audit-row insert via db.insert(updateRuns).values({...}).run() — better-sqlite3 synchronous insert, matches existing patterns at src/app/api/profiles/[id]/route.ts:254-258."
    - "Best-effort audit semantics: insert failure logged via console.warn but does NOT roll back the state reset. State reset is the load-bearing part — losing the audit row is preferable to leaving state.json stuck."
    - "Non-idempotent by design (per RESEARCH Pitfall 18 lock): every call inserts a new audit row, even if state was already idle. Same-state re-runs are cheap; audit trail > de-dup."
    - "vi.hoisted() pattern in the route test — exposes mock fns to vi.mock factories without ReferenceError under Vitest's mock-hoisting transform."
key_files:
  created:
    - src/app/api/internal/reset-update-state/route.ts
    - src/app/api/internal/reset-update-state/route.test.ts
  modified:
    - src/db/schema.ts
    - src/app/settings/update-history.tsx
decisions:
  - "INLINE localhost-only Host guard, NOT @/lib/host-guard.isAllowedBrowserHost — narrower allowlist is the entire security model for this endpoint (RESEARCH Pitfall 11 + PATTERNS Anti-pattern 4)"
  - "Enum widening is TypeScript-only — no .sql migration. Underlying SQLite column is plain text NOT NULL with no CHECK constraint (drizzle/0001_nappy_stepford_cuckoos.sql:7)"
  - "Audit row's fromSha = before.currentSha (the version that was running when recovery happened) per RESEARCH Pitfall D — NOT 'what we rolled back from'"
  - "Audit row's stage='recovery' as a distinctive marker — distinguishes from real pipeline stages ('preflight', 'snapshot', ..., 'verify')"
  - "statusLabel branch for 'recovery_reset' returns neutral-400 styling (not red/amber/green) — a manual reset is an audit event, not a success or failure"
  - "Test mocks 'updateRuns' as a string sentinel rather than threading the real Drizzle table object — keeps the test surface minimal and avoids importing better-sqlite3 native bindings in the test environment"
metrics:
  duration_seconds: 300
  duration_human: "~5m"
  tasks_completed: 3
  files_modified: 4
  commits: 3
  completed_at: "2026-05-15T03:21:06Z"
---

# Phase 13 Plan 02: PIPE-04 Recovery Endpoint Summary

Localhost-only emergency endpoint `POST /api/internal/reset-update-state` for when `state.json:updateStatus` is stuck on `'installing'` and no other mechanism (UI, on_error reset, normal pipeline completion) can clear it. The SSH-from-LXC operator runs `curl -X POST http://localhost/api/internal/reset-update-state`, gets 200 `{ok:true}`, and the next `POST /api/update/trigger` is no longer blocked by the 409 "already in progress" guard. A non-idempotent audit row in `update_runs` records every call.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 1 | Widen `updateRuns.status` enum + `UpdateRun.status` union with `'recovery_reset'` (TypeScript-only, neutral-400 statusLabel branch) | `9145827` |
| 2 | Create `POST /api/internal/reset-update-state` route — inline localhost-only host guard, state.json patch, audit row insert | `e884d54` |
| 3 | Vitest coverage — 10 cases (200 success path, 3x 403 paths, IPv6 bracket handling, audit failure non-fatal, read/write 500 paths) | `feb9803` |

## File Inventory

```
src/app/api/internal/reset-update-state/route.ts        144 lines (vs prepare-for-shutdown's 124 — the +20 lines are entirely JSDoc explaining the concurrency, audit, and security contract)
src/app/api/internal/reset-update-state/route.test.ts   236 lines
```

Structure of `route.ts` vs the `prepare-for-shutdown` prior-art template:

| Section | reset-update-state | prepare-for-shutdown |
|---------|--------------------|-----------------------|
| Imports | UpdateStateStore + db + updateRuns | sqlite (direct pragma access) |
| Route config (runtime + dynamic) | identical | identical |
| ALLOWED_HOSTS literal | `{'127.0.0.1','localhost','::1','[::1]'}` (verbatim) | same |
| NO_CACHE_HEADERS literal | `{'Cache-Control':'no-store, no-cache, must-revalidate'}` (verbatim) | same |
| `isLocalhostHost()` | verbatim copy of lines 40-49 | source |
| POST handler error shape | `{error:'forbidden'}` 403 | same |
| Business logic | read → write → audit-insert | drain pollers → WAL checkpoint |

Verbatim section count: 4 of 6 structural elements copied without modification, satisfying RESEARCH §References + PATTERNS §5/§9.

## Verification

### `pnpm exec tsc --noEmit` clean (exit 0)

### `pnpm exec vitest run` — 250/250 passing
```
Test Files  18 passed (18)
Tests       250 passed (250)
Duration    ~5s
```

(240 pre-existing baseline + 10 new — none of the 240 regressed.)

### `pnpm exec vitest run src/app/api/internal/reset-update-state/route.test.ts` — 10/10
```
Test Files  1 passed (1)
Tests       10 passed (10)
```

Case inventory:
1. localhost POST returns 200 `{ok:true}` (+ Cache-Control header verified)
2. state patch is exactly `{updateStatus:'idle', targetSha:null, updateStartedAt:null}` — no other keys leak in
3. audit row carries status='recovery_reset', stage='recovery', fromSha=pre-reset SHA, toSha=null, startAt+endAt are Date instances
4. Host `charging-master.local` → 403 `{error:'forbidden'}`, NO state write, NO audit
5. Host `evil.example.com` → 403, NO state write, NO audit
6. Missing/empty Host → 403, NO state write, NO audit
7. Host `[::1]:80` (IPv6 bracket) → 200, state written
8. Audit insert throw → still 200, state write succeeded, console.warn emitted
9. `store.read()` throw → 500 `{error:'state_read_failed', message}`, NO write, NO audit
10. `store.write()` throw → 500 `{error:'state_write_failed', message}`, NO audit

### Narrowing call-site audit
```bash
grep -rn "'running'\|'success'\|'failed'\|'rolled_back'" src/ --include="*.tsx" --include="*.ts" | grep -v "\.test\."
```
Confirmed only `src/app/settings/update-history.tsx:13` narrows on the `updateRuns.status` union. `update-stage-stepper.tsx` and `types.ts` narrow on unrelated unions (pipeline stage state machine and state.json `updateStatus`, respectively) — different domains, not affected.

### Static guarantee checks
```bash
$ grep -c "isLocalhostHost\|ALLOWED_HOSTS\|recovery_reset" src/app/api/internal/reset-update-state/route.ts
7
$ grep -n "isAllowedBrowserHost\|@/lib/host-guard" src/app/api/internal/reset-update-state/route.ts
(no matches — correctly INLINE, not host-guard.ts)
$ grep -c "recovery_reset" src/db/schema.ts src/app/settings/update-history.tsx
src/db/schema.ts:1
src/app/settings/update-history.tsx:2
```

### Curl smoke (not executed — no dev server running in this worktree)
The PLAN's optional manual smoke (`curl -sf -X POST http://localhost:3000/api/internal/reset-update-state -H 'Host: localhost'`) was deferred to the integrator's environment. Test coverage exercises the same contract (Host header dispatch + state patch + audit-row insert via mocks).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Vitest mock hoisting (`Cannot access 'insertFn' before initialization`)**
- **Found during:** Task 3 first test run.
- **Issue:** The plan's `vi.mock('@/db/client', () => ({ db: { insert: insertFn } }))` factory references `insertFn` which is declared as a top-level `const` BELOW the `vi.mock()` call. Vitest hoists `vi.mock` calls to the top of the file, so the factory runs before the `const` initializes — `ReferenceError`.
- **Fix:** Wrap the mock fns in a `vi.hoisted(() => {...})` block, then destructure them after the `vi.mock` calls. This is the documented Vitest pattern for this exact scenario.
- **Files modified:** `src/app/api/internal/reset-update-state/route.test.ts`
- **Commit:** `feb9803` (included in Task 3's commit, not a separate fix commit since the test never ran in a broken state — the fix landed before the first green build).

**2. [Rule 3 - Blocking] TypeScript strict-mode tuple narrowing on `mock.calls[0]`**
- **Found during:** Task 3 final `tsc --noEmit` pass.
- **Issue:** `vi.fn()` with no explicit signature gets typed as `Mock<() => ReturnType>`, so `mock.calls` is `[][]` (tuple of empty tuples). Reading `mock.calls[0]![0]` then errors with TS2493 "Tuple type '[]' has no element at index '0'".
- **Fix:** Explicit `vi.fn((..._args: unknown[]) => ...)` signatures for `insertValues` and `insertFn`; explicit `vi.fn<(...args: unknown[]) => unknown>()` generic args for `readFn` and `writeFn`. Now `mock.calls` is typed as `unknown[][]`.
- **Files modified:** `src/app/api/internal/reset-update-state/route.test.ts`
- **Commit:** `feb9803` (folded into Task 3 commit — file never landed in a state where tsc was red).

### Deferred / out-of-scope
None. All success criteria met within scope.

## Known Stubs
None. The endpoint is fully wired — no placeholder data, no "coming soon" branches.

## Threat Flags
None. The new endpoint is explicitly LOCALHOST-ONLY (narrower than the existing browser host-guard). It does NOT introduce new browser-reachable surface. The threat surface added is the SSH-from-LXC recovery path, which was already part of the operator's existing capability set (SSH access = root access = can edit state.json by hand anyway). The audit row makes the recovery action observable in `/api/update/history`, which is a security improvement.

## Self-Check: PASSED

- `[x]` `src/db/schema.ts` modified — contains `recovery_reset` in updateRuns enum tuple.
- `[x]` `src/app/settings/update-history.tsx` modified — contains `recovery_reset` in union AND statusLabel switch case.
- `[x]` `src/app/api/internal/reset-update-state/route.ts` created — uses inline `ALLOWED_HOSTS` Set, NOT `@/lib/host-guard`.
- `[x]` `src/app/api/internal/reset-update-state/route.test.ts` created — 10 passing cases.
- `[x]` Commit `9145827` present in `git log` (Task 1 — enum widening).
- `[x]` Commit `e884d54` present in `git log` (Task 2 — route handler).
- `[x]` Commit `feb9803` present in `git log` (Task 3 — vitest coverage).
- `[x]` `pnpm exec tsc --noEmit` exit 0.
- `[x]` `pnpm exec vitest run` 250/250.
- `[x]` STATE.md, ROADMAP.md, REQUIREMENTS.md unmodified.
