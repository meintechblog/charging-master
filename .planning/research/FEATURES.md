# Feature Research

**Domain:** In-app self-update mechanism for self-hosted web app (Next.js 15 / systemd / GitHub HEAD SHA)
**Researched:** 2026-04-10
**Confidence:** HIGH
**Milestone:** v1.2 Self-Update
**Scope:** ONLY the self-update surface. Existing features (device learning, relay control, SSE dashboard, Settings UI) are out of scope.

---

## Executive Summary

Mature self-hosted tools (Home Assistant, Portainer, Sonarr/Radarr, Grafana, Plex, VS Code) converge on a surprisingly consistent update UX pattern: **version in a stable corner location, unobtrusive badge when updates are available, dedicated update screen with explicit button, streamed progress during install, and a reconnect-aware post-restart flow.** The gap between "amateur" and "professional" self-update is almost entirely about **feedback density during the install phase** and **reconnect handling after restart** — the parts where users sit and stare at a browser tab, unable to tell if something is broken or just slow.

For a single-user hobby app, the table stakes list is short but non-negotiable: know your version, show a non-annoying indicator when there's something newer, stream the update output live, and reconnect cleanly. Differentiators are mostly about polish during the 30-90 second window where the server is restarting — that's where this feature earns the "professional feel" label.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these makes the feature feel broken or amateurish. Based on how Home Assistant, Portainer, Sonarr, and Grafana all present updates.

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| T1 | **Current version visible at all times** | Every mature self-hosted tool shows version in footer or sidebar (Portainer: bottom-left, Sonarr: System > Status, HA: Settings > About, Grafana: bottom-right). User needs zero-click answer to "what am I running?" | LOW | Short SHA (7 chars) + build date. Place in Settings header or sidebar footer. Reads from baked-in build constant. |
| T2 | **Dedicated Settings > Updates screen** | Every tool has a single canonical "update page" — never scattered. Portainer's in-app updater, Sonarr's System > Updates, Grafana's admin panel. Users know where to look. | LOW | New route: `/settings/updates`. Server component reads version + last check timestamp. |
| T3 | **"Update available" indicator on nav/settings** | Small dot, badge, or colored pill next to "Settings" in nav when update is available. Sonarr uses an orange pill, Portainer uses a footer notification, HA uses a red dot on the Settings icon. Must be **glanceable and dismissible**. | LOW | Client component reads `/api/version/status` every N minutes. Badge component on Settings nav item. Do NOT use toasts/modals — they're annoying. |
| T4 | **Last-check timestamp** | "Last checked: 2 hours ago" builds trust that auto-polling works. Without it, users don't know if the system is alive. HA, Sonarr, and Portainer all show this. | LOW | Store in SQLite. Display relative time ("2h ago") + absolute on hover. |
| T5 | **Explicit "Install update" button** | Non-negotiable: updates are never automatic without confirmation. Sonarr, Radarr, Portainer, Home Assistant Supervisor all require explicit user click. Auto-update without consent is an anti-feature (see below). | LOW | Primary button only visible when update is available. Disabled state while update in flight. |
| T6 | **Live log stream during update** | When user clicks Install, they MUST see activity. Home Assistant Supervisor streams addon install logs, Portainer shows container pull progress, Sonarr shows an update log. A silent 60-second spinner is the #1 way to make users nervous. | MEDIUM | SSE endpoint proxies `journalctl -u charging-master-updater.service -f`. Client renders monospace log panel. Auto-scroll to bottom. |
| T7 | **Staged progress states** | Update is never one opaque spinner. Show: `Idle -> Checking -> Available -> Pulling -> Installing deps -> Building -> Restarting -> Verifying -> Done`. Each state is a visible step with a checkmark or spinner. This is what HA Supervisor, Portainer, and Watchtower all do. | MEDIUM | State machine in DB table `update_runs(state, started_at, ...)`. UI renders step list. States parsed from updater script markers in journal. |
| T8 | **Restart-aware reconnect** | After `systemctl restart charging-master`, the browser tab is frozen on an unreachable page. Without intervention the user sees a blank page or a connection error. Mature tools show a "reconnecting..." overlay that polls until the server responds, then auto-reloads. This is the single biggest "pro vs amateur" signal. | MEDIUM | Client polls `/api/version` every 2s with timeout. Overlay with spinner + elapsed time. On success, `window.location.reload()`. |
| T9 | **Success state with new version** | After update completes, show "Updated to abc1234" with old -> new SHA. Grafana, Portainer, and HA all confirm what changed. | LOW | Post-restart, verify SHA matches the expected new SHA; display "Updated successfully". |
| T10 | **Failure + rollback visibility** | When the updater fails and auto-rolls back, the user MUST know. Without it, a "failed silently" rollback is worse than no rollback — user thinks they got the new version but didn't. HA Supervisor and Portainer both surface install failures prominently. | MEDIUM | Updater writes failure marker. On next page load, banner: "Update to abc1234 failed and was rolled back. View logs." Link to the preserved log. |
| T11 | **"Check now" manual button** | Even with 6h auto-polling, users want agency. Every tool has this: Sonarr "Check for updates now", Portainer "Check", HA "Check for updates". Typically next to the last-check timestamp. Cheap to build, high trust value. | LOW | POST `/api/version/check`. Reuses the same GitHub fetch as the cron path. Rate-limit to 1/min. |
| T12 | **"You're up to date" empty state** | When no update is available, the page must still feel alive. Show current version, last check, next scheduled check, and a calm "You're on the latest version" message. Sonarr and Portainer both handle this gracefully. | LOW | Conditional render on the Updates screen. |
| T13 | **Build timestamp alongside SHA** | SHA alone is cryptic. "abc1234 (built 2026-04-09 14:32)" gives non-developers a human-readable anchor. HA shows "Core 2026.4.0", Portainer shows "2.19.1", but for a SHA-versioned app the build date substitutes for a semver number. | LOW | Inject at build time via Next.js env or generated constant. |

### Differentiators (Nice-to-Have Polish)

These elevate the experience from "functional" to "professional feeling" — the things users notice and remember. Not required for v1.2, but each is a small investment with visible payoff.

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D1 | **Changelog preview before clicking Update** | Show the commit list between current SHA and target SHA before the user commits. Uses GitHub's compare API (`/repos/.../compare/SHA1...SHA2`). HA blog posts, Grafana's release notes link, and VS Code's "What's new" tab all do this. For a single-dev hobby app this is a big trust win — user sees exactly what's coming. | MEDIUM | One GitHub API call per check. Cache result with the "update available" state. Render as collapsed commit list with first-line messages + short SHA + author. |
| D2 | **Reconnect countdown with "what's happening" copy** | Instead of a bare spinner, show: "Restarting... (15s) - The server is coming back online. This usually takes 30-60 seconds." Grafana and HA use this pattern. Transforms anxiety into patience. | LOW | Elapsed-time counter in the overlay + explanatory copy. No new tech. |
| D3 | **Reconnect timeout + manual recovery hint** | If reconnect takes >90s, show: "Still reconnecting... If this persists, SSH into the server and run `systemctl status charging-master-updater.service`." Gives the user an escape hatch without hiding that something's wrong. | LOW | Timeout branch in the reconnect overlay. |
| D4 | **Pushover notification on rollback** | The user might not be looking at the UI when a background update fails. Reuse the existing Pushover integration to send "Charging-Master update failed and was rolled back." Home Assistant Supervisor sends similar alerts via its notification bus. | LOW | One-line integration — the notify function already exists for charge alerts. |
| D5 | **"View previous update" history** | Small table showing last 5 update attempts: timestamp, from SHA, to SHA, result (success / rolled back). Portainer and HA Supervisor both keep an update history. Debugging gold. | MEDIUM | Requires `update_runs` table to persist beyond the current run. |
| D6 | **Commit author + date in version display** | Instead of just `abc1234`, show `abc1234 - user - 2d ago`. GitHub, VS Code About dialog, and Grafana all use this. Makes the version feel alive. | LOW | Fetched at build time from `git log -1 --format=...`. |
| D7 | **Update-in-progress indicator on every page** | Thin progress bar at the top of every page while an update is running (not just on Settings). VS Code and JetBrains IDEs both do this. Means the user doesn't need to babysit the Settings tab. | MEDIUM | Global layout component subscribing to update state SSE. |
| D8 | **"Copy log to clipboard" button** | When update fails, user wants to paste the log somewhere (issue tracker, ChatGPT). A copy button on the log panel is zero-friction. VS Code, Docker Desktop, Sonarr all have this. | LOW | One-line clipboard API call. |
| D9 | **Non-blocking background check** | Auto-polling every 6h is already decided, but ensure it never blocks UI or charging operations. Differentiator is making this invisible. | LOW | Check runs in a Next.js background task or cron; failure is logged but silent. Charging logic never touches update code. |
| D10 | **Visual diff of state machine steps** | Instead of a plain text list, show the stages as a horizontal stepper with icons (pending / running / done / failed). HA Supervisor's addon update dialog does this beautifully. Pure visual polish. | LOW | CSS + icons, no new logic. |
| D11 | **"Don't show again for this version" dismiss** | If user isn't ready to update, let them dismiss the badge for the current target SHA. Badge reappears when a newer SHA is released. Slack, Discord, and VS Code all do this for non-critical updates. | LOW | Store dismissed SHA in localStorage or SQLite. |

### Anti-Features (Commonly Requested, Often Problematic)

Things to explicitly NOT build — each would actively damage the UX.

| # | Anti-Feature | Why Tempting | Why Problematic | Alternative |
|---|--------------|--------------|-----------------|-------------|
| A1 | **Fully automatic silent updates** | "Just keep it up to date!" sounds convenient. | User loses agency. A broken build installs itself while the user is charging a device. Server restart mid-charge can leave a Shelly relay on with no supervisor. | Auto-detect, auto-notify, but NEVER auto-install. Update button requires explicit click. |
| A2 | **Forced update modal blocking UI** | Guarantees the user sees it. | Hostile. User is trying to check a charge and gets a full-screen "You must update" prompt. VS Code's old update nags are widely hated. | Badge + banner only. Never block interaction. |
| A3 | **Hiding what will change** | Simpler implementation — just a version number. | Users don't trust what they can't see. Especially for a SHA-versioned single-dev app where "abc1234 -> def5678" is meaningless without commit messages. | Show commit list (D1). Even one-liner commit subjects build trust. |
| A4 | **Opaque spinner during install** | Easy to build — one loading state. | The #1 UX failure mode for updaters. 60 seconds of a spinner feels like forever. User assumes it's broken and starts SSHing into the server. | Live log stream (T6) + staged progress (T7). |
| A5 | **Toast notification for update availability** | Toasts are a common pattern. | Toasts auto-dismiss in 3-5s and are easy to miss. Update availability is persistent state, not a momentary event. Research consensus: banners > toasts for persistent state. | Badge on nav + persistent banner on Settings. |
| A6 | **Breaking the page during update** | Implementation laziness — let the browser fail naturally. | User sees "This site can't be reached" browser error mid-update. Looks like a crash. Confidence destroyed. | Reconnect overlay (T8) intercepts before network failure surfaces. |
| A7 | **No feedback when reconnect fails** | Assume it'll always work. | When reconnect hangs (e.g., build broke), user has zero information and zero recourse. | Timeout + manual recovery hint (D3). |
| A8 | **Exposing raw git/pnpm commands to non-dev user** | Developer mindset — "just show the terminal!" | Scary for a hobby user who might not know git. Raw stderr warnings look like errors even when they're warnings. | Live log is fine (T6) but wrap it as "Update log" not "Terminal". Keep the UI text in German/user language, even if the log itself is English. |
| A9 | **Silent rollback** | "It just works, user doesn't need to know." | Worst-case UX: user thinks they upgraded but didn't. Next time they hit a bug, they report it against the wrong version. | Explicit failure banner + Pushover notification (T10, D4). |
| A10 | **Polling on the client for update availability** | Straightforward to add a `useEffect` polling interval. | Every tab polls independently. Wastes GitHub API quota. Gets rate-limited. | Server-side background check writes to DB. Client reads DB state via single endpoint. |
| A11 | **Update button that does nothing visible for 2s** | HTTP POST triggers systemctl, returns 200, and then... nothing. | Click-no-feedback is the worst kind of UI. Users click repeatedly, triggering multiple updates. | Button transitions immediately to a loading/pending state. SSE stream connects within 500ms. Button stays disabled until update completes. |
| A12 | **Requiring a page refresh to see new version** | "Just reload!" | User doesn't know if reload will land on old or new instance. Amateur signal. | Auto-reload after reconnect verification (T8, T9). |
| A13 | **Logs that vanish after the run** | "It's done, clear the buffer." | User wants to review what happened, especially after a failure. | Persist last run's log in SQLite or a flat file. Show on Updates screen until next run. |

---

## Feature Dependencies

```
T1 (version display)
    |
    +---requires---> build-time SHA injection (infra)
    |
T2 (Updates screen)
    |
    +---requires---> T1 (current version source)
    |
T3 (nav badge)
    |
    +---requires---> T4 (last check state) + background polling
    |
T4 (last check)
    |
    +---requires---> update_runs table + /api/version endpoint
    |
T5 (Install button)
    |
    +---requires---> T2 (screen to live on) + systemd unit triggering
    |
T6 (live log stream)
    |
    +---requires---> SSE endpoint + journalctl access
    |
T7 (staged progress)
    |
    +---requires---> T6 (log parsing for markers) OR separate state channel
    |
T8 (reconnect overlay)
    |
    +---requires---> T5 (triggered by install) + /api/version polling
    |
T9 (success state)
    |
    +---requires---> T8 (reconnect completed) + SHA comparison
    |
T10 (failure + rollback)
    |
    +---requires---> T7 (state machine knows "rolled-back") + persistent log

D1 (changelog preview)  ---enhances---> T2, T3 (shows before clicking Install)
D2 (reconnect countdown) ---enhances---> T8
D3 (reconnect timeout hint) ---enhances---> T8
D4 (Pushover rollback)   ---enhances---> T10
D5 (update history)      ---enhances---> T2 (same screen)
D6 (commit author/date)  ---enhances---> T1, T13
D7 (global progress bar) ---enhances---> T7 (same state source, wider placement)
D8 (copy log)            ---enhances---> T6
D11 (dismiss per SHA)    ---enhances---> T3

A1 (auto-install)  ---conflicts---> T5 (explicit button is table stakes)
A5 (toast)         ---conflicts---> T3 (badge is the right pattern)
A10 (client poll)  ---conflicts---> T3, T4 (server-side state is the source)
```

### Dependency Notes

- **T7 (staged progress) can piggyback on T6 (log stream):** The updater script can write sentinel lines like `[stage:building]` to the journal, which T7 parses from the same SSE stream. This avoids building two separate channels and halves the implementation cost.
- **T8 (reconnect overlay) is the lynchpin of the "pro feel":** Without it, every other feature looks broken because the browser sees a connection error mid-update. Build T8 early, even as a stub, so the full flow can be tested end-to-end.
- **D1 (changelog preview) depends on the 6h background check writing the commit list to DB, not just the SHA.** Worth deciding in the data model phase even if the UI is built later.
- **T10 (rollback visibility) requires a persistent marker file or DB row** — can't rely on in-memory state because the server has just been restarted. The updater writes a "last run result" record before exiting.

---

## MVP Definition

### Launch With (v1.2)

The minimum set for the milestone to feel done. Skip any of these and the feature feels broken.

- [ ] **T1** — Version display (short SHA + build timestamp) in Settings
- [ ] **T2** — Dedicated `/settings/updates` screen
- [ ] **T3** — Badge on Settings nav when update available
- [ ] **T4** — Last-check timestamp
- [ ] **T5** — Explicit Install Update button
- [ ] **T6** — Live log stream via SSE from journalctl
- [ ] **T7** — Staged progress (idle -> checking -> available -> installing -> restarting -> verifying -> done/failed)
- [ ] **T8** — Reconnect overlay with /api/version polling + auto-reload
- [ ] **T9** — Success state showing old -> new SHA
- [ ] **T10** — Failure banner + rollback visibility
- [ ] **T11** — "Check now" manual button
- [ ] **T12** — "You're up to date" empty state
- [ ] **T13** — Build timestamp alongside SHA

### Add If Time Permits (still v1.2)

High-value differentiators that are cheap to build.

- [ ] **D2** — Reconnect countdown copy (~15 min of CSS/text)
- [ ] **D3** — Reconnect timeout hint (~15 min)
- [ ] **D4** — Pushover notification on rollback (reuses existing integration)
- [ ] **D8** — Copy log to clipboard (~10 min)
- [ ] **D10** — Stepper-style stage visualization (CSS polish)

### Defer to Later Milestone (v1.3+)

Valuable but not essential — revisit once the core loop is stable.

- [ ] **D1** — Changelog preview via GitHub compare API *(highest-value deferral — consider promoting if GitHub API integration is already in place)*
- [ ] **D5** — Update history table (needs cumulative data anyway)
- [ ] **D6** — Commit author/date in version display
- [ ] **D7** — Global in-progress indicator across all pages
- [ ] **D11** — "Don't show again" dismiss per SHA

### Never Build

- All items in the Anti-Features section (A1–A13)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| T1 Version display | HIGH | LOW | **P1** |
| T2 Updates screen | HIGH | LOW | **P1** |
| T3 Nav badge | HIGH | LOW | **P1** |
| T4 Last check timestamp | MEDIUM | LOW | **P1** |
| T5 Install button | HIGH | LOW | **P1** |
| T6 Live log stream | HIGH | MEDIUM | **P1** |
| T7 Staged progress | HIGH | MEDIUM | **P1** |
| T8 Reconnect overlay | HIGH | MEDIUM | **P1** |
| T9 Success state | HIGH | LOW | **P1** |
| T10 Rollback visibility | HIGH | MEDIUM | **P1** |
| T11 Check now button | MEDIUM | LOW | **P1** |
| T12 Empty state | MEDIUM | LOW | **P1** |
| T13 Build timestamp | MEDIUM | LOW | **P1** |
| D1 Changelog preview | HIGH | MEDIUM | **P2** |
| D2 Reconnect countdown | MEDIUM | LOW | **P2** |
| D3 Reconnect timeout hint | MEDIUM | LOW | **P2** |
| D4 Pushover on rollback | MEDIUM | LOW | **P2** |
| D5 Update history | LOW | MEDIUM | **P3** |
| D6 Commit author/date | LOW | LOW | **P3** |
| D7 Global progress bar | LOW | MEDIUM | **P3** |
| D8 Copy log button | MEDIUM | LOW | **P2** |
| D9 Non-blocking check | HIGH | LOW | **P1** (implicit in T4) |
| D10 Stepper visualization | MEDIUM | LOW | **P2** |
| D11 Per-SHA dismiss | LOW | LOW | **P3** |

**Priority key:**
- **P1:** Must-have for v1.2 launch — all table stakes
- **P2:** Should include in v1.2 if capacity allows — cheap polish with visible payoff
- **P3:** Defer to v1.3+ — valuable but not essential

---

## Competitor Feature Analysis

How real tools implement each capability, with the pattern we're adopting.

| Feature | Home Assistant | Portainer | Sonarr / Radarr | Grafana | VS Code | Our Approach |
|---------|----------------|-----------|-----------------|---------|---------|--------------|
| Version display location | Settings > About | Bottom-left footer | System > Status | Bottom-right footer | Help > About | Settings header + `/settings/updates` screen |
| Update availability signal | Red dot on Settings icon + banner | Footer notification "Update now" | Orange pill in System nav | Admin banner | Status bar indicator + badge on gear | Badge on Settings nav (T3) |
| Check cadence | Daily | Daily | Every 12h | On page load | Hourly when active | Every 6h background (already decided) |
| Manual re-check | Yes, button on update page | Yes | Yes, "Check for updates now" | Yes | Yes, "Check for updates" in Help menu | Yes (T11) |
| Changelog preview | Yes, via release notes link | Yes, modal with release notes | Yes, in-line commit list | Yes, via changelog URL | Yes, "What's new" tab | Deferred to D1 (v1.3+) |
| Live install feedback | Supervisor log stream | Container pull progress | Update log text | N/A (external package mgr) | Progress notification + log panel | SSE log stream (T6) + stepper (T7) |
| Restart handling | Full-page "reconnecting" overlay with countdown | Spinner + reconnect polling | Browser refresh warning | N/A | N/A (desktop app) | Reconnect overlay with poll + auto-reload (T8) |
| Rollback visibility | Banner + notification | Error state with logs | Error log | N/A | Error notification | Banner + persisted log + optional Pushover (T10, D4) |
| Auto-install | Optional (off by default) | Never | Yes, configurable | No | Optional | **Never** (explicit button only) |
| Forced update modal | No | No | No | No | No (dismissible) | **Never** (A2) |

**Key insight:** Every mature tool converges on the same base pattern. The differences are cosmetic. Copying this pattern is the right move — it maps to what users already know.

---

## Design Rationale Notes

A few non-obvious calls to flag for the requirements/roadmap phase:

1. **SSE for log streaming is the right choice, not WebSocket.** SSE is unidirectional (server -> client), built into the browser, and aligns with the already-chosen SSE pattern for the charging dashboard. No new dependency.

2. **The reconnect overlay must be client-only state** that survives the server being unreachable. Using a React component with a setInterval polling `/api/version` is sufficient — but it must NOT rely on any server-side data while the server is down. Store the "expecting new version" flag in localStorage before triggering the update.

3. **Staged progress can be derived from log markers** to avoid a second channel. Updater script writes `::STAGE::building` lines to stderr, journald captures them, SSE forwards them, client parses them out of the log. One channel, two UI elements.

4. **The "Check now" button should debounce and rate-limit on the server.** Users will mash it. GitHub API has generous unauthenticated quota (60 req/hour) but it's worth a 60s cooldown per request.

5. **Build-time SHA injection needs a deterministic mechanism.** Options: (a) read `git rev-parse HEAD` in `next.config.ts` and inject via `env`, (b) write a `src/lib/version.ts` constant as part of the build script, (c) read from `package.json` version field rewritten by the updater. Option (b) is simplest and most reliable — the updater script writes `src/lib/version.ts` before running `pnpm build`. This is a cheap infrastructure decision that unblocks T1, T9, T13.

6. **The updater runs as a separate systemd service, not inside the Next.js process.** This is already decided, but implies: the Next.js app triggers the updater via `systemctl start charging-master-updater.service`, then the updater is responsible for the whole pipeline (git fetch, pnpm install, pnpm build, restart main service, verify, rollback on failure). This means T6's log source is `journalctl -u charging-master-updater.service -f`, not the main app's logs.

---

## Gaps and Open Questions

Things the research did not fully resolve — flag for requirements phase.

1. **Does the Next.js app need root to trigger systemctl?** Decision point: use `systemctl --user` (no root) vs. polkit rule allowing the app user to start the updater service (best practice). Affects the LXC setup.
2. **Where does the log persist between runs?** SQLite table vs. flat file in `/var/log/charging-master/`. Flat file is simpler for log rotation; SQLite is easier to query from the UI.
3. **How does the app know about a rolled-back state on first page load after restart?** The updater needs to write a marker file or DB row before exiting. What's the read path on app startup?
4. **Should the "Install" action be idempotent if user double-clicks?** Recommend: a `update_runs` table with a unique constraint on active state prevents concurrent runs.
5. **Confirmation modal before install?** Borderline table stakes. Every tool has one. Recommend a simple "Are you sure?" dialog with the target SHA — implicit T5 sub-feature, ~10 minutes to build.

---

## Sources

- [Portainer: Updating Portainer documentation](https://docs.portainer.io/start/upgrade) — in-app update mechanism, footer version display pattern (Business Edition 2.19+)
- [Sonarr forums: System/Updates](https://forums.sonarr.tv/t/system-updates/34475) — Settings > Update flow, manual check-now button pattern
- [Radarr System wiki (Servarr)](https://wiki.servarr.com/radarr/system) — "Application Check Update" cadence, update script triggering
- [Home Assistant 2026.1 release blog](https://www.home-assistant.io/blog/2026/01/07/release-20261/) — update banner + changelog presentation patterns
- [Home Assistant 2025.5 release notes](https://www.home-assistant.io/changelogs/core-2025.5/) — config flow progress in percent (staged progress precedent)
- [LogRocket: Toast notifications UX best practices](https://blog.logrocket.com/ux-design/toast-notifications/) — banner vs toast for persistent state
- [Carbon Design System: Notification pattern](https://carbondesignsystem.com/patterns/notification-pattern/) — when to use banner vs toast
- [Courier: Toast vs Banner vs Push](https://www.courier.com/blog/what-is-a-toast-message) — banners for persistent, toasts for ephemeral
- Direct experience with VS Code, Grafana, Home Assistant, Portainer, Plex update UIs (pattern recognition across mature self-hosted tools)

---
*Feature research for: v1.2 Self-Update milestone*
*Researched: 2026-04-10*
*Confidence: HIGH — patterns are well-established across mature self-hosted tools and converge on the same core design*
