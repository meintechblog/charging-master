# Phase 11: SOC Confidence Band + ASCII Visualization — Research

**Researched:** 2026-05-14
**Domain:** DTW alignment-ambiguity quantification, monospace push notification rendering, additive event/SSE evolution
**Confidence:** HIGH for the DTW math and rendering decisions, MEDIUM for the empirical band-threshold value (15 % is a starting guess that the plan must include a calibration step for)

## Summary

Phase 11 replaces a single-point `estimatedStartSoc` with a confidence band `{socMin, socMax, socBest, bandConfidence}` derived from the **full distribution of DTW subsequence-match scores**, not just the global minimum. The standard MIR-textbook technique is exactly what we need: scan the cost row produced by subsequence DTW and pick every offset whose normalized cost is within a relative threshold of the best — those offsets translate 1:1 to candidate start-SOC values via the existing `(offsetSeconds / totalDuration) * 100` mapping.

Every piece of the surrounding infrastructure cooperates: the `ChargeStateEvent` SSE format is additive (clients already destructure only the fields they need; `use-charge-stream.ts` does a plain `JSON.parse` and forwards), the `config` table is a string key/value store that already follows a dotted-key convention (`pushover.userKey`, `electricity.priceEurPerKwh`) and a 13-line autosave UI pattern (`electricity-settings.tsx`) drops in cleanly, and the Pushover client only needs one extra optional field (`monospace?: 0|1`). The backwards-compatibility constraint from CONTEXT (`estimatedStartSoc` kept as alias for `socBest`) means we can ship without touching the resume code, the override API, or the calibration loop.

**Primary recommendation:** Refactor `subsequenceDtw` to return a third field — the full `distances: number[]` array indexed by offset — without changing its existing two callers, then derive the band in `curve-matcher.ts` by scanning `distances` for offsets within `(1 + threshold) * bestDistance`. Persist `socMin`/`socMax` on the in-memory `MatchResult` and on `chargeSessions` columns so resume keeps the band. Build a pure `renderSocBandAscii()` module using ASCII-only characters for Pushover safety (Unicode box-drawing renders fine in iOS/Android *messages* but Pushover explicitly disclaims monospace support on *the lock-screen payload itself* — see Q4) and let the dashboard render a richer Unicode/CSS version.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| DTW score-distribution extraction | Domain (`modules/charging/dtw.ts`) | — | Pure compute, no I/O |
| Band derivation from offsets | Domain (`modules/charging/curve-matcher.ts`) | — | Profile-aware mapping (offset → SOC), already lives here |
| Band forward-propagation in session | Domain (`modules/charging/charge-monitor.ts`) | DB (chargeSessions persistence) | Per-plug runtime state + DB for resume |
| Stop-mode policy | Domain (`charge-state-machine.ts`) | Config (`config` table) | State machine reads policy from DB at transition time |
| ASCII rendering | Domain (`modules/charging/ascii-bar.ts` — new) | — | Pure function, no deps, snapshot-testable |
| Pushover delivery | Notifications (`notification-service.ts`) | HTTP client (`pushover-client.ts`) | NotificationService owns body composition; client owns transport |
| SSE wire format | API (`/api/sse/power/route.ts`) | — | Already passes ChargeStateEvent through opaquely; additive change only |
| Live band visualization | Browser/Client (React component) | — | CSS-driven, reads SSE fields, falls back to ASCII bar from server |
| Stop-mode toggle UI | Browser/Client (`components/settings/charging-settings.tsx` — new) | API (`/api/settings`) | Reuses existing autosave pattern |
| Stop-mode persistence | Database (`config` table) | — | Existing key/value pattern; no schema change |
| Band persistence for resume | Database (`chargeSessions` table) | — | New columns `soc_min`, `soc_max`, `band_confidence` via Drizzle migration |

## Standard Stack

This phase is internal logic + UI + tests. No new libraries are needed.

### Core (already in the project)

| Library | Version (verified) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 [VERIFIED: package.json] | Type safety on new band fields | Already the project standard |
| Drizzle ORM | 0.45.1 [VERIFIED: package.json] | Add `soc_min`/`soc_max`/`band_confidence` columns to `chargeSessions` | Existing schema management; migration via `drizzle-kit generate` then `tsx scripts/db/migrate.ts` |
| Vitest | 4.1.1 [VERIFIED: package.json] | Property tests for band collapse, snapshot tests for renderer | Existing test framework |
| echarts | 6.0.0 [VERIFIED: package.json] | Optional — could render band as a horizontal stacked bar; NOT recommended, see Q10 | Already a dependency but heavyweight for one bar |
| zod | 4.3.6 [VERIFIED: package.json] | Validate `config.charging.stopMode` value on read | Existing validation idiom at boundaries |

### Supporting (existing patterns to reuse)

| Pattern | Where | When to Use |
|---------|-------|-------------|
| `config` key/value table | `src/db/schema.ts:27`, accessed via `db.select().from(config).where(eq(config.key, '...')).get()` | New setting `charging.stopMode` |
| `useAutoSave(key, value, initial)` hook | `src/components/settings/electricity-settings.tsx:9-33` | Drop-in autosave for the toggle; copy/paste |
| `SettingsSection` wrapper | `src/components/settings/settings-section.tsx` | Frame the new toggle in `/settings` |
| `captureEventContext` snapshot | `src/modules/charging/charge-monitor.ts:905` | Extend to capture `socMin/socMax/socBandConfidence/socAsciiBar` so the post-await `complete` event keeps the band |
| Detection-phase additive fields on `ChargeStateEvent` | `src/modules/charging/types.ts:66-77` (`bestCandidate*`) | Same shape: new fields are optional `?` types, existing clients ignore them silently |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Refactoring `subsequenceDtw` to return all distances | Re-run DTW per offset in `curve-matcher` | Wastes ~5× CPU; we already compute every offset, just discard them. Reject. |
| ASCII string in payload | HTML `<pre>` via `html=1` Pushover flag | `monospace=1` and `html=1` are mutually exclusive [CITED: pushover.net/api]. ASCII is more universal. Reject HTML. |
| ECharts horizontal-bar component for band | Pure CSS gradient with CSS variables | ECharts re-renders ~20 ms/frame on each SSE event = thrash. CSS variables update in 0 ms on the GPU compositor. Pick CSS. |
| Storing band on `chargeSessions` | Recomputing on resume from `curveOffsetSeconds` only | Resume would not have the historic plausible-offset set; band would re-widen on restart even when it had narrowed. Persist it. |
| Per-profile band-threshold override | Global `charging.bandThreshold` setting | CONTEXT non-goals: "Single global threshold". Honor. |

## Architecture Patterns

### System Architecture Diagram

```
                  ┌───────────────────────────────────────────────────┐
                  │  Shelly HTTP Polling (existing, unchanged)        │
                  └──────────────────┬────────────────────────────────┘
                                     │ apower reading
                                     ▼
                  ┌───────────────────────────────────────────────────┐
                  │  ChargeMonitor.handlePowerReading                 │
                  │  ┌──────────────────────────────────────────────┐ │
                  │  │ tryMatch(buffer, profiles)                   │ │
                  │  │   └─ findBestCandidate                       │ │
                  │  │      └─ subsequenceDtw → { offset, distance, │ │
                  │  │                            distances[] }     │ │  ← NEW
                  │  │   └─ deriveBand(distances, threshold)        │ │  ← NEW
                  │  │      → { socMin, socMax, socBest,            │ │
                  │  │          bandConfidence }                    │ │
                  │  └──────────────────────────────────────────────┘ │
                  │  ┌──────────────────────────────────────────────┐ │
                  │  │ updateSocTracking(reading)                   │ │
                  │  │   • Forward-propagate socMin/socMax/socBest  │ │  ← NEW
                  │  │     via Wh accumulation (same math, 3 anchors│ │
                  │  │     instead of 1)                            │ │
                  │  │   • Clamp to [0, 100]                        │ │
                  │  └──────────────────────────────────────────────┘ │
                  │  ┌──────────────────────────────────────────────┐ │
                  │  │ ChargeStateMachine.handleCharging/Countdown  │ │
                  │  │   • Read config.charging.stopMode            │ │  ← NEW
                  │  │   • Aggressive: socBest≥target AND           │ │
                  │  │     socMax-socMin≤5                          │ │
                  │  │   • Conservative: socMin≥target              │ │
                  │  └──────────────────────────────────────────────┘ │
                  │  ┌──────────────────────────────────────────────┐ │
                  │  │ emitChargeEvent → ChargeStateEvent           │ │
                  │  │   • +socMin, +socMax, +socBandConfidence,    │ │  ← NEW
                  │  │     +socAsciiBar                             │ │
                  │  └──────────────────────────────────────────────┘ │
                  └──────────────────┬────────────────────────────────┘
                                     │
                  ┌──────────────────┼────────────────────────┐
                  ▼                  ▼                        ▼
        ┌─────────────────┐ ┌──────────────────┐  ┌────────────────────────┐
        │ DB persist:     │ │ EventBus         │  │ Stop trigger →         │
        │ chargeSessions  │ │ charge:*         │  │ relay-controller       │
        │ + soc_min,      │ └────────┬─────────┘  └────────────────────────┘
        │   soc_max,      │          │
        │   band_conf     │          ├─────────────────────┐
        └─────────────────┘          ▼                     ▼
                          ┌─────────────────────┐ ┌─────────────────────┐
                          │ NotificationService │ │ /api/sse/power      │
                          │  • Render ASCII bar │ │ • Forward event     │
                          │    (server-side)    │ │   verbatim          │
                          │  • Pushover with    │ └──────────┬──────────┘
                          │    monospace=1      │            │
                          └─────────────────────┘            ▼
                                                  ┌─────────────────────┐
                                                  │ useChargeStream     │
                                                  │ → React component   │
                                                  │   live band w/ CSS  │
                                                  │   animation + ASCII │
                                                  │   fallback          │
                                                  └─────────────────────┘
```

### Recommended Project Structure

```
src/modules/charging/
├── dtw.ts                       # MODIFY: subsequenceDtw returns distances[]
├── curve-matcher.ts             # MODIFY: derive band from distances
├── charge-monitor.ts            # MODIFY: forward band; captureEventContext extended
├── charge-state-machine.ts      # MODIFY: handleCharging/Countdown read stopMode
├── soc-estimator.ts             # MODIFY: estimateSocBand({socMin,socMax,socBest}, ...) pure fn
├── types.ts                     # MODIFY: MatchResult + ChargeStateEvent additive fields
├── ascii-bar.ts                 # NEW: renderSocBandAscii pure function
├── stop-mode.ts                 # NEW: pure resolver readStopMode() + types
├── ascii-bar.test.ts            # NEW: ≥6 snapshot tests
├── stop-mode.test.ts            # NEW: aggressive/conservative decision tests
├── curve-matcher.test.ts        # NEW: property test for band collapse in taper
└── fixtures/
    └── ipad-reference-curve.json  # NEW: snapshot from reference_curve_points id=4

src/modules/notifications/
├── notification-service.ts      # MODIFY: embed bar in matched/complete/anomaly
└── pushover-client.ts           # MODIFY: optional monospace?: 0|1 field

src/components/charging/
└── soc-band-indicator.tsx       # NEW: live CSS band component

src/components/settings/
└── charging-settings.tsx        # NEW: stopMode toggle (autosave pattern)

src/db/
└── schema.ts                    # MODIFY: chargeSessions + soc_min, soc_max, band_confidence

drizzle/
└── XXXX_add_soc_band_columns.sql  # NEW: migration (auto-generated by drizzle-kit)
```

### Pattern 1: Subsequence DTW Distance Vector

**What:** Standard MIR/audiolabs-erlangen technique — the bottom row of the DTW accumulated-cost matrix is the matching function. Every column `m` of that row is the cost of the best alignment ending at offset `m`. Scanning that row produces the full distribution of plausible offsets, which is exactly what we need to derive a confidence band.

**When to use:** Whenever you have a subsequence-DTW result and want "how many other offsets fit nearly as well as the best?"

**Example:**
```typescript
// MODIFIED src/modules/charging/dtw.ts
export interface SubsequenceDtwResult {
  offset: number;
  distance: number;
  /** Normalized distance per evaluated offset, indexed by step.
   *  distances[k] is the distance at reference offset (k * windowStep).
   *  Length = floor((refLen - queryLen) / windowStep) + 1. */
  distances: Float64Array;
  windowStep: number;
}

export function subsequenceDtw(
  query: number[],
  reference: number[],
  windowStep: number = 5
): SubsequenceDtwResult {
  // ... same DTW loop ...
  // Collect every dist into a Float64Array sized to the offset grid
}

// NEW src/modules/charging/curve-matcher.ts: deriveBand helper
function deriveBand(
  distances: Float64Array,
  windowStep: number,
  curvePoints: ProfileWithCurve['curvePoints'],
  totalDurationSeconds: number,
  thresholdPct: number   // e.g. 0.15 → "within 15% of best"
): { socMin: number; socMax: number; socBest: number; bandConfidence: number } {
  if (distances.length === 0) return { socMin: 0, socMax: 100, socBest: 0, bandConfidence: 0 };

  let best = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < distances.length; i++) {
    if (distances[i] < best) { best = distances[i]; bestIdx = i; }
  }

  const cutoff = best * (1 + thresholdPct);
  let socMin = 100;
  let socMax = 0;
  let plausibleCount = 0;
  for (let i = 0; i < distances.length; i++) {
    if (distances[i] > cutoff) continue;
    plausibleCount++;
    const offsetSeconds = curvePoints[i * windowStep]?.offsetSeconds ?? 0;
    const soc = totalDurationSeconds > 0
      ? Math.round((offsetSeconds / totalDurationSeconds) * 100)
      : 0;
    if (soc < socMin) socMin = soc;
    if (soc > socMax) socMax = soc;
  }

  const bestOffsetSeconds = curvePoints[bestIdx * windowStep]?.offsetSeconds ?? 0;
  const socBest = totalDurationSeconds > 0
    ? Math.round((bestOffsetSeconds / totalDurationSeconds) * 100)
    : 0;

  // Confidence = 1 - (width / 100). Narrower band = higher confidence.
  // Floor at 0 so a degenerate full-uncertainty band reads as 0 not negative.
  const bandConfidence = Math.max(0, 1 - (socMax - socMin) / 100);

  return { socMin, socMax, socBest, bandConfidence };
}
```

[CITED: https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7S2_SubsequenceDTW.html — "Δ_DTW(m) = D(N,m)/N represents the normalized cost at each position m in the longer sequence Y. Rather than selecting only the global minimum, you can analyze this entire row to find alternative matches."]

### Pattern 2: Forward-Propagation of Band Edges

**What:** Once `{socMin, socMax}` is set at match time, the same `currentWh / totalEnergyWh` math that already drives `estimateSoc` runs independently for each band edge. The band only narrows when a *new matcher run* shrinks the plausible-offset set; Wh accumulation slides all three numbers forward in lock-step.

**When to use:** During every `updateSocTracking` call.

**Example:**
```typescript
// In updateSocTracking after the existing estimateSoc call:
const socBest = estimateSoc(socWh, curve.totalEnergyWh, match.estimatedStartSoc);
const socMin = estimateSoc(socWh, curve.totalEnergyWh, match.socMin ?? match.estimatedStartSoc);
const socMax = estimateSoc(socWh, curve.totalEnergyWh, match.socMax ?? match.estimatedStartSoc);

machine.estimatedSoc = socBest;
// Store the propagated band edges on the per-plug state so emitChargeEvent picks them up
this.sessionSocMin.set(plugId, socMin);
this.sessionSocMax.set(plugId, socMax);
```

**Edge cases:**
- `socMax > 100` after propagation → clamp to 100. The matcher's existing 100-clamp in `estimateSoc` handles this.
- `socMin` at 0 with `socMax` at 100 → "full uncertainty" band. The renderer must handle this without crashing (no division by zero, no negative-width segments).
- Band collapses to a single value (socMin == socMax == socBest) after an override → renderer must still draw one `▓` marker.

### Pattern 3: Pure ASCII Renderer

**What:** Stateless function that maps `{socMin, socMax, socBest, targetSoc, width}` to a 2-line string: a tick scale row and a value row. No DOM, no React, no I/O — testable via Vitest snapshots.

**Example:**
```typescript
// src/modules/charging/ascii-bar.ts
export interface SocBandRender {
  socMin: number;
  socMax: number;
  socBest: number;
  targetSoc: number;
  width?: number;  // default 40
}

export function renderSocBandAscii(input: SocBandRender): string {
  const width = input.width ?? 40;
  // Map [0,100] → [0,width-1]
  const toCol = (pct: number) =>
    Math.max(0, Math.min(width - 1, Math.round((pct / 100) * (width - 1))));

  const minCol = toCol(input.socMin);
  const maxCol = toCol(input.socMax);
  const bestCol = toCol(input.socBest);
  const targetCol = toCol(input.targetSoc);
  const coreLo = toCol(Math.max(0, input.socBest - 5));
  const coreHi = toCol(Math.min(100, input.socBest + 5));

  // Tick scale: 0..100 in 10% steps. Use ASCII | for ticks, - for spacers.
  // (Unicode ├ ┼ ┤ render fine in iOS Mail but Pushover docs explicitly disclaim
  //  monospace support in the push payload itself — keep ASCII for safety. See Q4.)
  const ticks = '0   10  20  30  40  50  60  70  80  90  100';
  const scale = Array.from({ length: width }, (_, i) =>
    i === 0 || i === width - 1 ? '|'
      : (i % Math.round((width - 1) / 10) === 0) ? '+'
        : '-'
  ).join('');

  // Bar row: '#' for core (best ± 5), '=' for band, '.' for outside, '^' for best, 'T' for target
  const bar = Array.from({ length: width }, (_, i) => {
    if (i >= coreLo && i <= coreHi) return '#';
    if (i >= minCol && i <= maxCol) return '=';
    return '.';
  });
  // Best marker on a third row (avoids clashing with the bar glyphs):
  const markers = Array.from({ length: width }, (_, i) => {
    if (i === bestCol && i === targetCol) return 'X'; // both at same col
    if (i === bestCol) return '^';
    if (i === targetCol) return 'T';
    return ' ';
  });

  return `${ticks}\n${scale}\n${bar.join('')}\n${markers.join('')}`;
}
```

Note: CONTEXT.md proposes Unicode `▓ ▒ ░ ↑ ▲` for the example bar. That works fine on the *dashboard* and in the *server log*. For Pushover, see Q4 — recommend dual-render with ASCII for notifications.

### Anti-Patterns to Avoid

- **Recomputing band on every reading:** Forward-propagation should NOT re-run DTW. Only rerun when a new query window has accumulated enough fresh samples to potentially shift the plausible-offset set (e.g. tied to the existing `tryMatch` cadence in `charge-monitor.ts`).
- **Storing the ASCII bar on `MatchResult`:** Mixes presentation with domain data. Render at the boundary (NotificationService, SSE emitter). The `socAsciiBar` field on `ChargeStateEvent` is correct because it's an export to clients; the in-memory MatchResult should stay numeric.
- **Forgetting `captureEventContext`:** `handleStopping` snapshots state before the relay-off await. That snapshot was the fix for the 2640873 bogus "Akku voll: Akku -> 0% erreicht." Pushover. The new band fields MUST be in `captureEventContext` or the same bug recurs for the bar.
- **Per-render zero-width-band division:** Computing `bandConfidence = 1 / (socMax - socMin)` divides by zero on collapsed bands. Use `1 - width/100` instead (see deriveBand example).
- **Using ECharts for the dashboard band:** Setup cost ~20 ms per option-change call; 1 ms per SSE event for a CSS variable update. CSS wins.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DTW algorithm | Custom recurrence | Existing `subsequenceDtw` extended with distance vector | Already battle-tested on the existing curve fixtures |
| String-to-array of N chars | Manual loop + concat | `Array.from({length: N}, (_,i)=>...)` + join | Idiomatic, matches existing code style in the repo |
| Snapshot tests | Inline string equality | Vitest's `toMatchSnapshot()` / `toMatchInlineSnapshot()` | Existing test convention (Vitest 4.1.1) |
| Settings persistence | Custom file/env mechanism | Existing `config` table + `useAutoSave` hook | One key/value row, autosave UI exists |
| Drizzle migration | Hand-written SQL | `drizzle-kit generate` → `tsx scripts/db/migrate.ts` | Existing migrations strategy in v1.2 phases 7-9 |
| Pushover monospace flag | Custom HTTP form encoding | Add optional `monospace?: 0\|1` to `PushoverMessage` type, JSON-stringify it | `pushover-client.ts` already uses JSON body, not URLSearchParams |

**Key insight:** This phase is almost entirely *additive*. Every system involved (SSE, MatchResult, ChargeStateEvent, NotificationService, config table, Drizzle schema) has an existing extension point. The only structural change is the `subsequenceDtw` return shape — and even that adds a field rather than altering existing ones.

## Runtime State Inventory

Phase 11 is a code-only feature addition, but it does change the *meaning* of existing in-memory and DB state. Inventory:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data** | `chargeSessions.estimatedSoc` column is currently a single int. The new band needs companion persistence so resume doesn't lose it. | Drizzle migration: add `soc_min INTEGER`, `soc_max INTEGER`, `band_confidence REAL` columns to `charge_sessions`. NULL allowed for legacy rows; resume code reads NULLs as "use estimatedSoc for all three". |
| **Stored data — fixtures** | `reference_curve_points` rows for `profile_id=4` (iPad Pro 12.9", 5782 points, 8271 s curve) live in the LXC SQLite. They are NOT in git. | Add a one-shot export script `scripts/fixtures/export-reference-curve.ts` that dumps `referenceCurvePoints` for a profile ID to `src/modules/charging/fixtures/ipad-reference-curve.json` — committed to git so property tests are reproducible. Synthetic flat-then-taper generator is also acceptable per CONTEXT; recommend BOTH (synthetic for fast unit tests, real iPad curve for the integration test that proves band-collapse-in-taper). |
| **Live service config** | None. No external service (n8n, Datadog, etc.) is involved in this phase. | None — verified by no external service touchpoints in `src/modules/charging/` or `src/modules/notifications/`. |
| **OS-registered state** | None. Phase 11 changes only Node process state. | None — verified. |
| **Secrets/env vars** | None new. Pushover credentials (`pushover.userKey`, `pushover.apiToken`) and electricity price already in `config` table; reuse unchanged. | None — verified by reading `notification-service.ts:158-163`. |
| **Build artifacts** | `tsbuildinfo` may need refresh after type changes in `types.ts`. | `pnpm build` regenerates; covered by standard build. |
| **Resume-after-restart** | `resumeActiveSessions()` in `charge-monitor.ts:1001` reconstructs `MatchResult` from `chargeSessions` columns. Without `soc_min`/`soc_max` columns, restart would lose the band. | Migration above. Plus: in `resumeActiveSessions`, read `session.socMin ?? session.estimatedSoc` etc. so legacy rows degrade to a zero-width band rather than crashing. |
| **Override path** | `PUT /api/charging/sessions/[id]` with `estimatedSoc` collapses to a single point. Must collapse band to zero-width at that point. | In `overrideSession` (charge-monitor.ts:187), set `socMin = socMax = socBest = opts.estimatedSoc` and update both DB columns. The next matcher run can re-widen. |
| **Calibration** | `soc_corrections` table records (predicted, corrected, chargedWh) on override. Predicted = `socBest` (= the old `estimatedSoc`), which preserves the existing bias-learning loop unchanged. | None — the calibration loop works the same because `socBest` is the alias. Verified by reading `calibration.ts:30-45`. |

## Common Pitfalls

### Pitfall 1: Forward-propagation breaks band-narrowing semantics
**What goes wrong:** A naive implementation re-derives socMin/socMax from the *current* DTW output on every reading. That makes the band oscillate based on tiny noise in the live query window instead of monotonically narrowing.
**Why it happens:** Easy to think of `(socMin, socMax)` as functions of "live state" rather than "history of plausible-offset sets".
**How to avoid:** `updateSocTracking` propagates the band forward via Wh math only. The band narrows ONLY in `tryMatch` when a new DTW run returns a tighter cutoff set than the previous one. Use `Math.min(prevMin... newMin, prevMax... newMax)` to enforce monotonic narrowing — never widen unless an override resets the session.
**Warning signs:** Property test "band width is non-increasing over a session" fails.

### Pitfall 2: `captureEventContext` doesn't snapshot band fields
**What goes wrong:** Same bug class as 2640873 — `handleStopping` awaits relay-off, cleanup runs first, the post-await `complete` event emits `socMin=undefined socMax=undefined`, Pushover shows a broken bar.
**Why it happens:** `captureEventContext` was added defensively; the next person adding fields might not know that.
**How to avoid:** Add `socMin/socMax/socBandConfidence/socAsciiBar` to the `captureEventContext` return type and to the `emitChargeEvent` destructure. Add a regression test that emits a `complete` event after a synthetic relay-off await and asserts the ASCII bar is present.
**Warning signs:** Pushover `complete` message shows `..........` (empty bar) or no bar at all.

### Pitfall 3: Pushover monospace doesn't render on lock screen
**What goes wrong:** User sees `▓▒░├┼┤↑▲` literally as garbled characters (or invisible whitespace) on Android lock-screen even though the message inside the Pushover app looks fine.
**Why it happens:** Pushover monospace is supported in "messages, not notifications" — i.e. only when the user opens the message [CITED: https://blog.pushover.net/posts/2019/3/animated-gifs-and-monospace-text]. The push payload itself uses the system notification font, which may not have full Unicode box-drawing glyphs on every device.
**How to avoid:** Use ASCII-only characters in the Pushover bar (`#`, `=`, `.`, `^`, `T`, `+`, `|`, `-`). Render a Unicode version separately for the dashboard. Add `monospace: 1` to the Pushover payload anyway — it improves the in-app reading experience and is harmless on the lock screen.
**Warning signs:** User screenshots show the bar as a row of "□" replacement glyphs.

### Pitfall 4: 15 % band-threshold is wrong for the iPad curve
**What goes wrong:** Initial threshold of 15 % is a guess; on the real iPad reference curve (~50 min flat at 40 W, then taper) it may produce a band so wide it's useless (0-80) or so narrow it never widens enough to admit the truth.
**Why it happens:** No empirical calibration before shipping.
**How to avoid:** Plan must include a calibration task: replay session 16's recorded readings against the iPad reference curve with thresholds in `[0.05, 0.10, 0.15, 0.20, 0.30]` and observe where the band actually collapses. Make `charging.bandThreshold` configurable so the LXC operator can tune it without a redeploy. **RESOLVED in Plan 11-01 Task 2:** an empirical calibration test runs the threshold sweep against the synthetic-iPad-shaped fixture and pins `DEFAULT_BAND_THRESHOLD_PCT` to the smallest threshold that collapses the band to ≤ 5 % in the taper region. The default is the test's output, not a guess. (See revision iteration 1, B1.)
**Warning signs:** Property test "iPad-style fixture collapses to <5 % band in taper phase" fails OR a fresh iPad session shows socMin=0 socMax=100 even an hour in.

### Pitfall 5: Aggressive stop-mode stops at wrong moment if band hasn't narrowed
**What goes wrong:** `socBest >= target AND socMax - socMin <= 5` short-circuits if `socBest >= target` was always true (e.g. initial wide band 20-80 with socBest=80). The session stops at session start.
**Why it happens:** Mis-ordered evaluation; the width constraint must be the *primary* gate.
**How to avoid:** Order matters: gate first on `socMax - socMin <= 5` (band has actually collapsed) THEN check `socBest >= target`. Test case: band {min:20, max:80, best:80, target:80} should NOT trigger stop.
**Warning signs:** Sessions in aggressive mode stop within 30 s of start.

### Pitfall 6: Stop-mode read on every reading is wasteful
**What goes wrong:** `handleCharging` does a `db.select().from(config).where(eq(config.key, 'charging.stopMode')).get()` on every power reading (every 5 s × hours = 720+ DB hits/hour per plug).
**Why it happens:** Easy to inline the lookup.
**How to avoid:** Cache stop-mode on the `ChargeStateMachine` instance, reload on the `idle → detecting` transition (start of session) so changes take effect on the next session start. Or — simpler — load once per `updateSocTracking` block (which already runs once per reading anyway) but use a process-level memoized accessor with a 30 s TTL.
**Warning signs:** SQLite WAL grows abnormally; flamegraph shows hot path in `config` lookups.

## Code Examples

### Subsequence DTW returning distances vector

```typescript
// MODIFIED src/modules/charging/dtw.ts
// Source: https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7S2_SubsequenceDTW.html
export interface SubsequenceDtwResult {
  offset: number;
  distance: number;
  distances: Float64Array;
  windowStep: number;
}

export function subsequenceDtw(
  query: number[],
  reference: number[],
  windowStep: number = 5
): SubsequenceDtwResult {
  const queryLen = query.length;
  const refLen = reference.length;
  const numOffsets = Math.max(0, Math.floor((refLen - queryLen) / windowStep) + 1);

  const distances = new Float64Array(numOffsets);
  let bestOffset = 0;
  let bestDistance = Infinity;

  let idx = 0;
  for (let offset = 0; offset <= refLen - queryLen; offset += windowStep) {
    const refWindow = reference.slice(offset, offset + queryLen);
    const dist = dtwDistance(query, refWindow);
    distances[idx++] = dist;
    if (dist < bestDistance) {
      bestDistance = dist;
      bestOffset = offset;
    }
  }

  return { offset: bestOffset, distance: bestDistance, distances, windowStep };
}
```

### Reading stop-mode setting

```typescript
// src/modules/charging/stop-mode.ts (new)
// Source: existing pattern in src/modules/notifications/notification-service.ts:42-46
import { db } from '@/db/client';
import { config } from '@/db/schema';
import { eq } from 'drizzle-orm';

export type StopMode = 'aggressive' | 'conservative';
export const DEFAULT_STOP_MODE: StopMode = 'aggressive';

let cachedMode: StopMode | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

export function readStopMode(): StopMode {
  const now = Date.now();
  if (cachedMode && now - cachedAt < CACHE_TTL_MS) return cachedMode;

  const row = db.select().from(config).where(eq(config.key, 'charging.stopMode')).get();
  const val = row?.value;
  cachedMode = (val === 'conservative' || val === 'aggressive') ? val : DEFAULT_STOP_MODE;
  cachedAt = now;
  return cachedMode;
}

export function shouldStop(opts: {
  mode: StopMode;
  socMin: number;
  socMax: number;
  socBest: number;
  targetSoc: number;
}): boolean {
  if (opts.mode === 'conservative') {
    return opts.socMin >= opts.targetSoc;
  }
  // Aggressive — both gates must hold; width check FIRST so initial wide bands
  // don't trip the rule when socBest happens to land at target.
  const width = opts.socMax - opts.socMin;
  return width <= 5 && opts.socBest >= opts.targetSoc;
}
```

### Pushover client with monospace flag

```typescript
// MODIFIED src/modules/notifications/pushover-client.ts
export type PushoverMessage = {
  userKey: string;
  apiToken: string;
  title: string;
  message: string;
  priority: number;
  /** Render message body in monospace font (Pushover v3.4+).
   *  Mutually exclusive with html=1.
   *  Source: https://pushover.net/api */
  monospace?: 0 | 1;
};

export async function sendPushover(msg: PushoverMessage): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      token: msg.apiToken,
      user: msg.userKey,
      title: msg.title,
      message: msg.message,
      priority: msg.priority,
    };
    if (msg.monospace) body.monospace = 1;

    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (error) {
    console.error('Pushover send failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
```

### CSS live band (Q10 — lightest-weight approach)

```tsx
// src/components/charging/soc-band-indicator.tsx
'use client';

import { useChargeStream } from '@/hooks/use-charge-stream';
import { useState } from 'react';
import type { ChargeStateEvent } from '@/modules/charging/types';

export function SocBandIndicator({ plugId, asciiFallback }: { plugId: string; asciiFallback?: string }) {
  const [band, setBand] = useState<{ min: number; max: number; best: number; target: number } | null>(null);

  useChargeStream(plugId, (e: ChargeStateEvent) => {
    if (e.socMin == null || e.socMax == null || e.estimatedSoc == null || e.targetSoc == null) return;
    setBand({ min: e.socMin, max: e.socMax, best: e.estimatedSoc, target: e.targetSoc });
  });

  if (!band) {
    return asciiFallback
      ? <pre className="font-mono text-xs text-neutral-400 whitespace-pre">{asciiFallback}</pre>
      : null;
  }

  // CSS variables drive a single transition. No React re-render thrash;
  // the browser composites these on the GPU.
  return (
    <div
      className="relative h-6 bg-neutral-900 rounded-full overflow-hidden"
      style={{
        // Tailwind 4 supports arbitrary CSS vars; alternative: inline style only.
        ['--min' as string]: `${band.min}%`,
        ['--max' as string]: `${band.max}%`,
        ['--best' as string]: `${band.best}%`,
        ['--target' as string]: `${band.target}%`,
      }}
    >
      {/* Band fill — animated via CSS transitions, no React state for the animation itself */}
      <div
        className="absolute top-0 bottom-0 bg-blue-500/30 transition-all duration-700 ease-out"
        style={{ left: 'var(--min)', width: 'calc(var(--max) - var(--min))' }}
      />
      {/* Best marker */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-blue-300 transition-all duration-700 ease-out"
        style={{ left: 'var(--best)' }}
      />
      {/* Target marker */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-emerald-400"
        style={{ left: 'var(--target)' }}
      />
    </div>
  );
}
```

This adds zero new dependencies and lets the browser interpolate the band-narrowing animation in compositor-only CSS — no React re-render per frame.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single global DTW minimum | Full cost-row scan with relative-threshold cutoff (subsequence DTW matching function Δ_DTW(m)) | MIR textbook practice, stable for 15+ yr | We can adopt directly; no library required |
| ECharts/Recharts for tiny live widgets | Pure CSS variables + transitions | Modern browsers (last 5 yr) compositor-friendly | 1-2 orders of magnitude less CPU than ECharts re-render |
| Pushover HTML formatting (`html=1`) | Pushover monospace (`monospace=1`) since 2019 | [CITED: blog.pushover.net 2019/3] | Better for ASCII art / tabular data; mutually exclusive with html |
| Inline DB lookups on every reading | Process-level memoized resolver with TTL | Idiomatic in this codebase (see `resolveInstanceLabel`) | Eliminates 720+ DB hits/hour per plug |

**Deprecated/outdated:**
- Per-profile band thresholds (CONTEXT non-goal): would multiply tuning effort. Single global threshold is the right v1.3 scope.
- Dynamic band thresholds based on session count (CONTEXT non-goal): premature optimization for v1.3.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SOCB-01 | Curve-Matcher liefert `{socMin, socMax, socBest, bandConfidence}` aus DTW-Offset-Scores | Pattern 1 (subsequenceDtw returns distances[]) + `deriveBand` example. MIR-textbook technique cited from audiolabs-erlangen. `estimatedStartSoc` alias = `socBest` preserved per CONTEXT decision 6. |
| SOCB-02 | `updateSocTracking` rechnet socMin/socMax vorwärts | Pattern 2 (forward-propagation). Band narrows only on new matcher runs, not Wh accumulation. Pitfall 1 flags the naive implementation. |
| SOCB-03 | Stop-Logik konfigurierbar (konservativ/aggressiv) via Settings-Toggle | `stop-mode.ts` example with `readStopMode()` + `shouldStop()` pure decision function. Pitfall 5 flags the width-check ordering. Settings UI follows `electricity-settings.tsx` autosave pattern. |
| SOCB-04 | Pure-function ASCII-Renderer mit ≥6 Snapshot-Tests | Pattern 3 with ASCII-only character set for Pushover safety. Edge cases listed for snapshot coverage: full-uncertainty (0-100), narrow (best±2), exact-target, band crossing target, collapsed (min=max=best), overshoot clamped. |
| SOCB-05 | NotificationService hängt ASCII-Bar an matched/complete/anomalie an, `monospace=1` | Pushover-client modification snippet. Q5 maps the exact call sites: `buildMatchedMessage` (line 171), `buildCompleteMessage` (line 230), `fireAnomalyNotification` (line 470 in charge-monitor.ts). |
| SOCB-06 | Dashboard zeigt Band live mit CSS-Animation, ASCII-Fallback ohne JS | CSS-variables pattern. `ChargeStateEvent` already designed for additive fields (existing `bestCandidate*` precedent). `use-charge-stream.ts` opaque forwarding confirmed. |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | 15 % band-threshold is a sensible starting value | Pitfall 4, deriveBand example | Band too wide or too narrow on the real iPad curve. Mitigation: planner must include an empirical calibration task using session 16 readings. **RESOLVED via Plan 11-01 Task 2 empirical-calibration sweep.** |
| A2 | Unicode box-drawing chars render unreliably in Pushover lock-screen payload, ASCII does not | Pitfall 3, Pattern 3, Q4 | If Unicode actually renders fine, we're shipping uglier ASCII than necessary. Mitigation: low-risk; in-app render still uses Unicode. **ACCEPTED — dual-render with ASCII for Pushover, Unicode for dashboard remains the locked design (Q3 deferred per A2).** |
| A3 | CSS-variable updates from React state changes are cheaper than ECharts re-render | Q10, Pattern 3 anti-patterns | If state changes still trigger React reconciliation costs we didn't account for, we'd want `useRef` + direct style manipulation. Mitigation: profile during plan-execute; the fallback is a one-line refactor. |
| A4 | `chargeSessions.estimatedSoc` is integer-typed in SQLite and tolerates NULL for new band columns | Runtime State Inventory | If existing rows have NOT NULL constraints we'd need a default-value migration. Verified via schema.ts:184 (`estimatedSoc: integer('estimated_soc')` — nullable). **Fixture handling resolved per A4: synthetic-iPad-shaped fixture is the committed default (Plan 11-01 Task 3); real-iPad export is deferred and optional (Q4 deferred).** |
| A5 | The Pushover monospace API parameter is supported by the current sendPushover JSON-body format | Code Examples | Pushover docs cited show monospace via form field, JSON body should accept it equivalently. Mitigation: if not, switch to URLSearchParams. |

## Open Questions (RESOLVED)

1. **What's the right empirical band-threshold value? — RESOLVED via Plan 11-01 Task 2.**
   - What we know: 15 % is the CONTEXT-suggested starting point; MIR literature suggests 10-20 % range for "within X % of best" thresholding.
   - What's unclear: Whether 15 % gives a usable band on this specific reference set (iPad, Bosch e-bike). Could easily be too tight on noisy live data.
   - **Resolution (B1, revision iteration 1):** Plan 11-01 Task 2 implements an empirical-calibration sweep test that runs `deriveBand` against the synthetic-iPad-shaped fixture for each threshold in `[0.05, 0.10, 0.15, 0.20, 0.30]` and pins `DEFAULT_BAND_THRESHOLD_PCT` to the smallest threshold that collapses the band to ≤ 5 % in the taper region. The test fails the plan if no threshold satisfies. The default is the test's output; `charging.bandThreshold` is also a `config` row so the LXC operator can override post-deploy without a code change.

2. **Should we persist the historic plausible-offset set or only the (socMin, socMax) summary? — DEFERRED.**
   - What we know: For resume-after-restart, having `(socMin, socMax)` is sufficient to keep the band-width invariant during forward propagation. We do NOT need the historic offset distribution after the band has been derived.
   - What's unclear: If we ever want to "widen back" after a misleading narrow read (the matcher saw a noise blip), we'd want the underlying distribution.
   - **Resolution:** v1.3 stores summary only. If widen-back becomes a requirement, add a `latest_dtw_distances` BLOB column or a separate table in v1.4+. CONTEXT explicitly defers anomaly-aware band logic.

3. **Does Pushover's `monospace=1` apply on iOS lock-screen actionable previews? — DEFERRED (accepted per A2).**
   - What we know: Pushover blog (2019) says monospace is for "messages, not notifications" due to mobile-platform limits. Pushover docs accept `monospace=1` form field [CITED: pushover.net/api].
   - What's unclear: Whether iOS shows monospace text on the lock-screen banner before the user taps in.
   - **Resolution (W5):** Don't assume yes; the Plan 11-03 design uses ASCII glyphs that look reasonable in either a proportional or a monospace font. The CONTEXT DoD includes a manual Pushover device-verification step. Question stays open in the empirical sense but is accepted under A2: ASCII is the defensive choice and is locked.

4. **Is the iPad reference curve volatile across teach-in sessions? — DEFERRED (accepted per A4).**
   - What we know: There's a single `reference_curves` row per `profile_id`; learn-mode overwrites it.
   - What's unclear: Whether the iPad profile gets re-learned often enough that a snapshot fixture becomes stale.
   - **Resolution (W5, W2):** Plan 11-01 Task 3 commits a **synthetic-iPad-shaped** fixture (not the real iPad curve) as the default. The export script supports `--profile-id 4` against the LXC DB so the real curve can be exported and committed when LXC access is available. Test descriptions use "synthetic-iPad-shaped" terminology consistently per W2; question accepted as deferred under A4.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| pnpm | Build, deps | ✓ | 10.30.3 | — |
| Node | Runtime | ✓ | (project standard 22 LTS) | — |
| Vitest | Unit/property/snapshot tests | ✓ | 4.1.1 | — |
| drizzle-kit | Migration generation | ✓ | 0.31.10 | — |
| better-sqlite3 | DB access | ✓ | 12.8.0 | — |
| TypeScript | Strict-mode types | ✓ | 5.9.3 | — |
| iPad reference curve (DB fixture) | Property test for band-collapse-in-taper | ✓ (on LXC, profile_id=4, ~5782 points) | — | Synthetic flat-then-taper generator (also recommended) |
| Pushover credentials | Manual verification of `monospace=1` rendering | ✓ (already in `config` table) | — | — |
| Physical iPad + iPhone with Pushover app | DoD acceptance: visual bar on push | Operator has access (per memory: v1.3 Sanorum Charge-Test setup 2026-05-10) | — | Pushover web client also renders monospace |

**Missing dependencies with no fallback:** None — phase is fully buildable on the LXC and against existing fixtures.
**Missing dependencies with fallback:** Real iPad curve fixture is per-LXC; the synthetic generator is the portable substitute for CI/dev environments.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.1 |
| Config file | `vitest.config.ts` (jsdom environment) |
| Quick run command | `pnpm exec vitest run src/modules/charging` |
| Full suite command | `pnpm exec vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SOCB-01 | `findBestCandidate` returns band on synthetic flat-then-taper curve, band collapses to ≤5 % once query enters taper | property | `pnpm exec vitest run src/modules/charging/curve-matcher.test.ts` | Wave 0 |
| SOCB-01 | `subsequenceDtw` returns full distances vector with consistent length | unit | `pnpm exec vitest run src/modules/charging/dtw.test.ts -t "distances vector"` | Wave 0 (extend existing) |
| SOCB-02 | `updateSocTracking` propagates socMin/socMax forward in lock-step with Wh; band width non-increasing over a session | unit (integration-flavor) | `pnpm exec vitest run src/modules/charging/charge-monitor.test.ts` | Wave 0 |
| SOCB-03 | `shouldStop({mode:'conservative',...})` returns true iff socMin >= target | unit | `pnpm exec vitest run src/modules/charging/stop-mode.test.ts -t "conservative"` | Wave 0 |
| SOCB-03 | `shouldStop({mode:'aggressive',...})` requires width <=5 AND socBest >= target; does NOT trip on initial wide band where socBest accidentally lands at target | unit | `pnpm exec vitest run src/modules/charging/stop-mode.test.ts -t "aggressive"` | Wave 0 |
| SOCB-04 | 6+ snapshot tests for `renderSocBandAscii`: full uncertainty, narrow band, exact-target, band-crosses-target, collapsed-to-point, overshoot clamp | snapshot | `pnpm exec vitest run src/modules/charging/ascii-bar.test.ts` | Wave 0 |
| SOCB-05 | NotificationService `complete` message body contains the rendered ASCII bar | unit | `pnpm exec vitest run src/modules/notifications/notification-service.test.ts -t "complete includes bar"` | Wave 0 |
| SOCB-05 | sendPushover called with `monospace: 1` for state in {matched, complete, anomaly} | unit (mock fetch) | same file | Wave 0 |
| SOCB-06 | ChargeStateEvent payload from emitter contains socMin/socMax/socBandConfidence/socAsciiBar | unit | `pnpm exec vitest run src/modules/charging/charge-monitor.test.ts -t "emitChargeEvent band fields"` | Wave 0 |
| SOCB-06 | Dashboard band indicator renders no-band fallback when ChargeStateEvent lacks band fields | unit (RTL) | `pnpm exec vitest run src/components/charging/soc-band-indicator.test.tsx` | Wave 0 |
| Regression | Override path `PUT /api/charging/sessions/[id]` with `estimatedSoc` collapses band to zero-width AND logs soc_corrections row | integration | `pnpm exec vitest run src/app/api/charging/sessions` | Wave 0 (may exist; extend) |
| Regression | Resume-after-restart with NULL soc_min/soc_max columns degrades gracefully to zero-width band at saved estimatedSoc | unit | `pnpm exec vitest run src/modules/charging/charge-monitor.test.ts -t "resume legacy"` | Wave 0 |
| Manual | Pushover `complete` message visually renders the bar on an iPhone and an Android lock screen | manual | (DoD checklist, run on LXC after deploy) | n/a |

### Sampling Rate
- **Per task commit:** `pnpm exec vitest run src/modules/charging src/modules/notifications` (~2-3 s, scoped)
- **Per wave merge:** `pnpm exec vitest run && pnpm exec tsc --noEmit` (full suite + type-check)
- **Phase gate:** Full suite green + manual Pushover verification on LXC before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/modules/charging/curve-matcher.test.ts` — covers SOCB-01 (does not exist yet; matcher has no test file)
- [ ] `src/modules/charging/charge-monitor.test.ts` — covers SOCB-02, SOCB-06, resume regression (does not exist yet)
- [ ] `src/modules/charging/stop-mode.test.ts` — covers SOCB-03 (new module, new tests)
- [ ] `src/modules/charging/ascii-bar.test.ts` — covers SOCB-04 (new module, new tests)
- [ ] `src/modules/notifications/notification-service.test.ts` — covers SOCB-05 (does not exist yet; the only existing notification artifact is `pushover-client.ts` with no test)
- [ ] `src/components/charging/soc-band-indicator.test.tsx` — covers SOCB-06 UI (new component, new test)
- [ ] `src/modules/charging/fixtures/ipad-reference-curve.json` — fixture for property test
- [ ] `scripts/fixtures/export-reference-curve.ts` — one-shot export script

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Single-user LAN-only app; existing host-header guard unchanged |
| V3 Session Management | no | No sessions in this phase |
| V4 Access Control | no | No new endpoints exposed externally; `/api/settings` (existing) is the only writeable surface |
| V5 Input Validation | yes | `charging.stopMode` value MUST be validated against `{'aggressive','conservative'}` literal set before writing to `config` (use Zod literal union or simple `===` check). `charging.bandThreshold` MUST be a number in `(0, 1)` if exposed. |
| V6 Cryptography | no | No crypto operations |

### Known Threat Patterns for this Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malformed `config` value crashes server on read | Denial of Service | Defensive parse with a default in `readStopMode()` (see code example). Same pattern already used for `electricity.priceEurPerKwh` validation. |
| Snapshot ASCII bar contains user-controlled content | Injection | N/A — bar is rendered from numeric SOC values only. No user-string interpolation. |
| Pushover credentials leak via log of message body | Information Disclosure | Existing notification-service.ts uses `console.error` only for transport errors, not body content. Maintain the discipline; do NOT log the full Pushover payload during dev. |
| DB column type mismatch on resume (e.g. socMin column dropped) | Tampering / Reliability | Migration is generated by `drizzle-kit generate`; runtime degrades gracefully because all band fields read as `?? estimatedSoc`. |

## Sources

### Primary (HIGH confidence)
- [Pushover API documentation](https://pushover.net/api) — verified `monospace=1` form field, mutually-exclusive with `html=1`, UTF-8 supported, 1024-char message limit
- [Pushover blog: Animated GIFs and monospace text](https://blog.pushover.net/posts/2019/3/animated-gifs-and-monospace-text) — verified monospace is "messages, not notifications" — informs the ASCII-safety recommendation for the lock-screen payload
- [Audiolabs Erlangen MIR — Subsequence DTW (C7S2)](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7S2_SubsequenceDTW.html) — verified the standard technique for extracting plausible offsets from the DTW matching function Δ_DTW(m) = D(N,m)/N
- npm registry — verified versions: echarts 6.0.0, echarts-for-react 3.0.6 [via `npm view`]
- Local file inspection — verified API surfaces, types, and patterns:
  - `/Users/hulki/codex/charging-master/src/modules/charging/curve-matcher.ts`
  - `/Users/hulki/codex/charging-master/src/modules/charging/dtw.ts`
  - `/Users/hulki/codex/charging-master/src/modules/charging/charge-monitor.ts` (especially `captureEventContext` line 905, `tryMatch` line 610, `updateSocTracking` line 757, `resumeActiveSessions` line 1001)
  - `/Users/hulki/codex/charging-master/src/modules/charging/charge-state-machine.ts` (handleCharging line 172, handleCountdown line 179)
  - `/Users/hulki/codex/charging-master/src/modules/charging/types.ts`
  - `/Users/hulki/codex/charging-master/src/modules/charging/soc-estimator.ts`
  - `/Users/hulki/codex/charging-master/src/modules/charging/calibration.ts`
  - `/Users/hulki/codex/charging-master/src/modules/notifications/notification-service.ts`
  - `/Users/hulki/codex/charging-master/src/modules/notifications/pushover-client.ts`
  - `/Users/hulki/codex/charging-master/src/app/api/sse/power/route.ts` (the actual SSE charge route; CONTEXT pointed to `/api/sse/charge/route.ts` which does NOT exist — charge events ride the `power` SSE under `event: charge`)
  - `/Users/hulki/codex/charging-master/src/hooks/use-charge-stream.ts`
  - `/Users/hulki/codex/charging-master/src/components/charging/charge-banner.tsx`
  - `/Users/hulki/codex/charging-master/src/components/settings/electricity-settings.tsx`
  - `/Users/hulki/codex/charging-master/src/app/api/settings/route.ts`
  - `/Users/hulki/codex/charging-master/src/db/schema.ts`

### Secondary (MEDIUM confidence)
- [Arxiv 2506.15452 — Warping and Matching Subsequences Between Time Series](https://arxiv.org/html/2506.15452v1) — recent (2025) on subsequence-DTW alignment endpoints; informs Pitfall 1 about offset endpoint sensitivity
- [Wikipedia: Dynamic time warping](https://en.wikipedia.org/wiki/Dynamic_time_warping) — background on cost matrix structure

### Tertiary (LOW confidence)
- General community discussion of monospace rendering on Android/iOS push payloads — no authoritative source; mitigated by Pitfall 3 + Assumption A2 + the recommendation to test on a real device during DoD

## Metadata

**Confidence breakdown:**
- DTW band derivation: HIGH — well-established MIR technique, verified against audiolabs source, math is straightforward
- Architecture (additive event/SSE): HIGH — verified against actual file contents, follows existing precedent (bestCandidate* fields)
- Stop-mode & settings: HIGH — direct reuse of existing `config` table + autosave UI pattern
- ASCII renderer: HIGH — pure function, fully snapshot-testable
- Pushover monospace rendering on lock screen: MEDIUM — Pushover blog explicitly disclaims notification-level monospace; pure ASCII recommendation is defensive and risk-free
- Band-threshold value (15 % initial): MEDIUM at research time; **HIGH after revision iteration 1** — Plan 11-01 Task 2 pins the default empirically via the calibration sweep (B1 resolution)
- CSS-driven band animation: HIGH — standard browser behavior, no exotic API
- Property test fixtures: MEDIUM — depends on running the export script against the LXC DB; synthetic generator is a safe fallback
- Resume-after-restart band reconstruction: HIGH — pattern mirrors the existing curveOffsetSeconds/estimatedSoc reconstruction in `resumeActiveSessions`

**Research date:** 2026-05-14
**Valid until:** 2026-06-13 (30 days — stable domain, all primary sources are reference-grade)

## RESEARCH COMPLETE

**Phase:** 11 - SOC Confidence Band + ASCII Visualization
**Confidence:** HIGH

### Key Findings
- Subsequence DTW already computes every offset's distance — the existing implementation discards them. Returning the full `distances: Float64Array` adds zero algorithmic complexity and enables band derivation via a textbook scan-and-threshold (audiolabs-erlangen).
- The architecture is overwhelmingly additive: `MatchResult`, `ChargeStateEvent`, `PushoverMessage`, `chargeSessions` schema, the SSE wire format, and the `config` settings table all accept new optional fields with zero impact on existing consumers (`use-charge-stream.ts` and `charge-banner.tsx` do plain `JSON.parse` and destructure only what they need).
- Pushover renders Unicode fine in the in-app view but explicitly disclaims monospace on the lock-screen notification payload. Recommend ASCII-only glyphs (`#`, `=`, `.`, `^`, `T`) for Pushover, richer Unicode/CSS for the dashboard — dual-render.
- CONTEXT's `socEdge = startEdge + (chargedWh / refTotalWh) * 100` math is exactly the existing `estimateSoc` formula applied to two extra anchors. Band narrows ONLY on new matcher runs; Wh accumulation just translates the band forward.
- The actual SSE route is `/api/sse/power/route.ts` (events are `event: charge` over the power stream), not `/api/sse/charge/route.ts`. The investigation question pointed at a non-existent file; flagged in Sources.
- The 15 % band-threshold was a hypothesis at research time. **Revision iteration 1 (B1) moves the empirical calibration into Plan 11-01 Task 2** — the default is pinned by a sweep test, not by guess.
- Resume-after-restart needs three new `chargeSessions` columns (`soc_min`, `soc_max`, `band_confidence`) — nullable — plus a fallback in `resumeActiveSessions` so legacy rows degrade to a zero-width band rather than crashing.
- `captureEventContext` in `charge-monitor.ts:905` MUST capture the band fields too, or the post-await `complete` push will emit an empty bar (same bug class as commit 2640873).

### File Created
`/Users/hulki/codex/charging-master/.planning/phases/11-soc-confidence-band-ascii-visualization/11-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | No new libraries; all reuse of verified existing patterns |
| DTW band math | HIGH | Textbook MIR technique, cited primary source, existing DP table already computes what's needed |
| Architecture / additive evolution | HIGH | Verified every consumer (SSE, hook, banner, NotificationService) tolerates additive fields |
| Pushover ASCII safety | MEDIUM | Defensive ASCII choice; needs one manual device verification in DoD |
| Empirical band threshold (15 %) | HIGH after revision iteration 1 | Plan 11-01 Task 2 pins the default empirically via the calibration sweep (B1 resolution) |
| Resume / persistence | HIGH | Pattern mirrors existing `resumeActiveSessions` logic |

### Open Questions (RESOLVED in revision iteration 1)
1. Right empirical band-threshold value — **RESOLVED** via Plan 11-01 Task 2 empirical sweep (B1).
2. Whether to store the full distance vector — **DEFERRED** to v1.4+ if widen-back becomes a feature.
3. Whether monospace renders on iOS/Android lock-screen — **DEFERRED, accepted per A2**; defensive ASCII recommendation neutralizes the risk.
4. Reference-curve fixture volatility — **DEFERRED, accepted per A4**; synthetic-iPad-shaped fixture is the committed default, real-curve export remains optional.

### Ready for Planning
Research complete. Planner can now create PLAN.md files. Suggested plan decomposition (planner's call):
- **Plan 1:** Domain core — `dtw.ts` distances refactor, `curve-matcher.ts` deriveBand + empirical calibration, `types.ts` extensions, fixture export, property tests
- **Plan 2:** Runtime integration — `charge-monitor.ts` forward propagation + captureEventContext extension + <30s aggressive-stop integration test, `charge-state-machine.ts` stop-mode wiring, `stop-mode.ts` new module, Drizzle migration, resume regression test
- **Plan 3:** Notifications + Pushover — `pushover-client.ts` monospace field, `notification-service.ts` ASCII bar injection at 3 sites, `ascii-bar.ts` + snapshot tests, populated socAsciiBar on captureEventContext
- **Plan 4:** UI — `soc-band-indicator.tsx` CSS-variable component, `charging-settings.tsx` stop-mode toggle + required component test, dashboard wiring
