# Phase 8: GitHub Polling & Detection - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Source:** Milestone v1.2 research (STACK/ARCHITECTURE/PITFALLS/SUMMARY) + Phase 7 foundations

<domain>
## Phase Boundary

This phase makes the app **aware** of new versions on GitHub. No triggering updates, no systemd, no install button — just awareness and UI surfacing.

Deliverables:
1. `GitHubClient` that calls `GET /repos/meintechblog/charging-master/commits/main` with ETag-based conditional requests
2. `UpdateChecker` singleton that polls every 6 hours from `server.ts main()` boot
3. Manual check trigger via `GET /api/update/check` (rate-limited server-side to 5min cooldown)
4. Persistence of ETag, last check timestamp, last check result in `.update-state/state.json`
5. UI surfacing: badge on Settings nav entry + banner on Settings page showing new SHA, commit message, author, date

**Explicitly NOT in Phase 8:**
- Install button, trigger endpoint, live log stream → Phase 10
- Updater shell script, systemd unit, rollback pipeline → Phase 9
- Pre-shutdown drain endpoint → Phase 9
- Changelog-diff between SHAs → v1.3 (out of scope)

</domain>

<decisions>
## Locked Implementation Decisions

### GitHub API client
- **Native `fetch`**, no library (no @octokit/rest, no simple-git, no isomorphic-git).
- **Endpoint:** `https://api.github.com/repos/meintechblog/charging-master/commits/main`
- **Headers to send:**
  - `Accept: application/vnd.github+json`
  - `User-Agent: charging-master-self-update/<CURRENT_SHA_SHORT>` (GitHub requires UA)
  - `X-GitHub-Api-Version: 2022-11-28`
  - `If-None-Match: <last_etag>` (only when we have an ETag cached in state.json)
- **Response handling:**
  - `304 Not Modified` → no change, refresh `lastCheckAt`, DO NOT consume rate limit, return `{ status: "unchanged" }`
  - `200 OK` → parse JSON, extract `sha`, `commit.message`, `commit.author.name`, `commit.author.date`, store new `ETag` header, return `{ status: "ok", remoteSha, message, author, date }`
  - `403/429` → rate-limit hit, return `{ status: "rate_limited", resetAt: Number(headers['x-ratelimit-reset']) }` but DO NOT throw — surface in UI
  - `404/5xx/network error` → return `{ status: "error", error: string }`, DO NOT throw (scheduler must not crash on transient failures)
- **Timeout:** `AbortController` with 10s timeout. Longer calls count as errors.
- **Zod parsing** of the 200 response body so we fail loud on shape drift.

### Update checker scheduler
- **Singleton:** `UpdateChecker` class in `src/modules/self-update/update-checker.ts`
- **Boot:** Instantiated and started from `server.ts main()` AFTER `UpdateStateStore.init()` (needs the store) but BEFORE HttpPollingService (non-blocking — fire and continue).
- **Interval:** `setInterval(() => this.check(), 6 * 60 * 60 * 1000)` — 6 hours in ms
- **Timer handling:** Call `.unref()` on the handle so it doesn't block process shutdown
- **First check:** Run immediately on boot (don't wait 6h for the first check), but schedule the interval for 6h later. Implementation: `this.check(); setInterval(...)`.
- **Concurrency guard:** Internal `isChecking` flag prevents overlapping calls when a manual `/api/update/check` hits at the same time as the scheduled interval.
- **Shutdown:** Expose `stop()` method that clears the interval. NOT wired up in Phase 8 (graceful shutdown hooks come later if needed).

### Rate limiting (manual trigger)
- **Manual endpoint:** `GET /api/update/check`
- **Rate limit:** 5 minute cooldown enforced server-side via `state.json.lastCheckAt` comparison. If called within 5 min of the last check, return `429` with `{ status: "cooldown", retryAfterSeconds }`.
- **No client-side rate limiting** — UI can spam the button all it wants; the server is the gate.

### State persistence
Existing `UpdateState` type in `src/modules/self-update/types.ts` already has these fields (added in Phase 7):
- `lastCheckAt: string | null` (ISO timestamp)
- `lastCheckEtag: string | null`
- `lastCheckResult: LastCheckResult | null`

`LastCheckResult` shape (verify in Phase 7 types; extend if needed):
```ts
type LastCheckResult =
  | { status: "ok", remoteSha: string, remoteShaShort: string, message: string, author: string, date: string }
  | { status: "unchanged" }
  | { status: "rate_limited", resetAt: number }
  | { status: "error", error: string }
```

`UpdateStateStore.write(patch)` already exists (atomic) — just call it with the updated fields.

**NEW API surface:** Add a getter `getUpdateInfo()` to `UpdateStateStore` that returns a `UpdateInfoView` derived from state + `CURRENT_SHA`:
```ts
type UpdateInfoView = {
  currentSha: string;
  currentShaShort: string;
  lastCheckAt: string | null;
  lastCheckStatus: "never" | "ok" | "unchanged" | "rate_limited" | "error";
  updateAvailable: boolean;  // true when lastCheckResult.status === "ok" && remoteSha !== CURRENT_SHA
  remote?: {
    sha: string;
    shaShort: string;
    message: string;
    author: string;
    date: string;
  };
  error?: string;
};
```

### API endpoints (new in Phase 8)
- `GET /api/update/check` — manual trigger. Returns `{ result: LastCheckResult, retryAfterSeconds?: number }`. Sync handler, returns within 10s (GitHub timeout).
- `GET /api/update/status` — returns current `UpdateInfoView` (no side effects, pure read). Sync, <50ms, used by UI polling.

### UI surfacing (new in Phase 8)
- **Update-available badge:** Small red dot on the "Einstellungen" nav entry when `updateAvailable === true`. Reuse the existing nav structure — do not rewrite navigation.
- **Settings banner:** Full-width card at the top of `/settings` (above VersionBadge from Phase 7) showing:
  - If `updateAvailable: true` → "Update verfügbar: `<shaShort>` · `<author>` · `<date>`" with commit message below, and a "Jetzt prüfen" button (re-check) + placeholder "Installieren" button that is DISABLED until Phase 10 wires it up (or simply not rendered until then — decision below).
  - If no update → discreet "Du bist auf dem neuesten Stand · letzter Check: `<relative time>`" line
  - If error/rate_limited → yellow warning line with error text and retry timestamp
- **Manual check button:** Always rendered. Clicking fires `fetch('/api/update/check')`, shows spinner for ≤10s, then re-renders the banner with the new result. Cooldown response (429) shows a yellow "Bitte `<N>` Sekunden warten" message.
- **Last check timestamp:** Small line under the banner using `Intl.RelativeTimeFormat` in German (`vor 2 Stunden`).

**Decision on Install button:** In Phase 8 the Install button is **NOT rendered at all**. Phase 10 will add it (with the confirmation modal and trigger wiring). This avoids rendering a dead button in the interim.

### Polling from `/api/update/status` to the UI
- **Initial render** on Settings page reads `UpdateInfoView` server-side from the store (async React Server Component or a client fetch on mount — prefer server component for initial state to avoid flash).
- **No auto-refresh** in Phase 8 — the banner reflects the state at page load time. If the user wants a fresh check, they click "Jetzt prüfen". Auto-refresh is a Phase 10 concern (SSE-driven).

### Module layout
```
src/
├── modules/
│   └── self-update/
│       ├── github-client.ts         (new — native fetch + zod + AbortController)
│       ├── update-checker.ts        (new — singleton class with setInterval)
│       ├── update-info-view.ts      (new — derive UpdateInfoView from state)
│       ├── types.ts                 (extend with LastCheckResult + UpdateInfoView)
│       └── update-state-store.ts    (add getUpdateInfo() method, extend write type)
├── app/
│   ├── api/
│   │   └── update/
│   │       ├── check/route.ts       (new — manual trigger with 5min cooldown)
│   │       └── status/route.ts      (new — pure read, <50ms)
│   └── settings/
│       ├── page.tsx                 (modified — mount UpdateBanner)
│       └── update-banner.tsx        (new — client component with state + manual check button)
server.ts                            (modified — boot UpdateChecker after init)
```

### Claude's Discretion
- Exact banner styling within the existing dark theme.
- Whether `UpdateChecker` should also persist a success counter / error counter for observability (keep it minimal — only the fields above).
- How to render the nav badge — pure CSS dot via `::after`, or a tiny `<span>` — pick whichever fits the existing nav.
- Whether the check should be cached in `state.json` when the server-side route is called concurrently (simple `isChecking` flag is enough; no queueing needed).
- Exact zod schema for the GitHub response (just validate the fields we use: sha, commit.message, commit.author.name, commit.author.date).

</decisions>

<canonical_refs>
## Canonical References

### Phase 7 artifacts (foundations this phase builds on)
- `src/lib/version.ts` — `CURRENT_SHA`, `CURRENT_SHA_SHORT`, `BUILD_TIME`
- `src/modules/self-update/types.ts` — existing `UpdateState`, `UpdateStatus`, needs extension
- `src/modules/self-update/update-state-store.ts` — `UpdateStateStore` with `init()`, `read()`, `write(patch)`, atomic tmp+rename
- `src/app/api/version/route.ts` — convention for synchronous GET handlers
- `server.ts` — where `UpdateStateStore.init()` boots (follow same pattern for `UpdateChecker`)
- `src/app/settings/page.tsx` — where the banner mounts (above existing `<VersionBadge />`)
- `.update-state/state.json` — shape to extend

### Milestone research
- `.planning/research/STACK.md` — GitHub client decision (native fetch, ETag mandatory, zod)
- `.planning/research/ARCHITECTURE.md` — module layout and boot sequencing
- `.planning/research/PITFALLS.md` — pitfall P8 (GitHub rate limit), P9 (stale check results), P17 (clock skew for ETag)

### Project docs
- `.planning/REQUIREMENTS.md` — DETE-01..06 (what this phase ships)
- `.planning/ROADMAP.md` — Phase 8 goal + success criteria

### External specs (read-only)
- GitHub REST API: `/repos/:owner/:repo/commits/:branch` returns a commit object with `sha`, `commit.message`, `commit.author.name`, `commit.author.date`
- Rate limits: 60 req/hour unauthenticated. 304 responses do NOT consume budget.
- Conditional requests: `If-None-Match: "<etag>"` → `304 Not Modified` if unchanged.

</canonical_refs>

<specifics>
## Specific Requirements Mapped

- **DETE-01** → `UpdateChecker` setInterval 6h + first check on boot
- **DETE-02** → `GitHubClient` with ETag header + 304 handling
- **DETE-03** → nav badge + Settings banner (updateAvailable)
- **DETE-04** → `GET /api/update/check` manual trigger with 5min cooldown
- **DETE-05** → `lastCheckAt` + `lastCheckStatus` displayed in UI
- **DETE-06** → Remote SHA + commit message + author + date in banner

</specifics>

<deferred>
## Deferred Ideas

- **Install button** → Phase 10 (with confirmation modal)
- **Live log streaming** → Phase 10
- **Auto-refresh banner after completed update** → Phase 10 (SSE-driven reconnect flow)
- **Changelog diff between local SHA and remote SHA** → v1.3 (out of scope)
- **GitHub Personal Access Token support** → Never (60 req/h is enough)
- **Multiple branches / release channels** → Never in v1.2

</deferred>

---

*Phase: 08-github-polling-detection*
*Context gathered: 2026-04-10 from milestone research + Phase 7 interfaces*
