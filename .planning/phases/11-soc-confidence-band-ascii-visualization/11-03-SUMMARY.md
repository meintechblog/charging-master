---
phase: 11-soc-confidence-band-ascii-visualization
plan: 03
subsystem: notifications + charging
tags: [ascii-renderer, pushover, monospace, snapshot-tests, vitest, soc-band, notification-service, charge-monitor]

requires:
  - phase: 11-soc-confidence-band-ascii-visualization
    plan: 01
    provides: MatchResult band fields (optional → tightened in 11-02), deriveBand
  - phase: 11-soc-confidence-band-ascii-visualization
    plan: 02
    provides: band-aware ChargeStateMachine, captureEventContext band snapshot, MatchResult band fields REQUIRED, ChargeStateEvent.socMin/socMax/socBandConfidence/socAsciiBar (declared)

provides:
  - renderSocBandAscii pure function with dual-mode rendering (pushover / unicode)
  - LOCKED 3-line output shape (scale row + bar row + markers row) — B5 closed
  - Glyph tables: pushover {#, =, ., ^, T, X, |, +, -} ; unicode {▓, ▒, ░, ↑, ▲, X, ├, ┼, ─}
  - DEFAULT_BAND_WIDTH = 40, DEFAULT_BAND_MODE = 'unicode'
  - PushoverMessage.monospace?: 0 | 1 (opt-in, omitted from request body when falsy)
  - NotificationService.buildMatchedMessage + buildCompleteMessage embed the ASCII bar with monospace=1
  - charge-monitor.fireAnomalyNotification embeds the bar with monospace=1 in URLSearchParams body
  - charge-monitor.captureEventContext now renders socAsciiBar (unicode mode) at snapshot time — W1 closed
  - SOCB-04 + SOCB-05 satisfied

affects:
  - 11-04 UI: dashboard band component can read socAsciiBar from the SSE event as a fallback string, OR re-render via renderSocBandAscii({ ..., mode: 'unicode' }) for richer CSS-based interpolation

tech-stack:
  added: []
  patterns:
    - "Pure-function ASCII renderer with locked output shape — snapshot-tested via toMatchInlineSnapshot for visibility in code review"
    - "Dual-mode glyph dispatch — ASCII-only for lock-screen payload (Pitfall 3), Unicode for dashboard + server log"
    - "Opt-in flag forwarding pattern: monospace? on type, only included in HTTP body when truthy, legacy callers byte-identical"
    - "Builder return type carries the locked monospace decision (W4) — handleEvent threads it through with msg.monospace, no parallel OR-fork"
    - "Snapshot-before-await applied to derived presentation (socAsciiBar) — same pattern as 2640873 for estimatedSoc"

key-files:
  created:
    - src/modules/charging/soc-band-ascii.ts
    - src/modules/charging/soc-band-ascii.test.ts
    - src/modules/notifications/pushover-client.test.ts
  modified:
    - src/modules/notifications/pushover-client.ts
    - src/modules/notifications/notification-service.ts
    - src/modules/notifications/notification-service.test.ts
    - src/modules/charging/charge-monitor.ts
    - src/modules/charging/charge-monitor.test.ts

key-decisions:
  - "Output shape LOCKED at exactly 3 lines per renderer call — scale row + bar row + markers row. No separate labeled tick-header alternative. (B5 closed.)"
  - "Per-line glyph invariants — scale, bar, markers rows each tested against their own narrow regex. No over-broad union regex on the full 3-line output."
  - "Tick-step formula: tickStep = max(1, round((width-1)/10)). For width=40 → step 4 → mids at 4, 8, 12, ..., 36. tickStart at 0 and width-1. tickFill in between."
  - "Pushover glyphs are ASCII-only (#/=/./^/T/X/|/+/-). Pitfall 3: Pushover monospace is 'messages, not notifications' on iOS/Android — lock-screen rendering can mangle Unicode box-drawing chars. Unicode reserved for dashboard + server log via mode: 'unicode'."
  - "monospace forwarding: PushoverMessage type has optional `monospace?: 0 | 1`; sendPushover guards `if (msg.monospace) body.monospace = 1` — falsy / undefined / 0 omits the key entirely so legacy callers POST byte-identical bodies to pre-Phase-11."
  - "Single locked code path through the builder return type (W4): buildMatchedMessage and buildCompleteMessage return `BuiltMessage` with an optional `monospace?: 0 | 1`. handleEvent reads `msg.monospace` and forwards it directly. No OR-fork at the call site."
  - "Frequency restraint (CONTEXT §3): bar is attached ONLY in matched + complete builders (NotificationService) and in fireAnomalyNotification (charge-monitor.ts). detecting / error / aborted / learn_complete remain bar-less and monospace-less."
  - "captureEventContext renders the bar in unicode mode at snapshot time — the SSE/dashboard payload gets it from the snapshot. Pushover bar is rendered separately by NotificationService in pushover mode for lock-screen safety."
  - "Anomaly path uses URLSearchParams (existing transport in charge-monitor.ts) rather than switching to sendPushover — minimal-change path preserves the application/x-www-form-urlencoded body that's been in production since the anomaly feature shipped."
  - "Determinism guard: no Math.random, no Date.now, no fetch inside renderSocBandAscii. Test repeats the same input three times and asserts byte-identical output."

patterns-established:
  - "Pattern: locked 3-line ASCII rendering with dual-mode glyph dispatch — reuse for any future monospace push payload (e.g. multi-plug status)"
  - "Pattern: opt-in flag forwarded onto HTTP body only when truthy — keeps legacy request bodies byte-identical to pre-feature state"
  - "Pattern: builder-return-type carries the locked flag — handleEvent threads it through without conditional / OR branches at the call site (W4)"
  - "Pattern: derived presentation (ASCII bar) is captured at snapshot time so post-await events carry it, mirroring 2640873's estimatedSoc fix"

requirements-completed: [SOCB-04, SOCB-05]

verification:
  - "pnpm exec vitest run → 163/163 passed across 13 files (was 121 baseline +42 new)"
  - "pnpm exec tsc --noEmit → exit 0"
  - "Pushover snapshot ASCII-safety scan (Pitfall 3): all 6 pushover-mode inline snapshots contain NO non-ASCII bytes"
  - "Determinism: vitest re-run produces byte-identical snapshot output (snapshot-test stability)"

duration: ~9min
completed: 2026-05-14
---

# Phase 11 Plan 03: SOC Confidence Band ASCII Renderer + Pushover Wiring Summary

**Pure-function renderer produces a locked 3-line ASCII bar in two glyph modes (Pushover / Unicode); the bar is threaded into every Pushover code-path with a monospace=1 flag; captureEventContext now snapshots the rendered bar so the post-await 'complete' event carries it for the SSE/dashboard payload.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-05-14T21:40:07Z
- **Completed:** 2026-05-14T21:49:00Z (approx — wall clock at SUMMARY write)
- **Tasks:** 2/2
- **Files modified:** 5 (+ 3 created)

## Accomplishments

### Task 1 — Pure renderSocBandAscii (SOCB-04)

- **Locked 3-line output shape (B5 closed).** Every call produces exactly `scaleRow\nbarRow\nmarkersRow` — no separate labeled tick-header, no width-dependent branching, no OR alternatives. Scale row's tick glyphs carry the percent positions; markers row carries best (`^`/`↑`) and target (`T`/`▲`) with `X` on overlap.
- **Dual-mode glyph dispatch.** `'pushover'` uses ASCII-only `{#, =, ., ^, T, X, |, +, -}` for lock-screen rendering safety (Pitfall 3 — Pushover monospace is "messages, not notifications" on iOS/Android). `'unicode'` uses `{▓, ▒, ░, ↑, ▲, X, ├, ┼, ─}` for dashboard + server log.
- **7 inline snapshots** lock the output for representative inputs: full uncertainty (0..100), narrow band (best±5), exact-target overlap, band crossing target, collapsed point (min=max=best), target at left edge, Unicode parity. Stored inline via `toMatchInlineSnapshot()` so glyph drift is visible in code review without a separate `__snapshots__` directory.
- **Per-line glyph invariants (B5 fix).** Bar row regex scoped to bar glyphs only (`/^[#=.]+$/` for pushover, `/^[▓▒░]+$/` for unicode); scale and markers rows tested with their own narrow regexes. No over-broad union regex.
- **18 additional tests** cover width parameter (20, 40, 80, 1), clamping (-10 / 200), defaults (`DEFAULT_BAND_WIDTH=40`, `DEFAULT_BAND_MODE='unicode'`), per-mode glyph-set invariants, and determinism (three repeated calls byte-identical).
- **Purity verified.** No `Math.random`, no `Date.now`, no `fetch`, no `import` of `@/db/...` or `fs`. The only string matching `Math\.random|Date\.now|...` is the comment that says the function is pure.

### Task 2 — Pushover monospace forwarding + bar in all three notification call-sites (SOCB-05, W1 + W4 closed)

- **PushoverMessage.monospace?: 0 | 1** is optional. `sendPushover` guards `if (msg.monospace) body.monospace = 1;` — falsy / undefined / `0` omits the key entirely. Legacy callers POST byte-identical bodies to pre-Phase-11.
- **NotificationService — single locked code path (W4 closed).** Both `buildMatchedMessage` and `buildCompleteMessage` return `BuiltMessage = { title, message, priority, monospace?: 0 | 1 }`. When band fields are present on the event, the bar is appended to the message AND `monospace: 1` is set on the returned object. `handleEvent` reads `msg.monospace` and forwards it into the sendPushover call directly — NO parallel OR-fork at the call site.
- **Frequency restraint (CONTEXT §3).** The bar is attached ONLY in matched + complete builders inside NotificationService and in `charge-monitor.fireAnomalyNotification`. `detecting`, `error`, `aborted`, `learn_complete` remain bar-less and monospace-less. No per-Wh spam.
- **fireAnomalyNotification** appends the Pushover-mode bar and sets `monospace=1` in the URLSearchParams body when the plug's session band Maps are populated; falls back to a byte-identical legacy body when they're not. Existing `application/x-www-form-urlencoded` transport preserved — no switch to sendPushover required.
- **captureEventContext socAsciiBar populated (W1 closed).** The bar is rendered at snapshot time in unicode mode so the post-await `complete` event (handleStopping → switchRelayOff await → cleanupSession clears the Maps) still emits a non-empty 3-line string. Same 2640873 bug class as the original estimatedSoc snapshot fix, now closed for the band visualization too.

## Task Commits

| Task | Hash | Type | Description |
|------|------|------|-------------|
| 1    | `c179964` | feat | pure renderSocBandAscii with locked 3-line output + dual-mode glyphs (SOCB-04) |
| 2    | `7007a63` | feat | wire SOC band into Pushover paths + populate captureEventContext socAsciiBar (SOCB-05, W1+W4 closed) |

## Files Created/Modified

### Created

- `src/modules/charging/soc-band-ascii.ts` — `renderSocBandAscii` + types + defaults; pure, no I/O, 124 lines.
- `src/modules/charging/soc-band-ascii.test.ts` — 25 tests: 7 inline snapshots + width/clamping/degenerate tests + per-line glyph invariants + determinism guard.
- `src/modules/notifications/pushover-client.test.ts` — 7 tests: monospace forwarded only when truthy, legacy callers omit the key, error/non-OK/success paths, URL + headers + method verification.

### Modified

- `src/modules/notifications/pushover-client.ts` — `PushoverMessage.monospace?: 0 | 1`; `sendPushover` builds the body as `Record<string, unknown>` and conditionally adds `monospace: 1` only when truthy.
- `src/modules/notifications/notification-service.ts` — Imports `renderSocBandAscii`; introduces `BuiltMessage` return-type with optional `monospace`; `buildMatchedMessage` and `buildCompleteMessage` append the Pushover-mode bar when band fields are present and set `monospace: 1`; `handleEvent` forwards `msg.monospace` into `sendPushover`.
- `src/modules/notifications/notification-service.test.ts` — vi.mock for db/schema/drizzle-orm/pushover-client; 6 new tests cover matched + complete bar + monospace + back-compat + Pushover ASCII safety + frequency restraint.
- `src/modules/charging/charge-monitor.ts` — Imports `renderSocBandAscii`; `fireAnomalyNotification` appends the Pushover-mode bar and adds `monospace=1` to URLSearchParams body when band Maps populated; `captureEventContext` renders socAsciiBar in unicode mode at snapshot time (W1 closed).
- `src/modules/charging/charge-monitor.test.ts` — Updated the existing `captureEventContext returns ... socAsciiBar` test to assert a non-empty 3-line string (was expecting `undefined`); 4 new tests for legacy fallback, anomaly path (with + without band), and emitChargeEvent forwarding.

## Decisions Made

### Output shape locked at 3 lines (B5)

The plan's must-haves require an output shape locked to scale + bar + markers with no width-dependent branching. The renderer always emits exactly:

```
line 0  scale row    (tick glyphs: |/+/-  or  ├/┼/─)
line 1  bar row      (#/=/.  or  ▓/▒/░)
line 2  markers row  (^/T/X/' '  or  ↑/▲/X/' ')
```

There is NO separate tick-header row, no width-dependent format selection. Snapshot tests pin the output for width=40 (default) and width-parameter tests assert exactly 3 lines for widths 20, 40, 80, and the degenerate width=1.

### Per-line glyph invariants

Per B5, invariants are scoped per-line so a glyph regression is visible without an over-broad regex that would also match neighbours:

- Pushover scale row: `/^[|+\-]+$/`
- Pushover bar row: `/^[#=.]+$/`
- Pushover markers row: `/^[\^TX ]+$/`
- Unicode scale row: `/^[├┼─]+$/`
- Unicode bar row: `/^[▓▒░]+$/`
- Unicode markers row: `/^[↑▲X ]+$/`

A test iterates over 6 sample inputs (3 pushover + 3 unicode) and asserts each row's regex per-mode.

### Pushover monospace forwarding pattern

The opt-in pattern is:

```ts
const body: Record<string, unknown> = { token, user, title, message, priority };
if (msg.monospace) body.monospace = 1;
```

This guarantees that:

1. Legacy callers (no `monospace` field) send byte-identical bodies to pre-Phase-11.
2. Callers passing `monospace: 0` are treated the same as legacy (the field is omitted).
3. Only truthy `monospace: 1` adds the key to the wire format.

The pushover-client test file exercises all three cases.

### W4 — single locked code path through the builder return type

Instead of `handleEvent` performing a conditional `sendPushover({ ..., monospace: shouldHaveBar ? 1 : undefined })` OR an OR-fork between matched / complete / others, the decision is encapsulated in the builder:

```ts
type BuiltMessage = { title; message; priority; monospace?: 0 | 1 };

// In buildMatchedMessage / buildCompleteMessage:
const built: BuiltMessage = { ... };
if (event.socMin != null && event.socMax != null && ...) {
  built.message += '\n' + renderSocBandAscii({ ..., mode: 'pushover' });
  built.monospace = 1;
}
return built;

// In handleEvent:
await sendPushover({ ..., monospace: msg.monospace });
```

One code path. No parallel branches. The builder owns the "did we attach a bar?" decision and exposes it via the return-type.

### W1 — captureEventContext renders socAsciiBar at snapshot time

`captureEventContext` already snapshots `socMin`/`socMax`/`socBandConfidence` to survive the relay-off `await` in `handleStopping` (where `cleanupSession()` clears the Maps before the post-await emit). The same problem applies to the rendered bar: if the event consumer (dashboard / SSE) does the rendering, they see the Maps after cleanup. Fix: render at snapshot time and store the string on the event context.

The rendered string in `captureEventContext` is **unicode mode** — the SSE/dashboard payload gets the richer glyphs. The Pushover-mode bar is rendered separately inside `NotificationService.buildCompleteMessage` (from the event's `socMin`/`socMax`/`estimatedSoc`/`targetSoc` fields) for lock-screen safety. The two never share a rendered string; they share the inputs.

### Anomaly path: URLSearchParams not sendPushover

`fireAnomalyNotification` already uses raw `fetch()` with `application/x-www-form-urlencoded`. The minimal-change path was to keep that transport and add `monospace=1` to the params dict conditionally:

```ts
const body: Record<string, string> = { token, user, title, message, priority: '1' };
if (monospace) body.monospace = monospace;  // '1'
new URLSearchParams(body).toString();
```

The alternative (rewriting the anomaly path to call sendPushover) would have churned production code that's been stable since the anomaly feature shipped. Not worth the diff for one extra notification site.

### Determinism

`renderSocBandAscii` is a pure function — no `Math.random`, no `Date.now`, no `fetch`, no `import` of stateful modules. A determinism test calls the function three times with the same input and asserts byte-identical output. Snapshot-test stability is verified by re-running `pnpm exec vitest run` and confirming no diff.

## Deviations from Plan

None of substance.

- No Rule 1 bugs found.
- No Rule 2 missing critical functionality (the must-haves were followed verbatim).
- No Rule 3 blockers (`node_modules` was absent on first run — clean `pnpm install --frozen-lockfile` resolved it, same as Plan 11-01).
- No Rule 4 architectural questions.

One minor TS-strictness fix in `charge-monitor.test.ts`: the `vi.fn(async () => ({ ok: true }))` shape produced `mock.calls[0]` typed as `[]`, so I typed the mock's parameters explicitly:

```ts
const fetchSpy = vi.fn(async (
  _url: string,
  _init: { body: string; method: string; headers: Record<string, string> },
) => ({ ok: true }));
```

This is test plumbing, not a deviation from the plan's behavior contract.

## Verification Evidence

- **Renderer + invariant tests:** `pnpm exec vitest run src/modules/charging/soc-band-ascii.test.ts` → 25/25 pass in 8 ms.
- **Pushover client tests:** `pnpm exec vitest run src/modules/notifications/pushover-client.test.ts` → 7/7 pass.
- **NotificationService tests:** `pnpm exec vitest run src/modules/notifications/notification-service.test.ts` → 13/13 pass (7 existing + 6 new).
- **ChargeMonitor tests:** `pnpm exec vitest run src/modules/charging/charge-monitor.test.ts` → 15/15 pass (11 existing, 1 updated, 4 new).
- **Full suite:** `pnpm exec vitest run` → **163/163 pass across 13 files** (was 121 baseline after 11-02; +42 new tests).
- **Type-check:** `pnpm exec tsc --noEmit` → exit 0 (after generating `src/lib/version.ts` via `pnpm run gen:version`, which is the standard pre-build step).
- **Pushover ASCII-safety scan (Pitfall 3):** all 6 pushover-mode inline snapshots contain NO non-ASCII bytes. Confirmed by a tsx one-liner that extracts the snapshot strings, scans every char code, and asserts `< 128`.
- **Determinism:** `renderSocBandAscii` called three times with `{socMin:45, socMax:55, socBest:50, targetSoc:80, mode:'pushover'}` returns byte-identical output. Repeated test runs produce identical snapshot output.

### Acceptance grep checks (all green)

| Check | Result |
|---|---|
| `grep -n "monospace?: 0 \| 1" src/modules/notifications/pushover-client.ts` | 1 match (line 16) |
| `grep -nE "if \(msg\.monospace\)" src/modules/notifications/pushover-client.ts` | 1 match (line 32) |
| `grep -cn "renderSocBandAscii" src/modules/notifications/notification-service.ts` | 3 matches (import + matched + complete) |
| `grep -cn "renderSocBandAscii" src/modules/charging/charge-monitor.ts` | 3 matches (import + fireAnomalyNotification + captureEventContext) |
| `grep -nE "monospace:\s*1\|monospace:\s*'1'" src/modules/charging/charge-monitor.ts` | 1 match (anomaly path) |
| `grep -n "monospace: msg.monospace" src/modules/notifications/notification-service.ts` | 1 match (handleEvent — W4 single forwarding path) |
| `grep -rn "renderSocBandAscii" src/ \| wc -l` | 37 occurrences across the renderer + 4 consumer files |
| `grep -cE "toMatchInlineSnapshot" src/modules/charging/soc-band-ascii.test.ts` | 7 matches (6 pushover-mode + 1 unicode parity) |
| `grep -nE "import.*db\|^fs\|fetch\|Date\.now\|Math\.random" src/modules/charging/soc-band-ascii.ts` | 0 matches (the function is pure) |

## Reference Data for Downstream Plans

Plan 11-04 (UI) can consume the band as either:

1. **Pre-rendered string from the SSE event:** `event.socAsciiBar` is now a 3-line unicode string. Render with `<pre className="font-mono">{event.socAsciiBar}</pre>` for a JS-disabled fallback.
2. **Re-render client-side via shared module:**
   ```ts
   import { renderSocBandAscii } from '@/modules/charging/soc-band-ascii';
   const bar = renderSocBandAscii({
     socMin: event.socMin!,
     socMax: event.socMax!,
     socBest: event.estimatedSoc!,
     targetSoc: event.targetSoc!,
     mode: 'unicode',
   });
   ```

### renderSocBandAscii signature

```ts
export type SocBandRenderMode = 'pushover' | 'unicode';

export interface SocBandRenderInput {
  socMin: number;
  socMax: number;
  socBest: number;
  targetSoc: number;
  width?: number;             // default DEFAULT_BAND_WIDTH = 40
  mode?: SocBandRenderMode;   // default DEFAULT_BAND_MODE = 'unicode'
}

export function renderSocBandAscii(input: SocBandRenderInput): string;
```

Output: exactly 3 lines separated by single `\n`, no trailing newline. Every line has `width` characters.

### Glyph tables (locked)

| Glyph role  | Pushover | Unicode |
|-------------|---------:|--------:|
| core (best±5) within band | `#` | `▓` |
| band (socMin..socMax)     | `=` | `▒` |
| outside band              | `.` | `░` |
| best marker               | `^` | `↑` |
| target marker             | `T` | `▲` |
| overlap (best == target)  | `X` | `X` |
| scale tick start (edges)  | `\|` | `├` |
| scale tick mid (10% marks)| `+` | `┼` |
| scale tick fill           | `-` | `─` |
| markers fill              | ` ` | ` ` |

### Pushover call sites carrying monospace=1

| Call site | Transport | Builder/Method |
|---|---|---|
| `NotificationService.buildMatchedMessage` | `sendPushover` JSON body | `BuiltMessage.monospace = 1` set when bar appended; `handleEvent` forwards `msg.monospace` |
| `NotificationService.buildCompleteMessage` | `sendPushover` JSON body | Same pattern |
| `charge-monitor.fireAnomalyNotification` | Raw `fetch()` `application/x-www-form-urlencoded` | URLSearchParams body adds `monospace=1` when band Maps populated |

### captureEventContext socAsciiBar (W1)

```ts
const socAsciiBar = socMin !== undefined && socMax !== undefined && machine !== undefined
  ? renderSocBandAscii({
      socMin,
      socMax,
      socBest: machine.socBest,
      targetSoc: machine.targetSoc,
      mode: 'unicode',
    })
  : undefined;
```

Snapshot is taken in `captureEventContext` BEFORE the relay-off await in `handleStopping`, so the post-await `complete` emit carries the rendered string even after `cleanupSession()` has cleared the per-plug Maps. Same protection pattern as 2640873's estimatedSoc fix.

### ChargeStateEvent shape (after Plan 11-03)

```ts
interface ChargeStateEvent {
  // ... existing fields ...
  socMin?: number;
  socMax?: number;
  socBandConfidence?: number;
  socAsciiBar?: string;          // 3-line unicode string when band fields present; undefined otherwise
}
```

## Issues Encountered

- **`node_modules` absent on worktree start.** `pnpm install --frozen-lockfile` at the beginning (same as Plan 11-01). Not a deviation.
- **`@/lib/version` module missing at first tsc run.** `pnpm run gen:version` writes `src/lib/version.ts` from the current SHA + build time; standard pre-build step. Not a code change.
- **TS strict-mode tuple-length error in `charge-monitor.test.ts`.** `vi.fn(async () => ({ ok: true }))` has no parameter signature, so `mock.calls[0]` was inferred as `[]` and `mock.calls[0][1]` errored at TS2493. Fixed by typing the mock's parameters explicitly. Test plumbing only.

## Threat Flags

None — no new network endpoints, no new auth paths, no schema changes. The Pushover wire-format change is additive (one optional `monospace` field).

## Self-Check: PASSED

- `src/modules/charging/soc-band-ascii.ts` ✓ exists; contains `export function renderSocBandAscii`, both modes in the glyph dispatch, `DEFAULT_BAND_WIDTH`, `DEFAULT_BAND_MODE`
- `src/modules/charging/soc-band-ascii.test.ts` ✓ exists; 25 tests, 7 inline snapshots, per-line glyph invariants, determinism test
- `src/modules/notifications/pushover-client.ts` ✓ contains `monospace?: 0 | 1` (line 16) AND `if (msg.monospace) body.monospace = 1` (line 32)
- `src/modules/notifications/pushover-client.test.ts` ✓ exists; 7 tests
- `src/modules/notifications/notification-service.ts` ✓ imports `renderSocBandAscii`; `BuiltMessage` type with optional monospace; matched + complete builders embed bar with monospace=1; handleEvent forwards `msg.monospace`
- `src/modules/notifications/notification-service.test.ts` ✓ 13 tests (7 existing + 6 new for SOCB-05)
- `src/modules/charging/charge-monitor.ts` ✓ imports `renderSocBandAscii`; fireAnomalyNotification embeds bar + monospace=1; captureEventContext renders socAsciiBar in unicode mode
- `src/modules/charging/charge-monitor.test.ts` ✓ 15 tests (11 existing + 1 updated + 4 new for Plan 11-03)
- Commits in `git log`: `c179964` (Task 1) ✓, `7007a63` (Task 2) ✓ both present
- `pnpm exec vitest run` → 163/163 pass ✓
- `pnpm exec tsc --noEmit` → exit 0 ✓
- Pushover snapshots ASCII-only verified ✓

---
*Phase: 11-soc-confidence-band-ascii-visualization*
*Completed: 2026-05-14*
