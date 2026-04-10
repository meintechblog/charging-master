# Phase 10: UI Integration & Restart Handoff - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Source:** Milestone research + Phases 7-9 interfaces

<domain>
## Phase Boundary

Final phase of milestone v1.2. Wires the existing backend (Phases 7-9) into a user-facing install flow. After this phase: user clicks "Installieren", sees live log, browser survives restart, reloads with new version — or sees a rollback banner if the update failed.

Deliverables:
1. Install button + confirmation modal on UpdateBanner (replaces Phase 8 placeholder)
2. `POST /api/update/trigger` route that calls `systemctl start --no-block charging-master-updater.service`
3. `GET /api/update/log` SSE endpoint streaming `journalctl -fu charging-master-updater` with proper cleanup
4. Stage-Stepper component (visual progress through the 9 pipeline stages)
5. Live-Log-Panel component (terminal-style, monospace, auto-scroll)
6. Reconnect overlay that polls `/api/version` every 2s during restart (up to 90s)
7. Auto-reload on SHA change with success banner
8. Red rollback banner on next page load when `state.json.rollbackHappened === true`

**Explicitly NOT in Phase 10:**
- Boot-loop watchdog (out of scope for v1.2)
- Changelog diff (v1.3)
- Migration auto-apply (never in v1.2)

</domain>

<decisions>
## Locked Implementation Decisions

### Trigger endpoint
`POST /api/update/trigger`:
- Returns immediately (`systemctl start --no-block` is fire-and-forget)
- Body: optional `{ targetSha: string }` for UI's expected-SHA tracking (server doesn't use it — just echoes back in response)
- Checks: updateAvailable must be true in current state (else 409 "no update available"); no other updater currently running via flock file presence check (else 409 "update already running")
- Stashes `targetSha` into state.json `updateStatus: "running"` + `targetSha` field so page reloads can show it
- Returns 202 `{ status: "triggered", startedAt: Date.now(), targetSha }`
- Localhost-only guard via Host header (same pattern as `/api/internal/prepare-for-shutdown`)
- Uses `child_process.spawn('systemctl', ['start', '--no-block', 'charging-master-updater.service'], { detached: true, stdio: 'ignore' }).unref()` — load-bearing flags
- **On dev machine:** spawn will fail because charging-master-updater.service doesn't exist. Detect this and return 503 with a clear dev-mode message instead of crashing.

### SSE log endpoint
`GET /api/update/log`:
- Uses `ReadableStream` directly (no library)
- Spawns `journalctl -fu charging-master-updater --output=cat --lines=100`
- Pipes stdout line-by-line as SSE `data: <line>\n\n` events
- **CRITICAL cleanup:** Kill the journalctl child on BOTH `request.signal.abort` AND ReadableStream `cancel()`. Without both hooks → zombie processes.
- On dev machine: journalctl may not exist or the unit may not exist. Detect and fall back to a synthetic stream that emits `data: [dev-mode] log stream unavailable\n\n` + keeps the connection open with periodic heartbeats.
- Content-Type `text/event-stream`, Cache-Control `no-cache, no-transform`, Connection `keep-alive`

### Install confirmation modal
Component: `src/app/settings/install-modal.tsx` (client).
- Shown when user clicks the Install button in UpdateBanner
- Shows: current SHA → target SHA, commit message, author, date, "Dies wird den Server kurz neu starten. Aktive Ladesessions werden sauber beendet."
- Two buttons: "Abbrechen" (close modal) / "Jetzt installieren" (POST /api/update/trigger → on 202, switch UpdateBanner into streaming mode)
- ARIA dialog pattern, ESC to close, focus trap

### Stage Stepper component
Component: `src/app/settings/update-stage-stepper.tsx` (client).
- 9 stages visualized as icons + labels horizontally (wraps on narrow screens):
  `Preflight → Snapshot → Drain → Stop → Fetch → Install → Build → Start → Verify`
- States per step: `pending` (gray), `running` (pulsing blue), `done` (green check), `failed` (red X), `rolled_back` (yellow refresh icon)
- Current step computed from the most recent `[stage=<name>]` line in the log stream
- Pure presentation component — takes `{ currentStage, status }` as props

### Live Log Panel
Component: `src/app/settings/update-log-panel.tsx` (client).
- Terminal-style: `font-mono text-xs bg-gray-900 text-gray-100`
- Auto-scrolls to bottom on new line unless user has scrolled up (detect via scrollTop vs scrollHeight)
- Caps internal buffer at 2000 lines to avoid memory growth
- "Auto-Scroll" toggle switch in the top-right corner
- Receives lines from parent via props (parent manages the EventSource)

### Reconnect Overlay
Component: `src/app/settings/reconnect-overlay.tsx` (client, fullscreen modal).
- Shown when the update trigger POST succeeds AND the update-banner is in "running" state AND the /api/update/log SSE drops (meaning server is restarting)
- Centered: spinner + "Server wird neu gestartet..." + elapsed time counter + "Dies kann bis zu 90 Sekunden dauern"
- Starts polling `GET /api/version` every 2 seconds
- When response.sha !== initialSha (captured before the update) → trigger `window.location.reload()`
- On 90s timeout without SHA change: replace spinner with error icon + "Neustart hat zu lange gedauert. Bitte prüfe per SSH: `systemctl status charging-master`" + retry button
- Backdrop click does NOTHING (non-dismissable while update in flight)

### Rollback banner (ROLL-06)
- Extend UpdateBanner with a new render state: when `state.rollbackHappened === true`, show a RED banner ABOVE all other states:
  - Headline: "⚠ Letztes Update fehlgeschlagen — Version wurde zurückgerollt"
  - Subtitle: `Von <targetSha> auf <rollbackSha>` + rollback stage (stage1 / stage2)
  - Show rollbackReason if present
  - "Verstanden" button → POSTs to `/api/update/ack-rollback` which clears `rollbackHappened` in state.json
- After ack, falls through to normal update-banner rendering

### Ack-rollback endpoint
`POST /api/update/ack-rollback`:
- Localhost-only (Host guard)
- Clears `rollbackHappened` / `rollbackReason` / `rollbackStage` in state.json via UpdateStateStore.write()
- Returns 200 {status: "acked"}

### Update flow state machine (client side)
Lives in UpdateBanner:
```
idle → confirm (modal open)
confirm → canceled (back to idle)
confirm → triggered (POST succeeded)
triggered → streaming (SSE connected, stages running)
streaming → reconnecting (SSE dropped during restart)
reconnecting → success (version SHA changed) → window.reload
reconnecting → timeout (90s elapsed) → show error
triggered → error (POST failed, e.g. 409/503)
```
Keep it as a plain useState enum, no library.

### Type extensions
`src/modules/self-update/types.ts`:
```ts
export type UpdateTriggerResponse =
  | { status: "triggered"; startedAt: number; targetSha: string }
  | { status: "error"; error: string };

export type UpdatePipelineStage =
  | "preflight" | "snapshot" | "drain" | "stop"
  | "fetch" | "install" | "build" | "start" | "verify";
```

`UpdateState` extension (add to existing type):
- `targetSha?: string | null` — set when update triggered
- `updateStartedAt?: number | null` — when triggered
- (rollbackHappened / rollbackReason / rollbackStage already exist from Phase 9)

### Module layout
```
src/
├── app/
│   ├── api/
│   │   └── update/
│   │       ├── trigger/route.ts         (new — POST, 202)
│   │       ├── log/route.ts             (new — GET SSE)
│   │       └── ack-rollback/route.ts    (new — POST)
│   └── settings/
│       ├── update-banner.tsx            (modified — install button, running/streaming states, rollback banner)
│       ├── install-modal.tsx            (new)
│       ├── update-stage-stepper.tsx     (new)
│       ├── update-log-panel.tsx         (new)
│       └── reconnect-overlay.tsx        (new)
├── modules/
│   └── self-update/
│       ├── types.ts                     (modified — new types)
│       └── update-state-store.ts        (modified — getUpdateInfo() returns rollback* fields)
```

### Dev-mode graceful degradation
On dev machine (macOS, no systemd):
- `/api/update/trigger` returns 503 with `{status: "dev_mode", message: "Updater not available in dev"}`
- `/api/update/log` emits synthetic dev-mode events
- UI can still be eye-checked: banner states, modal, reconnect overlay (triggered manually by dev hook? — NO, too complex. Just show a dev-mode warning in the modal.)

### Claude's Discretion
- Exact dark-theme color tokens for the stage stepper states
- Whether to use a library icon set or inline SVG (inline SVG preferred for zero dependencies)
- Auto-scroll detection threshold (50px from bottom = "user is at bottom")
- Reconnect polling: simple setInterval vs setTimeout chain (setTimeout chain preferred to avoid overlap)
- Where the rollback ack endpoint stores the `ackedAt` timestamp (skip it — simple clear is enough)

</decisions>

<canonical_refs>
### Phase 7-9 artifacts
- `src/lib/version.ts` — baked SHA for initial reference
- `src/app/api/version/route.ts` — what the reconnect overlay polls
- `src/modules/self-update/types.ts` — UpdateState, UpdateInfoView, LastCheckResult
- `src/modules/self-update/update-state-store.ts` — getUpdateInfo + write + read
- `src/modules/self-update/update-checker.ts` — the scheduler (Phase 10 doesn't touch it)
- `src/app/api/update/status/route.ts` — banner's initial state source
- `src/app/api/update/check/route.ts` — manual check button (already works)
- `src/app/api/internal/prepare-for-shutdown/route.ts` — dev-side guard pattern
- `src/app/settings/update-banner.tsx` — existing 5-state banner, to extend
- `src/app/settings/page.tsx` — where banner is mounted
- `scripts/update/charging-master-updater.service` — unit that trigger endpoint starts
- `scripts/update/run-update.sh` — writes `[stage=<name>]` markers that the stepper parses
- `.update-state/state.json` — source of rollbackHappened flag

### Research
- ARCHITECTURE.md Q5 — restart handoff sequence (the ASCII diagram)
- PITFALLS.md P10 — SSE stream during restart, browser knows to auto-reconnect
- PITFALLS.md P18 — silent success gate (reconnect overlay is the UX of this)

</canonical_refs>

<specifics>
## Specific Requirements Mapped

- **LIVE-01** → `GET /api/update/log` SSE endpoint
- **LIVE-02** → journalctl child cleanup on signal.abort + stream.cancel
- **LIVE-03** → UpdateStageStepper component (9 stages)
- **LIVE-04** → UpdateLogPanel component (terminal style, auto-scroll)
- **LIVE-05** → ReconnectOverlay appears when SSE drops during restart
- **LIVE-06** → ReconnectOverlay polls /api/version every 2s for 90s
- **LIVE-07** → Auto-reload on SHA change + success banner post-reload
- **LIVE-08** → 90s timeout error with SSH hint
- **ROLL-06** → Red rollback banner + ack endpoint

Plus: Install button wiring on UpdateBanner, confirmation modal, trigger endpoint — these are implicit in LIVE-01..08 but worth calling out explicitly in the plan.

</specifics>

<deferred>
## Deferred Ideas
- Boot-loop watchdog → v1.3
- Changelog diff → v1.3
- Migration auto-apply → never in v1.2
- Multiple concurrent updates queueing → never in v1.2 (flock rejects the second)
</deferred>

---
*Phase: 10-ui-integration-restart-handoff*
*Context gathered: 2026-04-10 from milestone research + Phase 7-9 interfaces*
