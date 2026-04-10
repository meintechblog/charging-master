---
phase: 08-github-polling-detection
plan: 02
subsystem: self-update
tags: [ui, settings, banner, sidebar, nav-badge, client-component, polling, intl]
requires:
  - src/modules/self-update/types.ts
  - src/modules/self-update/update-state-store.ts
  - src/app/api/update/status/route.ts
  - src/app/api/update/check/route.ts
  - src/app/settings/page.tsx
  - src/app/settings/version-badge.tsx
  - src/components/layout/sidebar.tsx
provides:
  - src/app/settings/update-banner.tsx
  - UpdateBanner client component
  - useUpdateAvailable() sidebar hook
  - red-dot update indicator on /settings nav entry
  - server-side initial UpdateInfoView fetch on /settings
affects:
  - src/app/settings/page.tsx (mounts UpdateBanner, server-side initial fetch)
  - src/components/layout/sidebar.tsx (adds useUpdateAvailable hook + red dot)
tech-stack:
  added: []
  patterns:
    - "RSC server-side fetch passed as initialInfo prop to client component (no loading flash)"
    - "Intl.RelativeTimeFormat('de') constructed at module scope"
    - "useEffect + AbortController + setInterval polling (matches existing useActiveLearnCount pattern)"
    - "State priority: updateAvailable > error > rate_limited > ok/never"
key-files:
  created:
    - src/app/settings/update-banner.tsx
  modified:
    - src/app/settings/page.tsx
    - src/components/layout/sidebar.tsx
decisions:
  - "Install button is NOT rendered at all in Phase 8 (CONTEXT.md explicit rule); placeholder comment in source documents the Phase 10 re-entry point"
  - "Initial UpdateInfoView fetched server-side via UpdateStateStore.getUpdateInfo() to eliminate loading flash on first paint"
  - "Sidebar dot is static (no pulse) to distinguish it from the existing green pulsing active-learn indicator — update-available is persistent state, not live process"
  - "60s poll cadence for sidebar hook (background checker runs every 6h, 60s is safe middle ground)"
  - "refreshInfo() after every manual check re-reads /api/update/status as authoritative source, since the 304 merge rule in plan 08-01 does not update lastCheckResult on 'unchanged'"
  - "State-priority render order: updateAvailable > error > rate_limited > ok/never — most important signal surfaces first"
metrics:
  tasks: 4
  commits: 3
  files-created: 1
  files-modified: 2
  duration: "~12 minutes"
  completed: "2026-04-10"
requirements:
  - DETE-03
  - DETE-05
  - DETE-06
---

# Phase 8 Plan 02: GitHub Polling & Detection UI Summary

Ships the Phase 8 UI: an `<UpdateBanner />` client component on the Settings page with five render states (update-available, error, rate-limited, ok, never), a manual "Jetzt prüfen" button that calls `/api/update/check` and handles 429 cooldown responses, and a red update-available dot on the Sidebar "Einstellungen" nav entry that polls `/api/update/status` every 60 seconds.

## Objective Outcome

The plan delivers the user-facing half of Phase 8. The backend routes from plan 08-01 (`/api/update/status` and `/api/update/check`) are now fully surfaced in the UI. On page load, `SettingsPage` runs a synchronous `new UpdateStateStore().getUpdateInfo()` call server-side and passes the resulting `UpdateInfoView` to `<UpdateBanner initialInfo={...} />` — eliminating any loading flash on first paint. The banner renders one of five states in priority order: update-available (green card with SHA, author, commit date, commit message), error (amber card), rate-limited (amber card with reset timestamp), ok (neutral line with relative last-check time), or never (prompt to click "Jetzt prüfen"). The manual check button fires `fetch('/api/update/check')`, flips the label to "Prüft..." during the in-flight request, handles the 429 cooldown response by rendering "Bitte N Sekunden warten" from the `retryAfterSeconds` payload, and re-fetches `/api/update/status` on completion so the banner reflects authoritative state (important for the 304 case where `lastCheckResult` is not updated). The Sidebar gets a new `useUpdateAvailable()` hook that mirrors the existing `useActiveLearnCount` pattern — `useEffect` + `AbortController` + 60s `setInterval` — and renders a static red dot on the Einstellungen `<Link>` when `updateAvailable === true`, with `aria-label` + `title` for accessibility.

End-to-end verified during execution against the live dev server at `http://localhost:3000`:
- `GET /api/update/status` → HTTP 200 with full `UpdateInfoView`, `updateAvailable: true`, `remote.shaShort: '1a5bd34'`
- `GET /settings` → HTTP 200 with HTML containing "Einstellungen" (x3: title + sidebar + tooltip), "Jetzt prüfen" (button), "Update verfügbar" (banner headline), `1a5bd34` (x3: remote SHA in banner, plus VersionBadge currentSha), and zero occurrences of "Installieren"
- TypeScript `pnpm tsc --noEmit` passes cleanly across the whole repo
- Dev server compile log shows `✓ Compiled /settings in 1239ms (826 modules)` with no errors
- The sidebar red dot appears after client-side hydration only (expected — the hook runs in `useEffect`); not present in SSR HTML

## Files Created/Modified

**Created (1):**
- `src/app/settings/update-banner.tsx` — Client component `UpdateBanner({ initialInfo })` with five render states. Module-scope `Intl.RelativeTimeFormat('de', { numeric: 'auto' })` and `Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' })`. Helper `formatRelative(epochMs)` returns "gerade eben" / "vor N Minuten" / "vor N Stunden" / "vor N Tagen". `handleCheck` → `fetch('/api/update/check', { cache: 'no-store' })` with try/catch/finally and `refreshInfo()` on completion. State priority: `updateAvailable && remote` → `error` → `rate_limited` → `ok/never`. Install button intentionally absent (comment block references CONTEXT.md and Phase 10 re-entry point).

**Modified (2):**
- `src/app/settings/page.tsx` — Adds `getInitialUpdateInfo()` helper (sync server-side `new UpdateStateStore().getUpdateInfo()` with degraded 'never' fallback), imports `<UpdateBanner />`, and mounts it between the header row and the Pushover `<SettingsSection>`. VersionBadge, header row, and Pushover section unchanged.
- `src/components/layout/sidebar.tsx` — Adds `useUpdateAvailable()` hook (identical shape to `useActiveLearnCount` with 60s cadence), calls it in `Sidebar()`, adds `showUpdateDot = item.href === '/settings' && updateAvailable` in the nav map, and renders a static `<span className="ml-auto inline-flex h-2 w-2 rounded-full bg-red-500" aria-label="Update verfügbar" title="Update verfügbar" />` inside the Einstellungen `<Link>`. Also adds `relative` to the Link className to leave room for a future absolute-positioned badge variant. Existing `useActiveLearnCount` hook and the green-pulse active-learning block at the bottom of the nav are untouched.

## Commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Create UpdateBanner client component with 5 render states | 52168de | src/app/settings/update-banner.tsx (new) |
| 2 | Mount UpdateBanner on Settings page with server-side initial state | 1306a82 | src/app/settings/page.tsx |
| 3 | Add update-available red dot to sidebar Einstellungen entry | 4a16137 | src/components/layout/sidebar.tsx |
| 4 | Visual verification checkpoint | pending | (human-verify — awaiting approval) |

## Interfaces Exported (for Phase 10 and beyond)

### `UpdateBanner` component
Exported from `src/app/settings/update-banner.tsx`. Props: `{ initialInfo: UpdateInfoView }`. Self-contained: manages `info`, `isChecking`, `cooldownSeconds`, `localError` as local state. Re-fetches `/api/update/status` on every check completion. Not currently imported anywhere outside `page.tsx`, but safe to reuse on any page that needs the banner.

### `useUpdateAvailable()` hook (private to sidebar.tsx)
Not exported — module-local to `sidebar.tsx`. If Phase 10 needs the same polling behavior elsewhere (e.g., a status bar), extract to `src/hooks/use-update-available.ts` at that time rather than duplicating.

### `getInitialUpdateInfo()` helper (private to page.tsx)
Module-local server-side helper. Wraps `new UpdateStateStore().getUpdateInfo()` with a try/catch that returns a degraded `'never'` view on fs failures. Phase 10's update-trigger flow can reuse the same pattern if new server components need UpdateInfoView.

### Banner render-state contract
Phase 10's SSE-refresh flow will re-use the banner by pushing fresh `UpdateInfoView` into `setInfo()`. The five-state priority order (`updateAvailable` > `error` > `rate_limited` > `ok/never`) is the SINGLE source of truth for visual priority — Phase 10 MUST NOT add a new state with higher priority without explicit design review.

## Must-Haves Satisfied (quoted from plan frontmatter)

- "Settings page renders a full-width UpdateBanner card above the existing VersionBadge header row, with the initial state fetched server-side so no loading flash occurs on first paint" — `page.tsx` calls `getInitialUpdateInfo()` synchronously in the async server component and passes the result as `initialInfo` to `<UpdateBanner />`. Banner mounts between the header row and the Pushover section inside the existing `space-y-6` container.
- "When updateAvailable === true, the banner shows the remote short SHA, commit message, author, and commit date from UpdateInfoView.remote" — `update-banner.tsx` STATE 1 renders `info.remote.shaShort`, `info.remote.author`, `formatCommitDate(info.remote.date)`, and `info.remote.message` (with `whitespace-pre-wrap break-words` to preserve line breaks).
- "When updateAvailable === false and lastCheckStatus === 'ok', the banner shows a discreet 'Du bist auf dem neuesten Stand' line with relative last-check time" — STATE 4 branch renders the German text + the `lastCheckLabel` built from `formatRelative(info.lastCheckAt)`.
- "When lastCheckStatus === 'error' or 'rate_limited', the banner shows a yellow warning with the error text and (for rate_limited) a resetAt timestamp" — STATE 2 and STATE 3 use `border-amber-500/30 bg-amber-500/5 text-amber-300` styling; rate_limited path appends the resetAt timestamp via `formatCommitDate(new Date(info.rateLimitResetAt * 1000).toISOString())`.
- "When lastCheckStatus === 'never', the banner shows 'Noch nicht geprüft' and the 'Jetzt prüfen' button" — STATE 5 branch renders the German text + the always-visible "Jetzt prüfen" button.
- "The 'Jetzt prüfen' button triggers fetch('/api/update/check') and shows a spinner state during the in-flight request" — `handleCheck` sets `isChecking: true`, calls `fetch('/api/update/check', { cache: 'no-store' })`, swaps the button label to "Prüft..." and adds `disabled` + `disabled:opacity-50`.
- "On HTTP 429 cooldown response, the button shows a yellow 'Bitte X Sekunden warten' message with the retryAfterSeconds from the response body" — `if (res.status === 429 && 'retryAfterSeconds' in data)` sets `cooldownSeconds`, which renders as `Bitte {cooldownSeconds} Sekunden warten` in `text-amber-300` below the button in every state.
- "Last check timestamp is rendered via Intl.RelativeTimeFormat in German (e.g., 'vor 2 Stunden')" — module-scope `RTF = new Intl.RelativeTimeFormat('de', { numeric: 'auto' })` used in `formatRelative()` to produce minute/hour/day strings; <45s special-cased to "gerade eben".
- "Sidebar nav entry for 'Einstellungen' shows a small red dot when updateAvailable === true, fetched from GET /api/update/status on mount and refreshed every 60s" — `useUpdateAvailable()` hook polls every 60s via `setInterval(check, 60000)` with `AbortController` cleanup; `showUpdateDot` conditional renders the `bg-red-500` span inside the Einstellungen `<Link>` only.
- "Install button is NOT rendered at all (Phase 10 adds it; rendering a dead button now is explicitly prohibited by CONTEXT.md)" — `grep "Installieren" src/app/settings/update-banner.tsx` returns 0 matches. A block comment in the STATE 1 render branch quotes CONTEXT.md and marks the Phase 10 re-entry point.

## Deviations from Plan

None — plan executed exactly as written. Three micro-adjustments to match the codebase:

1. **HTML-entity escape for double quotes in JSX text** — In STATE 5 ("Noch nicht geprüft") the literal string `Klicke auf "Jetzt prüfen"` was written with `&quot;` around "Jetzt prüfen" to satisfy `react/no-unescaped-entities` (matches `eslint-config-next` strict rules). No behavior change; the rendered DOM text is identical.
2. **Separate runs of verify command steps** — The plan's verify block combined `grep` + `tsc --noEmit` + `pnpm dev` + `curl` into one command chain. I split them across steps for clearer failure isolation; all checks ran and passed.
3. **Dev server process management** — Used `pnpm dev &` background + `pkill -f tsx` cleanup rather than the plan's inline `DEV_PID=$!` pattern, to work with the async tool execution model. Outcome identical.

None of these constitute code deviations — they are execution ergonomics.

## Verification Results

**Static (tasks 1-3):**
- `pnpm tsc --noEmit` — passes cleanly for all three files and the full repo (zero errors)
- `grep "'use client'" src/app/settings/update-banner.tsx` — present
- `grep "UpdateBanner" src/app/settings/update-banner.tsx` — export present
- `grep "initialInfo" src/app/settings/update-banner.tsx` — prop present
- `grep "Jetzt prüfen" src/app/settings/update-banner.tsx` — button label present
- `grep "Intl.RelativeTimeFormat" src/app/settings/update-banner.tsx` — German formatter present
- `grep "Installieren" src/app/settings/update-banner.tsx` — zero matches (intentional)
- `grep "useUpdateAvailable" src/components/layout/sidebar.tsx` — hook present
- `grep "/api/update/status" src/components/layout/sidebar.tsx` — fetch present
- `grep "bg-red-500" src/components/layout/sidebar.tsx` — dot styling present
- `grep "showUpdateDot" src/components/layout/sidebar.tsx` — conditional present
- `grep "setInterval(check, 60000)" src/components/layout/sidebar.tsx` — 60s cadence present
- `grep "UpdateBanner initialInfo=" src/app/settings/page.tsx` — mount point present

**End-to-end (dev server boot + curl):**
- Dev server boot log contains `[UpdateChecker] started (interval: 6h, first check: now)` and `Charging Master ready on http://0.0.0.0:3000`
- `GET /api/update/status` → HTTP 200 with full `UpdateInfoView`:
  ```json
  {
    "currentSha": "4a1613744f154d9faa68eecffeeb56718b90e924",
    "currentShaShort": "4a16137",
    "lastCheckAt": 1775828437204,
    "lastCheckStatus": "ok",
    "updateAvailable": true,
    "remote": { "sha": "1a5bd346...", "shaShort": "1a5bd34", "message": "fix(learn)...", "author": "Hulki", "date": "2026-04-10T11:20:48Z" }
  }
  ```
- `GET /settings` → HTTP 200, HTML contains: "Einstellungen" (x3), "Jetzt prüfen" (x1), "Update verfügbar" (x1), "1a5bd34" (x3), zero "Installieren"
- Dev server compile log: `✓ Compiled /api/update/status in 605ms (284 modules)` + `✓ Compiled /settings in 1239ms (826 modules)` with zero errors
- Sidebar red dot is NOT in the SSR HTML (expected — hook runs in `useEffect` on hydration). Visual verification in Task 4 (checkpoint) confirms hydration behavior.

## Task 4 Status

**Pending human verification.** Task 4 is a `checkpoint:human-verify` gate that cannot be automated — it requires visual confirmation of banner layout, colors, click flow, cooldown behavior, and sidebar dot rendering in a browser. See the checkpoint return message for the exact verification steps.

## Known Stubs

None. All five banner render states are wired to real `UpdateInfoView` data. The sidebar dot is a data-driven toggle, not a placeholder. The `refreshInfo()` callback after manual checks is fully wired. Install button is intentionally absent per CONTEXT.md — documented with an inline comment block referencing the Phase 10 re-entry point. No hardcoded empty arrays, no "coming soon" text, no mock data.

## Notes for Phase 10 (Live Feedback / Install Flow)

- **Install button re-entry point:** The comment block in `update-banner.tsx` STATE 1 branch marks exactly where the Install button should be added. Expected wiring: button → confirmation modal → `fetch('/api/update/trigger', { method: 'POST' })` → SSE subscription for live log.
- **SSE refresh flow:** Phase 10's SSE handler should push fresh `UpdateInfoView` payloads and the UI can simply call `setInfo(next)` on the existing banner — the component already handles all five states. Do NOT add a new state without updating the priority order comment block.
- **Do NOT poll `/api/update/check` from Phase 10 UI:** that endpoint has the 5-min cooldown and consumes it on every call. Use `/api/update/status` for any auto-refresh. The banner's `refreshInfo()` already follows this rule.
- **Sidebar hook reuse:** If Phase 10 needs the same polling pattern elsewhere, extract `useUpdateAvailable()` from `sidebar.tsx` to `src/hooks/use-update-available.ts` at that time. Not worth the extraction now (single call site).
- **Post-install state reset:** After a successful install + restart, `currentSha` will equal the old `remote.sha`, but `lastCheckResult` still holds the old `'ok'` variant with `remoteSha === currentSha`. The `deriveUpdateInfoView()` helper from plan 08-01 sets `updateAvailable = false` when those match, so the banner automatically flips to STATE 4 ("Du bist auf dem neuesten Stand") on next render. No manual reset needed.

## Self-Check: PASSED

- `src/app/settings/update-banner.tsx` — FOUND (new)
- `src/app/settings/page.tsx` — FOUND (modified)
- `src/components/layout/sidebar.tsx` — FOUND (modified)
- Commit 52168de — FOUND (Task 1)
- Commit 1306a82 — FOUND (Task 2)
- Commit 4a16137 — FOUND (Task 3)
- Task 4 (human-verify) — PENDING (checkpoint return message issued to orchestrator)
