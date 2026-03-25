# Phase 3: Charge Intelligence - Context

**Gathered:** 2026-03-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 delivers the core value: device profile learning, automatic device detection via curve matching, SOC estimation, and automatic charging stop at target SOC. Users can teach the app their devices by recording a full charge cycle, set a target SOC per profile, and the app handles everything automatically on subsequent charges. The charging state machine runs server-side (persistent across browser sessions).

Requirements: PROF-01, PROF-02, PROF-03, PROF-04, PROF-05, PROF-06, PROF-07, CHRG-01, CHRG-02, CHRG-03, CHRG-04, CHRG-05, CHRG-06, CHRG-07, VIZL-03

</domain>

<decisions>
## Implementation Decisions

### Learn Mode UX
- **D-25:** Wizard / Step-by-Step to start learning: 1. Enter device name 2. Select Shelly Plug 3. Hint "Akku moeglichst leer?" 4. Start recording.
- **D-26:** During learning: Live chart showing the charge curve being recorded in real-time, Wh counter, elapsed time, "Ladevorgang aktiv" badge. Full detail visible — user can track progress.
- **D-27:** Learning end detection: App auto-detects when power drops to ~0W (charge complete). Shows confirmation dialog: "Ladevorgang abgeschlossen — Profil speichern?" with option to save or discard.
- **D-28:** CRITICAL: Learning runs completely server-side (MQTT Service / Charge Monitor). User can close browser, switch tabs, come back later — the recording continues. State is persisted in DB. When user reopens app, they see current recording status.

### Profil-Management
- **D-29:** Dedicated /profiles page in sidebar navigation. List of all profiles, click to view/edit.
- **D-30:** Profile attributes: Name (required), Beschreibung (optional), Modellbezeichnung (optional), Kaufdatum (optional), geschaetzte Ladezyklen (optional). Extended attributes ready for future community library feature (v2).
- **D-31:** Ziel-SOC per profile via 10%-Schritte Buttons (10%, 20%, ... 100%). Visually shows SOC boundaries derived from reference curve.
- **D-32:** Profile actions: View reference curve, edit attributes, re-learn (overwrite reference curve), delete.

### Auto-Erkennung UX
- **D-33:** When device detected: Banner in dashboard: "[Geraet] erkannt (X% Confidence) — Ladevorgang gestartet, Ziel: Y%" with override controls (change profile, change SOC, abort).
- **D-34:** User can intervene at any time: change active profile, adjust target SOC, or abort the charging session entirely. Controls always accessible.
- **D-35:** Manual override UI: Claude's Discretion — inline controls in the banner or on the active session view.
- **D-36:** Unknown device (no profile match): Offer two options — "Jetzt anlernen" (start Learn Mode) or "Bestehendes Profil zuweisen" (dropdown of existing profiles). When assigning existing profile, the curve data feeds back into the profile to improve future recognition.

### Auto-Stopp Verhalten
- **D-37:** Countdown in dashboard during last ~5% before target SOC. Visual countdown shows remaining percentage, then relay switches off.
- **D-38:** Relay failure strategy: Claude's Discretion — safest approach. MQTT first, HTTP API fallback, retry logic, Pushover alarm if all fails.
- **D-39:** No separate emergency stop button needed — existing Relay Toggle is sufficient for immediate manual stop.

### Claude's Discretion
- Override UI layout (D-35)
- Relay failure/retry strategy (D-38)
- DTW algorithm implementation details (threshold tuning, window size, confidence calculation)
- SOC estimation algorithm (energy-based from reference curve)
- Charge state machine design (idle -> detecting -> charging -> countdown -> stopped)
- Power threshold for "charging started" vs "idle" detection
- How curve data from manual profile assignments feeds back into recognition

### Deferred Ideas (v2)
- Profile community library (export/import via GitHub repo)
- Profile image upload
- Multiple reference curves per profile for better recognition

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Charging Intelligence
- `.planning/research/ARCHITECTURE.md` — DTW curve matching algorithm, charge state machine, SOC estimation approach
- `.planning/research/FEATURES.md` — Feature dependencies, partial charge detection, CC-to-CV transition
- `.planning/research/PITFALLS.md` — Curve matching challenges, partial charges, relay rapid switching hysteresis

### Existing Code (Phase 1+2)
- `src/modules/mqtt/mqtt-service.ts` — MQTT singleton, publishCommand, persistPowerReading, subscribeToPlug
- `src/modules/events/event-bus.ts` — EventBus with typed events (power readings, online status)
- `src/hooks/use-power-stream.ts` — SSE hook for live power data
- `src/hooks/use-sliding-window.ts` — Sliding window for chart data
- `src/components/charts/power-chart.tsx` — ECharts power chart (needs reference curve overlay for VIZL-03)
- `src/db/schema.ts` — Current schema (plugs, power_readings, config tables)
- `src/app/api/devices/[id]/relay/route.ts` — Relay control API (MQTT + HTTP fallback)

### Prior Phase Decisions
- `.planning/phases/01-foundation/01-CONTEXT.md` — D-10 (5s/60s sampling), D-12 (SQLite WAL)
- `.planning/phases/02-real-time-visualization/02-CONTEXT.md` — D-13 (Smooth Area Chart), D-19 (Global SSE)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `power-chart.tsx` — Needs extension for reference curve overlay (VIZL-03: second series with dashed line)
- `mqtt-service.ts` — Has publishCommand for relay control, needs charge monitor integration
- `event-bus.ts` — Can emit new event types for charge state changes
- `use-sliding-window.ts` — Reusable for recording learn mode data
- Relay API route — Already handles MQTT + HTTP fallback pattern

### Established Patterns
- Server-side singleton services via globalThis (MqttService, EventBus)
- SSE for real-time data to browser
- Drizzle ORM for DB, SQLite WAL mode
- Tailwind dark theme, ECharts dark config

### Integration Points
- New: ChargeMonitor service (server-side singleton, like MqttService)
- New: /profiles page + /api/profiles routes
- New: charge_sessions, device_profiles, reference_curves DB tables
- New: SSE events for charge state changes (detecting, charging, countdown, stopped)
- Extend: PowerChart with second series for reference curve overlay

</code_context>

<specifics>
## Specific Ideas

- ChargeMonitor as server-side singleton: listens to EventBus power readings, manages charge state machine per plug, triggers auto-stop
- Charge state machine: idle -> detecting (first 1-2 min, running DTW) -> matched (banner shown) -> charging (tracking SOC) -> countdown (last 5%) -> stopped (relay off) -> idle
- Reference curve stored as array of [timestamp_offset, watts] — relative timestamps from charge start
- SOC estimation: cumulative Wh compared to total reference Wh, mapped to 10% boundaries
- DTW matching: compare first 60-120 seconds of new charge against all stored reference curves, pick best match above confidence threshold
- Learn mode wizard could reuse the existing PowerChart component in "recording" mode

</specifics>

<deferred>
## Deferred Ideas

- Profile community library (export/import via GitHub repo) — v2 feature
- Profile image upload — v2 feature
- Multiple reference curves per profile — v2 (single reference curve sufficient for v1)
- Partial charge curve alignment (start at 40% SOC) — complex subsequence DTW, defer to v1.x after basic matching works

</deferred>

---

*Phase: 03-charge-intelligence*
*Context gathered: 2026-03-26*
