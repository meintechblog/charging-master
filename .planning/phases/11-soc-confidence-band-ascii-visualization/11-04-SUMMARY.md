---
phase: 11-soc-confidence-band-ascii-visualization
plan: 04
subsystem: ui + sse
tags: [react-client-component, css-variables, soc-band, autosave, settings, sse-active-replay, jsdom, testing-library, vitest]

requires:
  - phase: 11-soc-confidence-band-ascii-visualization
    plan: 02
    provides: ChargeStateEvent band fields (socMin/socMax/socBandConfidence), chargeSessions.soc_min/soc_max/band_confidence columns, stopMode persistence pattern
  - phase: 11-soc-confidence-band-ascii-visualization
    plan: 03
    provides: socAsciiBar on ChargeStateEvent (rendered in captureEventContext), renderSocBandAscii pure function

provides:
  - SocBandIndicator React client component (CSS-driven live band + ASCII fallback + noscript)
  - ChargingSettings React client component (stop-mode radio + advanced band-threshold input, useAutoSave)
  - Settings page "Laden" SettingsSection wiring
  - SSE /api/sse/power active-replay branch hydrates socMin/socMax/socBandConfidence on mid-session reconnect
  - jsdom + @testing-library/react test infrastructure (added as devDependencies)
  - SOCB-06 satisfied (live band visualization end-to-end, no-JS fallback, runtime configurability)

affects: []

tech-stack:
  added:
    - "@testing-library/react 16.3.2 — RTL render/screen/fireEvent for component tests"
    - "@testing-library/jest-dom 6.9.1 — toBeInTheDocument matcher etc."
    - "@testing-library/user-event 14.6.1 — listed for completeness (only fireEvent used in this plan's tests)"
    - "jsdom 29.1.1 — DOM implementation for component tests under vitest"
    - "@vitejs/plugin-react 6.0.2 — JSX/TSX transform in vitest"
  patterns:
    - "CSS-variable driven animation: parent container exposes --soc-min/--soc-max/--soc-best/--soc-target; children read via style={{left: 'var(--soc-min)'}} so the browser interpolates with transition-all duration-700 (RESEARCH 'CSS wins over ECharts')"
    - "Three-tier render fallback: live CSS band when band fields present → <pre>ASCII</pre> when only initialAsciiBar → null when neither (+ <noscript> always carries ASCII for JS-disabled clients)"
    - "useAutoSave (500ms debounce + PUT /api/settings) is intentionally duplicated between electricity-settings and charging-settings per plan N2; folding into shared hook is v1.3 backlog (1 line of context per call-site)"
    - "Threshold input validates before firing the autosave PUT: parseFloat → [0.05, 0.50] check → fall back to initialThreshold if intermediate. Prevents typing '0.' from POSTing an invalid value"
    - "Default-value sync: UI's bandThreshold placeholder reads from DEFAULT_BAND_THRESHOLD_PCT in curve-matcher (Plan 11-01's empirical pin); no separate magic number in the component"

key-files:
  created:
    - src/components/charging/soc-band-indicator.tsx
    - src/components/charging/soc-band-indicator.test.tsx
    - src/components/settings/charging-settings.tsx
    - src/components/settings/charging-settings.test.tsx
    - vitest.setup.ts
  modified:
    - src/components/charging/charge-banner.tsx
    - src/app/settings/page.tsx
    - src/app/api/sse/power/route.ts
    - vitest.config.ts
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "CSS variables on the band-container parent (not the fill child) — children compose with var(--soc-min), var(--soc-max - var(--soc-min)) for width. This matches the RESEARCH-recommended pattern where one parent owns the dynamic state and CSS does the rest."
  - "transition-all duration-700 ease-out on band-fill AND best-marker so both narrow smoothly. Target marker uses no transition (it's a fixed user-chosen value and abrupt updates feel correct)."
  - "Render returns null on idle + no initial ASCII. The plan asked for 'no display' (parent uses legacy fallback) which is exactly what null gives — React strips null children entirely so the parent's spacing wrappers don't leave a gap."
  - "ChargeBanner's local SessionState was widened (not removed). Existing fields stay; band fields are appended as optional. onChargeEvent setSession now copies socMin/socMax/socBandConfidence/socAsciiBar from the event."
  - "SocBandIndicator is inserted ONLY in the non-countdown branch (the 'active' big-percent display). The countdown branch already has its own CountdownDisplay component; pushing the band there too would compete for vertical space with the countdown ring. Plan said 'directly below the existing SOC percent display' — that's the non-countdown branch."
  - "Settings page placement: 'Laden' goes between 'Strompreis' (ElectricitySettings) and 'Auto-Update' (AutoUpdateSettings). Logical user-mental-model grouping is electricity → charging → maintenance."
  - "SettingsSection title chosen as 'Laden' (German project convention — see existing 'Strompreis', 'Auto-Update', 'Profil-Katalog'). Description 'Stopp-Verhalten und Band-Konfiguration' covers both controls in the section."
  - "useAutoSave duplication: copied verbatim from electricity-settings.tsx into charging-settings.tsx per the plan's N2 note. Folding into a shared hook (e.g. @/hooks/use-autosave-config) is acceptable v1.3 backlog. The duplicated implementation is 25 lines."
  - "Threshold input bounds [0.05, 0.50] mirror Plan 11-01's calibration sweep range. Outside that range there's no empirical evidence the matcher behaves sensibly; the UI hard-caps so users can't get into trouble without editing config directly."
  - "SSE active-replay path adds three SELECT columns + three snapshot fields. socAsciiBar stays undefined on replay because (a) it's not stored in the chargeSessions row — it's rendered at snapshot time in captureEventContext from socMin/socMax/socBest/targetSoc, and (b) the dashboard's SocBandIndicator uses the CSS-variable path which doesn't need the ASCII string. Next live event will populate it for the <pre> wide-screen-only diagnostic."
  - "RTL test infra: vitest.config.ts switched from no-env to environment: 'jsdom' globally. Verified existing 163 tests (mix of pure logic + DB-touching + fetch-mocking) still pass under jsdom — no Node-only tests broke. setupFiles loads @testing-library/jest-dom/vitest once."
  - "@vitejs/plugin-react: vitest 4.1.1 + rolldown does NOT parse JSX without a transform plugin. Added @vitejs/plugin-react devDep + plugin to vitest.config.ts. Doesn't affect Next.js build (next has its own transform). No tsconfig changes needed."

patterns-established:
  - "Pattern: CSS-variable driven dashboard live-update — parent owns the state, children compose with var() expressions, browser interpolates with transition-all. Reuse anywhere the dashboard needs animated state from an SSE stream."
  - "Pattern: three-tier rendering fallback for SSE-driven components — live data → SSR snapshot → noscript ASCII → null. Lets the same component handle first paint, mid-session reconnect, and JS-disabled scrapers without branching code paths."
  - "Pattern: settings autosave with validation gate — useState(rawInput) + useAutoSave(key, validate(rawInput), initial). Typing intermediates don't fire PUTs."
  - "Pattern: SSE active-replay augmentation — new columns SELECTed at stream-open time keep mid-session reconnects feature-parity with the live stream. Each new ChargeStateEvent field needs a parallel SELECT + snapshot literal addition here."

requirements-completed: [SOCB-06]

verification:
  - "pnpm exec vitest run → 171/171 passed across 15 files (was 163/13 baseline, +8 new: 5 SocBandIndicator + 3 ChargingSettings)"
  - "pnpm exec tsc --noEmit → exit 0"
  - "All Task 1 acceptance grep checks pass (use client, useChargeStream, --soc-min/max, transition-all duration-700, <noscript>, SocBandIndicator in charge-banner)"
  - "All Task 2 acceptance grep checks pass (use client, charging.stopMode x2, charging.bandThreshold x2, DEFAULT_BAND_THRESHOLD_PCT x3, charging-stop-mode radios x2, aggressive/conservative x2, ChargingSettings in settings page x2, SSE band fields x6, .skip/.todo count 0)"

duration: ~6min
completed: 2026-05-14
---

# Phase 11 Plan 04: Live SOC Confidence Band UI + Settings Toggle Summary

**Live CSS-animated SOC band on the dashboard charge banner driven by --soc-min/--soc-max custom properties on a parent element; <pre>ASCII</pre> fallback when band fields missing; <noscript> ASCII for JS-disabled clients. Settings page exposes the stop-mode radio (aggressive default) and an advanced band-threshold input via the existing useAutoSave debounce pattern. SSE active-replay hydrates band columns from chargeSessions so mid-session tab reloads see the band immediately.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-14T21:52:28Z
- **Completed:** 2026-05-14T21:58:44Z
- **Tasks:** 2/2
- **Files modified:** 5 (+ 5 created)
- **Test delta:** 163 → 171 (+8)

## Accomplishments

### Task 1 — SocBandIndicator + ChargeBanner wiring

- **`src/components/charging/soc-band-indicator.tsx` (new client component, 113 lines).** Props: `{ plugId: string; initialAsciiBar?: string }`. Internal state holds the latest band object; `useChargeStream(plugId, cb)` listens for live events. When a charge event arrives with `socMin/socMax/estimatedSoc/targetSoc` all defined, the component renders a `<div data-testid="band-container">` with the four CSS variables `--soc-min`, `--soc-max`, `--soc-best`, `--soc-target` set on inline `style`. Three children:
  - Band fill — `class="absolute bg-blue-500/30 transition-all duration-700 ease-out"` with `left: var(--soc-min)` and `width: calc(var(--soc-max) - var(--soc-min))`.
  - Best marker — `w-0.5 bg-blue-300 transition-all duration-700 ease-out` with `left: var(--soc-best)`.
  - Target marker — `w-0.5 bg-emerald-400` (no transition; target is user-set, doesn't animate).
- **Three-tier fallback.** No initial ASCII and no live event → returns `null`. Initial ASCII but no live event → `<pre data-testid="soc-band-ascii">` with the bar text. Live event present → CSS band container (plus a wide-screen `<pre>` for the rendered ASCII when available, hidden on mobile via `hidden xl:block`). All three branches include a `<noscript>` wrapper carrying the initial ASCII so JS-disabled browsers see something.
- **ChargeBanner wired.** `SessionState` widened to include `socMin/socMax/socBandConfidence/socAsciiBar` (was narrower than `ChargeStateEvent`). `onChargeEvent` extended to copy those four optional fields onto state. Component inserted in the non-countdown big-percent branch directly below the existing 1.5px progress bar, in a `<div className="mt-2">` wrapper.
- **5 tests pass** (RTL + jsdom): ASCII fallback, no-display when nothing to render, CSS-variable drive from a live event, missing-field guard skips band layer, transition class verification.

### Task 2 — ChargingSettings + Settings page + SSE active-replay band hydration

- **`src/components/settings/charging-settings.tsx` (new client component, 151 lines).** Modeled on `electricity-settings.tsx`. Uses an inline duplicate of `useAutoSave` (500ms debounce, PUT `/api/settings`) per plan note N2 — folding into a shared hook is v1.3 backlog. Imports `DEFAULT_BAND_THRESHOLD_PCT` from `@/modules/charging/curve-matcher` so the UI default stays synchronized with Plan 11-01's empirical pin (currently 0.05).
- **Stop-mode radio group.** Two `<input type="radio" name="charging-stop-mode">` options: "Aggressiv" (value `aggressive`, default) and "Konservativ" (value `conservative`). Each wrapped in a `<label>` whose visible text matches the accessible name so `getByRole('radio', { name: /.../ })` works. Autosave PUTs `{ key: 'charging.stopMode', value }` on change. Below: a save-status indicator ("Speichere…" / "Gespeichert ✓").
- **Advanced threshold panel (collapsed by default).** Toggle button `Erweitert anzeigen` ↔ `Erweitert ausblenden`. When expanded, a `<label for="charging-band-threshold">` plus `<input id="..." type="number" step="0.01" min="0.05" max="0.50" placeholder="0.05">` (placeholder = `String(DEFAULT_BAND_THRESHOLD_PCT)`). The displayed input value is `threshold` (raw); the **persisted** value is `validatedThreshold` — `parseFloat(threshold)` checked to be `>= 0.05 && <= 0.50`, otherwise it falls back to `initialThreshold`. This prevents typing intermediates like `"0."` from firing a PUT.
- **Settings page wired.** New `<SettingsSection title="Laden" description="Stopp-Verhalten und Band-Konfiguration">` inserted between `Strompreis` (ElectricitySettings) and `Auto-Update` (AutoUpdateSettings) in `src/app/settings/page.tsx`. The user-mental-model grouping is electricity → charging → maintenance.
- **SSE `/api/sse/power` active-replay branch hydrates band fields.** Three new SELECT columns: `socMin: chargeSessions.socMin, socMax: chargeSessions.socMax, bandConfidence: chargeSessions.bandConfidence`. Three new snapshot literal fields: `socMin: row.socMin ?? undefined, socMax: row.socMax ?? undefined, socBandConfidence: row.bandConfidence ?? undefined`. `socAsciiBar` stays undefined on replay (not stored in the chargeSessions row — it's rendered at snapshot time in `captureEventContext` from the band anchors, which the dashboard's CSS-variable indicator doesn't need anyway). Live `chargeHandler` already JSON.stringifies the whole event opaquely — no code change in the live-stream branch.
- **3 REQUIRED component tests pass** (W6 closed, not skipped, no todo markers): mount renders both radios with `aggressive` default, advanced toggle reveals the threshold input with the empirical default placeholder, hydration from `initialSettings` round-trips conservative + 0.20.

## Task Commits

| Task | Hash | Type | Description |
|------|------|------|-------------|
| Task 1 RED | `076e418` | test | failing tests for SocBandIndicator + RTL/jsdom test infra (devDeps + vitest.config jsdom switch) |
| Task 1 GREEN | `0fde40e` | feat | SocBandIndicator with CSS-driven band + ASCII fallback, wired into ChargeBanner |
| Task 2 RED | `92247dd` | test | failing tests for ChargingSettings (mount, advanced toggle, hydration) |
| Task 2 GREEN | `f6bf773` | feat | ChargingSettings (stop-mode + band threshold) + SSE active-replay band hydration |

## Files Created/Modified

### Created

- `src/components/charging/soc-band-indicator.tsx` — Live CSS-driven band component, 113 lines, `'use client'`.
- `src/components/charging/soc-band-indicator.test.tsx` — 5 RTL tests (jsdom env), uses `vi.mock('@/hooks/use-charge-stream')` to capture the callback and drive events synthetically.
- `src/components/settings/charging-settings.tsx` — Stop-mode radios + advanced threshold input + duplicate useAutoSave, 151 lines, `'use client'`.
- `src/components/settings/charging-settings.test.tsx` — 3 RTL tests, stubs `globalThis.fetch` in beforeEach so the autosave PUT doesn't hit the network.
- `vitest.setup.ts` — One-line `import '@testing-library/jest-dom/vitest'` for toBeInTheDocument matchers across all component tests.

### Modified

- `src/components/charging/charge-banner.tsx` — Import `SocBandIndicator`; widen local `SessionState` with `socMin/socMax/socBandConfidence/socAsciiBar`; `onChargeEvent` setSession includes those fields; insert `<div className="mt-2"><SocBandIndicator plugId={plugId} initialAsciiBar={session.socAsciiBar} /></div>` directly below the existing progress bar in the non-countdown branch.
- `src/app/settings/page.tsx` — Import `ChargingSettings`; insert new `<SettingsSection title="Laden">` between Strompreis and Auto-Update.
- `src/app/api/sse/power/route.ts` — Active-replay SELECT adds `socMin/socMax/bandConfidence`; snapshot literal adds `socMin/socMax/socBandConfidence` (mapping `bandConfidence` → `socBandConfidence` to match the wire type).
- `vitest.config.ts` — Add `@vitejs/plugin-react` plugin, `environment: 'jsdom'`, `setupFiles: ['./vitest.setup.ts']`. All 163 pre-existing tests still pass under the new config (verified before adding new tests).
- `package.json` / `pnpm-lock.yaml` — Add `@testing-library/react@16.3.2`, `@testing-library/jest-dom@6.9.1`, `@testing-library/user-event@14.6.1`, `jsdom@29.1.1`, `@vitejs/plugin-react@6.0.2` as devDependencies.

## Decisions Made

### CSS-variable names locked

`--soc-min`, `--soc-max`, `--soc-best`, `--soc-target`. All `${pct}%` strings (not unitless). The band fill's width uses `calc(var(--soc-max) - var(--soc-min))` so the browser computes it during layout — no JavaScript width calculation, no resize-observer, no layout thrash.

### Tailwind classes for the band fill

`absolute top-0 bottom-0 bg-blue-500/30 rounded-sm transition-all duration-700 ease-out`. The `bg-blue-500/30` is a translucent blue (30% alpha) so the underlying neutral track shows through. `transition-all` interpolates left + width when CSS variables change; `duration-700` is the sweet spot between "instant" (looks like a teleport) and "slow" (looks laggy). `ease-out` decelerates at the end, matching what users expect from physics-like UI.

### Target marker has no transition

`w-0.5 bg-emerald-400` — fixed width, fixed colour, no `transition-*` class. The target is user-set (via the SocButtons control); when it changes, an abrupt jump is correct behaviour (the user just clicked 80%, they expect the green line at 80% immediately, not animating from wherever it was).

### Render returns null when neither band nor initial ASCII

The plan says "If `band == null` → return null (no display, parent uses legacy fallback)". React strips `null` children entirely, so the parent's `<div className="mt-2">` collapses to its minimum size without leaving a visual gap. The legacy single-percent display above is unchanged.

### SettingsSection title in German

The project convention is German section titles ("Pushover", "Strompreis", "Auto-Update", "Profil-Katalog"). Chose "Laden" (= "Charging") with description "Stopp-Verhalten und Band-Konfiguration". Other candidates considered: "Laden & Stopp" (clunky), "Lade-Verhalten" (only describes half the section). "Laden" is the shortest match for the user's mental model.

### useAutoSave duplication accepted

The plan's N2 note explicitly states factoring into a shared hook is "acceptable v1.3 backlog. The duplicated implementation is 25 lines." I copied the implementation verbatim from electricity-settings.tsx with one comment added explaining why. Future quick-task: extract to `@/hooks/use-autosave-config` and migrate both call-sites.

### Threshold validation bounds [0.05, 0.50]

Plan 11-01's calibration sweep tested `[0.05, 0.10, 0.15, 0.20, 0.30]`. The lower bound 0.05 is the pinned default; the upper bound 0.50 is generously wider than anything the sweep validated. Outside [0.05, 0.50] the matcher's behaviour is unverified — the UI hard-caps to prevent users from setting values that haven't been calibrated. The Validation gate (parseFloat + range check) fires before the autosave PUT so intermediates like "0." don't persist.

### SSE active-replay does NOT hydrate socAsciiBar

socAsciiBar is rendered at snapshot time in `captureEventContext` (Plan 11-03 W1) from socMin/socMax/socBest/targetSoc. It's NOT stored in the chargeSessions DB row. On reconnect, the active-replay branch hydrates the band anchors (socMin/socMax/bandConfidence) but not the rendered string. The dashboard's `SocBandIndicator` reads `--soc-min/--soc-max/--soc-best/--soc-target` from the event — it never needs `socAsciiBar` to draw the CSS band. The wide-screen `<pre>` diagnostic stays empty for ~5-10 seconds after reconnect until the next live event arrives from ChargeMonitor; this is intentional (the canonical visualization is the CSS band, not the ASCII string).

### Vitest jsdom global switch + @vitejs/plugin-react

vitest 4.1.1 ships with rolldown, which does NOT transform JSX by default. The Vite React plugin (`@vitejs/plugin-react`) handles JSX/TSX in test files without affecting the Next.js build (Next has its own transform pipeline). Setting `environment: 'jsdom'` globally instead of per-file (via `// @vitest-environment jsdom` headers) is simpler — all 163 pre-existing tests pass under jsdom because they're either pure logic, fetch-mocking, or DB-touching (better-sqlite3 works inside jsdom too).

### W6 — test is REQUIRED, not skippable

`charging-settings.test.tsx` contains three real, non-skipped tests. `grep -nE '\.skip\(|\.todo\(' src/components/settings/charging-settings.test.tsx` returns 0. The plan's W6 closure requires the test to be present and active; this is verified by the acceptance check.

## Deviations from Plan

### None of substance. Two operational adjustments:

**1. `[Rule 3 - Blocker] Test infrastructure was absent.** The plan assumed `@testing-library/react` and `jsdom` were available (per `<interfaces>` in 11-04-PLAN.md: "jsdom environment is already configured. Use @testing-library/react for RTL tests"). Reality: `package.json` had neither devDep, and `vitest.config.ts` had no environment setting. Fix (added in Task 1 RED commit `076e418`):
- `pnpm add -D @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom`
- `pnpm add -D @vitejs/plugin-react` (needed for JSX transform under vitest 4.1.1's rolldown)
- `vitest.config.ts` switched to `environment: 'jsdom'` with `plugins: [react()]` and `setupFiles: ['./vitest.setup.ts']`
- `vitest.setup.ts` (new) loads `@testing-library/jest-dom/vitest` matchers

**Verification:** All 163 pre-existing tests still pass under the new config (run before adding new tests). +8 new tests bring the total to 171.

**2. node_modules absent on worktree start.** Same as Plans 11-01/11-02/11-03 — `pnpm install --frozen-lockfile` + `pnpm rebuild better-sqlite3` + `pnpm run gen:version` at the start. Standard worktree setup, not a code deviation.

No Rule 1 bugs. No Rule 2 missing functionality. No Rule 4 architectural changes.

## Verification Evidence

| Check | Result |
|-------|--------|
| `pnpm exec vitest run` | **171/171 passed across 15 files** (was 163/13 baseline, +8 new) |
| `pnpm exec tsc --noEmit` | exit 0 |
| `test -f src/components/charging/soc-band-indicator.tsx` | exists |
| `test -f src/components/charging/soc-band-indicator.test.tsx` | exists |
| `grep -n "'use client'" src/components/charging/soc-band-indicator.tsx` | 1 match (top of file) |
| `grep -nE "useChargeStream\(" src/components/charging/soc-band-indicator.tsx` | 1 match |
| `grep -nE "'--soc-min'\|'--soc-max'" src/components/charging/soc-band-indicator.tsx \| wc -l` | 2 (both CSS variables) |
| `grep -nE "transition-all\s+duration-700" src/components/charging/soc-band-indicator.tsx \| wc -l` | 2 (band-fill + best-marker) |
| `grep -n "<noscript>" src/components/charging/soc-band-indicator.tsx` | 2 matches (in both fallback render branches) |
| `grep -n "SocBandIndicator" src/components/charging/charge-banner.tsx` | 3 matches (import + comment + render) |
| `test -f src/components/settings/charging-settings.tsx` | exists |
| `test -f src/components/settings/charging-settings.test.tsx` | exists — REQUIRED (W6 closed) |
| `grep -n "'use client'" src/components/settings/charging-settings.tsx` | 1 match |
| `grep -n "charging.stopMode" src/components/settings/charging-settings.tsx` | 2 matches (initial read + useAutoSave key) |
| `grep -n "charging.bandThreshold" src/components/settings/charging-settings.tsx` | 2 matches |
| `grep -n "DEFAULT_BAND_THRESHOLD_PCT" src/components/settings/charging-settings.tsx` | 3 matches (import + initial fallback + placeholder) |
| `grep -nE "name=\"charging-stop-mode\"" src/components/settings/charging-settings.tsx \| wc -l` | 2 (both radio inputs) |
| `grep -nE "value=\"aggressive\"\|value=\"conservative\"" src/components/settings/charging-settings.tsx \| wc -l` | 2 |
| `grep -n "ChargingSettings" src/app/settings/page.tsx` | 2 matches (import + render) |
| `grep -nE "socMin\|socMax\|bandConfidence" src/app/api/sse/power/route.ts \| grep -v '//'` | 6 matches (3 in SELECT + 3 in snapshot literal) |
| `grep -nE "\.skip\(\|\.todo\(" src/components/settings/charging-settings.test.tsx \| wc -l` | 0 (W6: no skip/todo markers) |

### Acceptance run summary

```
Test Files  15 passed (15)
     Tests  171 passed (171)
  Duration  1.71s
```

## Reference Data for Downstream

Plan 11-04 closes the user-facing loop for Phase 11. The dashboard now shows the band live, settings expose the toggle, and SSE reconnect preserves the band. Future phases inheriting this UI:

- **Component reuse:** `<SocBandIndicator plugId="..." initialAsciiBar="..." />` can drop into any new dashboard card that listens to `/api/sse/power`. The mobile/wide-screen split is built in.
- **Settings expansion:** ChargingSettings is the template for any future per-domain config UI. Same pattern: useAutoSave + validation gate + advanced section behind a toggle.
- **CSS-variable pattern:** Any future dashboard live-update can copy the `--soc-min`/`--soc-max` approach — parent container owns the state via CSS variables, children compose with `var()` and `calc()`, browser handles transitions.

## Known Stubs

None. The component is fully wired end-to-end:
- `SocBandIndicator` reads from `useChargeStream` which reads from `/api/sse/power` which forwards real events from `ChargeMonitor.emitChargeEvent` (Plan 11-02) carrying real band fields (Plan 11-01 deriveBand) and a real ASCII bar (Plan 11-03 renderSocBandAscii).
- `ChargingSettings` PUTs to `/api/settings` which writes to the `config` table; the state machine reads `charging.stopMode` at setMatch time (Plan 11-02) and the matcher reads `charging.bandThreshold` similarly.
- SSE active-replay SELECTs real columns added in migration 0009 (Plan 11-02).

## Threat Flags

None. No new network endpoints (PUT /api/settings is pre-existing), no new auth paths, no schema changes (uses Plan 11-02's columns), no file-system access. The Vitest config change is build-time only.

## Self-Check

- `src/components/charging/soc-band-indicator.tsx` ✓ exists; `'use client'` at top; imports `useChargeStream` from `@/hooks/use-charge-stream`; sets `--soc-min`, `--soc-max`, `--soc-best`, `--soc-target` on band-container; has `transition-all duration-700` on band-fill + best-marker; has `<noscript>` blocks
- `src/components/charging/soc-band-indicator.test.tsx` ✓ exists; 5 tests; uses RTL + jsdom; mocks `useChargeStream`
- `src/components/charging/charge-banner.tsx` ✓ imports `SocBandIndicator`; widens SessionState; renders `<SocBandIndicator>` in non-countdown branch with `plugId` + `initialAsciiBar`
- `src/components/settings/charging-settings.tsx` ✓ exists; `'use client'`; imports `DEFAULT_BAND_THRESHOLD_PCT`; persists `charging.stopMode` + `charging.bandThreshold`; advanced toggle pattern; useAutoSave duplicate (per N2)
- `src/components/settings/charging-settings.test.tsx` ✓ exists; 3 tests; W6 closed — REQUIRED, no skip, no todo
- `src/app/settings/page.tsx` ✓ imports + renders `ChargingSettings` in new `Laden` SettingsSection between Strompreis and Auto-Update
- `src/app/api/sse/power/route.ts` ✓ SELECT includes socMin/socMax/bandConfidence; snapshot literal includes socMin/socMax/socBandConfidence
- Commits: `076e418` (Task 1 RED) ✓, `0fde40e` (Task 1 GREEN) ✓, `92247dd` (Task 2 RED) ✓, `f6bf773` (Task 2 GREEN) ✓
- `pnpm exec vitest run` → 171/171 ✓
- `pnpm exec tsc --noEmit` → exit 0 ✓

## Self-Check: PASSED

---
*Phase: 11-soc-confidence-band-ascii-visualization*
*Completed: 2026-05-14*
