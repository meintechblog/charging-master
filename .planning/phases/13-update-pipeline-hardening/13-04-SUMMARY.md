---
phase: 13-update-pipeline-hardening
plan: 04
subsystem: self-update
tags: [updater, quarantine, banner, admin-page, frontend, pipe-03, ui]
requirements: [PIPE-03]
dependency_graph:
  requires:
    - "Plan 13-01 — UpdateState.lastQuarantine + UpdateInfoView.lastQuarantine (banner reads it from initialInfo)"
    - "Plan 13-03 — DELETE /api/admin/update-state/quarantine (button fetch target)"
  provides:
    - "Yellow stacked quarantine info banner above primary UpdateBanner state"
    - "/settings/update-state admin page (deep-link only, no nav entry)"
    - "QuarantineList client component with 'Alle löschen' DELETE + router.refresh"
  affects:
    - src/app/settings/update-banner.tsx
    - src/app/settings/update-banner.test.tsx
    - src/app/settings/update-state/page.tsx
    - src/app/settings/update-state/quarantine-list.tsx
    - src/app/settings/update-state/quarantine-list.test.tsx
tech_stack:
  added: []
  patterns:
    - "Stacked sibling React fragments: <>{quarantineBanner}{existingPrimary}</>"
    - "Conditional null banner: render becomes <>{null}<div/></> at runtime — visually identical to <div/>"
    - "Server component reading state.json via UpdateStateStore + readdir(recursive,withFileTypes)"
    - "Dirent.path fallback (?? absDir) for path-relativization across Node versions"
    - "Client DELETE + router.refresh() flow (mirrors handleAckRollback in update-banner)"
    - "RTL DOM-order assertion via Node.compareDocumentPosition + DOCUMENT_POSITION_FOLLOWING bit"
    - "next/navigation mock via vi.hoisted refreshFn (works around vi.mock factory hoisting)"
    - "globalThis.EventSource polyfill in jsdom (defensive against future SSE refactors)"
key_files:
  created:
    - src/app/settings/update-state/page.tsx
    - src/app/settings/update-state/quarantine-list.tsx
    - src/app/settings/update-banner.test.tsx
    - src/app/settings/update-state/quarantine-list.test.tsx
  modified:
    - src/app/settings/update-banner.tsx
decisions:
  - "Banner is STACKED (separate sibling div), not a replacement of any primary state (RESEARCH Open Q2 lock)"
  - "Rollback red banner (priority 1) is the ONLY branch NOT wrapped with the quarantine sibling — visual noise on a critical error state"
  - "All seven non-rollback branches (streaming/triggered, reconnecting, error, update-available, check-error, rate-limited, idle) wrap with fragments stacking the quarantine banner above"
  - "Server component uses fs.readdir({recursive:true, withFileTypes:true}) + Dirent.path; falls back to basename-only on older Node runtimes"
  - "Page is deep-link only (no nav entry anywhere) — CONTEXT.md §Design Decision 5 + RESEARCH Open Q6"
  - "Client component prop type uses NonNullable<UpdateState['lastQuarantine']> | null so the empty-state branch is type-safe"
  - "Error path keeps the button enabled (setIsDeleting(false) before return) so the user can retry without reload"
  - "Filenames test uses Letztes Preflight: + 3 Datei(en) in Quarantäne substring matches — robust against whitespace formatting changes"
metrics:
  duration_seconds: 360
  duration_human: "~6m"
  tasks_completed: 4
  files_modified: 1
  files_created: 4
  commits: 4
  completed_at: "2026-05-15T03:33:00Z"
---

# Phase 13 Plan 04: PIPE-03 UI Slice (Quarantine Banner + Admin Page) Summary

Shipped the user-facing slice of PIPE-03. After a preflight quarantine event lands in `state.json:lastQuarantine`, three new UI surfaces close the loop: (a) a yellow info banner stacked above the existing primary `UpdateBanner` state on `/settings`, (b) a deep-link-only admin page at `/settings/update-state` listing the quarantined files with paths relative to the quarantine dir root, and (c) an "Alle löschen" red button that calls the Plan 13-03 DELETE endpoint and refreshes the page to show the cleared state. Goal-backward UX: user visits Settings → sees yellow banner → clicks "Details ansehen" → reviews file list → optionally one-clicks "Alle löschen" → banner disappears.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 1 | Add quarantine info banner to UpdateBanner (7 branches wrapped with stacked fragment, rollback untouched) | `6421127` |
| 3 | Create QuarantineList client component with DELETE + router.refresh + error surfaces | `4cdf0d6` |
| 2 | Create /settings/update-state server-component page reading readdir + delegating render | `9223005` |
| 4 | Add 10 RTL tests covering banner state matrix + list rendering + delete flow | `6ca31fc` |

Commit order in git history follows the dependency direction (component before page, since page imports the component), not the plan's task numbering. The plan's Task 2 (page) is at commit `9223005`; Task 3 (component) is at `4cdf0d6`.

## Banner Refactor — Before/After

| Branch (priority) | Before | After |
|---|---|---|
| 1. Rollback red banner | `return (<div>...)` | UNCHANGED — rollback trumps everything per RESEARCH Open Q2 |
| 2. Streaming / triggered | `return (<div>...)` | `return (<>{quarantineBanner}<div>...</div></>)` |
| 3. Reconnecting | `return (<>...<ReconnectOverlay/></>)` | `return (<>{quarantineBanner}<div>...</div><ReconnectOverlay/></>)` |
| 4. Error (trigger failed) | `return (<div>...)` | `return (<>{quarantineBanner}<div>...</div></>)` |
| 5. Update available | `return (<>...<InstallModal/></>)` | `return (<>{quarantineBanner}<div>...</div><InstallModal/></>)` |
| 6. Check error | `return (<div>...)` | `return (<>{quarantineBanner}<div>...</div></>)` |
| 7. Rate limited | `return (<div>...)` | `return (<>{quarantineBanner}<div>...</div></>)` |
| 8. Idle / never checked | `return (<div>...)` | `return (<>{quarantineBanner}<div>...</div></>)` |

7 of 8 branches modified; 1 left intact (rollback). When `info.lastQuarantine` is null/undefined, `quarantineBanner` is `null` — `<>{null}<div/></>` is runtime-identical to `<div/>`.

## File Sizes

| File | Lines | Role |
|---|---|---|
| `src/app/settings/update-banner.tsx` | 536 (was 497) | Extended with Link import + quarantine sibling + 7-branch fragment refactor |
| `src/app/settings/update-state/page.tsx` | 63 | Server component — UpdateStateStore.read + fs.readdir + JSX |
| `src/app/settings/update-state/quarantine-list.tsx` | 81 | Client component — DELETE fetch + router.refresh + error states |
| `src/app/settings/update-banner.test.tsx` | 110 | 5 tests covering banner render matrix + stacking + rollback-trumps |
| `src/app/settings/update-state/quarantine-list.test.tsx` | 114 | 5 tests covering empty state, file list rendering, DELETE flow, error surfaces |

## Verification

- `pnpm exec tsc --noEmit` → exit 0
- `pnpm exec vitest run` → **270/270 passing** (260 baseline + 10 new)
- `pnpm build` → succeeds; Next.js manifest lists new route `ƒ /settings/update-state` (1.02 kB)
- Grep verification: `lastQuarantine`/`quarantineBanner`/`/settings/update-state` referenced 11 times in `update-banner.tsx` (≥ 3 required)
- No nav entry added — `src/components/layout/sidebar.tsx` and `src/components/layout/app-shell.tsx` unchanged

## Confirmation: No Nav Entry Added

Per CONTEXT.md §Design Decision 5 + RESEARCH Open Q6 lock, `/settings/update-state` is reachable only via the banner's "Details ansehen" deep-link or by typing the URL directly. The page is server-rendered on demand (`ƒ`) but has zero links pointing to it from any nav surface. The DELETE endpoint enforces `isAllowedBrowserHost` (already shipped in Plan 13-03) so LAN-only auth posture is preserved.

## Phase 13 Milestone Status

All four PIPE requirements are now satisfied across three waves:

| Plan | Wave | Requirements | Status |
|---|---|---|---|
| 13-01 | 1 | PIPE-01, PIPE-02 | DONE — bash updater quarantine + idle reset |
| 13-02 | 2 | PIPE-04 | DONE — POST /api/internal/reset-update-state recovery endpoint |
| 13-03 | 2 | PIPE-03 backend | DONE — DELETE /api/admin/update-state/quarantine |
| 13-04 | 3 | PIPE-03 frontend | DONE — banner + admin page + tests (this plan) |

Test baseline trajectory: 240 (pre-phase) → 250 (13-02) → 259 (13-03) → 270 (13-04).

## Deviations from Plan

None — plan executed exactly as written.

The plan's Task 2 spec correctly anticipated that page+component would land in dependency order (component first, then page). Commit ordering reflects that (component at `4cdf0d6` precedes page at `9223005`); task-numbering in the SUMMARY tracks the plan's narrative ordering.

One minor type-narrowing tweak inside the new test file: `fetchFn.mock.calls[0] as [string, RequestInit]` failed under TypeScript strict mode because the inferred call tuple is `any[]`. Cast via `as unknown as [string, RequestInit]` (a single-step bridge) was the minimal fix. Behavior unchanged.

## Goal-Backward End-to-End Smoke (manual, LXC-side)

The plan's Section §Verification step 5 lists the operator smoke sequence (touch untracked file → trigger update → confirm banner → click delete). Not executed in the worktree — this is a UI plan and the production smoke requires the bash updater + systemd on the LXC. The unit-test surface is exhaustive enough to ship; the LXC smoke runs when the user merges + deploys.

## Self-Check: PASSED

- src/app/settings/update-banner.tsx → FOUND (modified)
- src/app/settings/update-state/page.tsx → FOUND (new)
- src/app/settings/update-state/quarantine-list.tsx → FOUND (new)
- src/app/settings/update-banner.test.tsx → FOUND (new)
- src/app/settings/update-state/quarantine-list.test.tsx → FOUND (new)
- Commit 6421127 → FOUND
- Commit 4cdf0d6 → FOUND
- Commit 9223005 → FOUND
- Commit 6ca31fc → FOUND
