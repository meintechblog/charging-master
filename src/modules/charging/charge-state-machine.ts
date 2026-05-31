/**
 * Charge State Machine -- manages the lifecycle of a single charging session.
 *
 * States: idle -> detecting -> matched -> charging -> countdown -> stopping -> complete
 * Also: learning -> learn_complete (for device profile recording)
 * Also: aborted, error (terminal states that return to idle)
 */

import type { ChargeState, MatchResult } from './types';
import {
  DEFAULT_STOP_MODE,
  DEFAULT_STALE_POWER_THRESHOLD_W,
  readStopMode,
  readStalePowerThresholdW,
  readStalePowerWindowSec,
  shouldStop,
  type StopMode,
} from './stop-mode';

// Polling interval is fixed at 5 s codebase-wide (HttpPollingService default).
// Window-readings = windowSec / POLL_INTERVAL_SEC. Default 300 / 5 = 60.
const POLL_INTERVAL_SEC = 5;

// Thresholds (in Watts)
export const CHARGE_THRESHOLD = 5;
export const IDLE_THRESHOLD = 2;

// Timing constants
export const DETECTION_WINDOW_S = 120;
export const SUSTAINED_READINGS = 6;       // 30s at 5s interval
export const LEARN_IDLE_READINGS = 12;     // 60s at 5s interval
const MATCHED_DISPLAY_MS = 5000;           // 5 seconds to show banner

// SOCB-warm-up. Block shouldStop / FPD-03 energy-fallback dispatch for the
// first ~5 min of charging so the initial DTW match (which may anchor on a
// neighbouring profile's flat-power region — Session 20 hit Winbot W3 with
// socBest=83 on a real iPad 2026-05-15) gets at least one FPD-02 adaptive
// matcher refresh before any stop predicate can fire. 60 readings × 5s
// polling interval = 300s exactly equals the FPD-02 cadence.
export const MIN_CHARGING_READINGS_FOR_STOP = 60;

// Learn-mode plateau detection — catches chargers with persistent standby
// load (dock electronics, fan-cooled chargers, idle robot draw). Triggers
// learn_complete when sliding window is flat AND power is small relative
// to session peak, even if absolute power stays above IDLE_THRESHOLD.
export const PLATEAU_WINDOW_MS = 5 * 60 * 1000;        // 5 min sliding window
export const PLATEAU_MIN_SAMPLES = 30;                 // need at least ~2.5 min of data at 5s interval
export const PLATEAU_MIN_SPAN_MS = 4 * 60 * 1000 + 30_000; // window must span at least 4.5 min
export const PLATEAU_MAX_RANGE_W = 1;                  // max - min within window
export const PLATEAU_AVG_RATIO = 0.10;                 // avg must be < 10% of session peak
export const PLATEAU_MIN_PEAK_W = 5;                   // session peak must exceed this before plateau fires
export const LEARN_HARD_STOP_MS = 6 * 60 * 60 * 1000;  // 6h absolute cap

export class ChargeStateMachine {
  state: ChargeState = 'idle';
  sessionId: number | null = null;
  targetSoc: number = 80;
  estimatedSoc: number = 0;
  // Phase 11 SOC confidence band. Defaults express "full uncertainty" until
  // setMatch runs. socBest mirrors estimatedSoc but is tracked separately so
  // the shouldStop call reads the matcher's best estimate rather than the
  // forward-propagated value (they diverge only if a future plan ever splits
  // them; for 11-02 they advance in lock-step via ChargeMonitor.updateSocTracking).
  socMin: number = 0;
  socMax: number = 100;
  socBest: number = 0;
  socBandConfidence: number = 0;
  stopMode: StopMode = DEFAULT_STOP_MODE;

  onTransition: ((from: ChargeState, to: ChargeState, data?: unknown) => void) | null = null;

  // Internal counters
  private sustainedCount = 0;
  private idleCount = 0;
  private matchedAt: number | null = null;
  private matchResult: MatchResult | null = null;

  // FPD-01 stale-power watchdog. Counter is reading-based (NOT wall-clock) —
  // increments on `apower < stalePowerThresholdW` readings during
  // charging+countdown, resets to 0 on the first >= threshold reading. When
  // the count crosses stalePowerWindowReadings, fires transition('aborted',
  // { reason: 'stale_power' }). PUBLIC READONLY: ChargeMonitor.captureEventContext
  // reads this directly to derive `watchdogKind` / `stalePowerSeconds` for SSE.
  // Do NOT mutate from outside — single source of truth lives here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stalePowerCount = 0;
  private stalePowerThresholdW = DEFAULT_STALE_POWER_THRESHOLD_W;
  private stalePowerWindowReadings = 60; // = 300s / 5s = default 60 readings

  // Warm-up counter — number of readings consumed in handleCharging since the
  // most recent transition into 'charging'. shouldStop is gated until this
  // exceeds MIN_CHARGING_READINGS_FOR_STOP. PUBLIC READONLY: ChargeMonitor
  // reads this for the matching FPD-03 dispatch gate (avoid duplicating the
  // counter across two source-of-truth sites).
  chargingReadingCount = 0;

  // Learn-mode plateau detection state
  private learnStartTimestamp: number | null = null;
  private learnSessionMaxPower = 0;
  private learnReadings: Array<{ ts: number; p: number }> = [];

  /**
   * Process one power reading. May trigger state transition.
   * Returns the current state after processing.
   */
  feedReading(apower: number, timestamp: number): ChargeState {
    // Terminal/transient states get stuck because ChargeMonitor.handleStopping
    // (and the learn_complete / aborted / error paths) end a session by writing
    // to the DB and clearing per-plug maps but never reset machine.state. The
    // result: the next 33 W reading on the same plug falls into the default
    // branch below and the machine never re-arms. Recycle ourselves on entry
    // so a continued (or fresh) load can drive a new detection cycle. We also
    // catch 'stopping' here as belt-and-suspenders — a relay-off race could
    // theoretically leave the machine there without ever reaching a terminal.
    if (
      this.state === 'complete' ||
      this.state === 'learn_complete' ||
      this.state === 'aborted' ||
      this.state === 'error' ||
      this.state === 'stopping'
    ) {
      this.reset();
      this.state = 'idle';
    }

    switch (this.state) {
      case 'idle':
        return this.handleIdle(apower);

      case 'detecting':
        return this.handleDetecting(apower, timestamp);

      case 'matched':
        return this.handleMatched(apower, timestamp);

      case 'charging':
        return this.handleCharging(apower, timestamp);

      case 'countdown':
        return this.handleCountdown(apower, timestamp);

      case 'learning':
        return this.handleLearning(apower, timestamp);

      default:
        return this.state;
    }
  }

  /**
   * Force transition to learning state.
   */
  startLearning(sessionId: number): void {
    const from = this.state;
    this.sessionId = sessionId;
    this.state = 'learning';
    this.idleCount = 0;
    this.learnStartTimestamp = null;
    this.learnSessionMaxPower = 0;
    this.learnReadings = [];
    this.onTransition?.(from, 'learning');
  }

  /**
   * Set DTW match result -- transitions from detecting to matched.
   * timestamp defaults to 0, so first feedReading with timestamp >= MATCHED_DISPLAY_MS transitions.
   */
  setMatch(match: MatchResult, sessionId: number, timestamp: number = 0): void {
    if (this.state !== 'detecting') return;

    const from = this.state;
    this.matchResult = match;
    this.sessionId = sessionId;
    this.matchedAt = timestamp;
    this.targetSoc = 80; // Default, can be overridden
    this.estimatedSoc = match.estimatedStartSoc;
    // Plan 11-01 left band fields OPTIONAL on MatchResult; fall back to
    // estimatedStartSoc when a producer hasn't been wired yet. Plan 11-02
    // Task 3a tightens the type to required after every producer is wired.
    this.socMin = match.socMin ?? match.estimatedStartSoc;
    this.socMax = match.socMax ?? match.estimatedStartSoc;
    this.socBest = match.socBest ?? match.estimatedStartSoc;
    this.socBandConfidence = match.bandConfidence ?? 1;
    // Read the stop-mode policy once per session start. Cached at module
    // scope with a 30s TTL — changes from /settings take effect on the next
    // detecting→matched transition (acceptable for a single-user app).
    this.stopMode = readStopMode();
    // FPD-01: snapshot the stale-power watchdog config at session start.
    // Both helpers are 30s-cached at module scope; changes from /settings
    // take effect on the next session (same lock-in policy as stopMode).
    this.stalePowerThresholdW = readStalePowerThresholdW();
    this.stalePowerWindowReadings = Math.max(
      1,
      Math.round(readStalePowerWindowSec() / POLL_INTERVAL_SEC),
    );
    this.stalePowerCount = 0;
    this.state = 'matched';
    this.onTransition?.(from, 'matched', match);
  }

  /**
   * Force abort -- return to idle from any state.
   */
  abort(): void {
    const from = this.state;
    this.reset();
    this.state = 'idle';
    if (from !== 'idle') {
      this.onTransition?.(from, 'idle');
    }
  }

  /**
   * FPD-03 force-stop. Synchronous transition to 'stopping' with an
   * onTransition data payload carrying the reason. Unlike abort(), this does
   * NOT reset state — handleTransition('stopping') runs through the regular
   * handleStopping path (relay-off + DB write + cleanupSession).
   *
   * Caller (ChargeMonitor.handlePowerReading) MUST early-return after invoking
   * forceStop — the recycle gate (feedReading entry) would otherwise reset
   * 'stopping' to 'idle' before the side-effects fire (PLAN-CHECK H1).
   */
  forceStop(reason: string): void {
    this.transition('stopping', { reason });
  }

  /**
   * FPD-04 max-session-duration watchdog. Synchronous transition to 'aborted'
   * with reason='timeout'. Unlike forceStop, destination is 'aborted' (NOT
   * 'stopping') — the session exceeded its absolute time budget and is being
   * killed defensively, not gracefully stopped.
   *
   * Caller (ChargeMonitor.checkSessionTimeout) MUST early-return after invoking
   * forceTimeout so the recycle gate (feedReading entry) does not recycle
   * 'aborted' to 'idle' before handleTransition('aborted') runs.
   */
  forceTimeout(): void {
    this.transition('aborted', { reason: 'timeout' });
  }

  // --- State handlers ---

  private handleIdle(apower: number): ChargeState {
    if (apower > CHARGE_THRESHOLD) {
      this.sustainedCount++;
      if (this.sustainedCount >= SUSTAINED_READINGS) {
        // Fresh detection cycle — clear the idle-collapse counter so a stale
        // value from a prior cycle can't prematurely recycle this one to idle
        // (see handleDetecting power-loss guard).
        this.idleCount = 0;
        this.transition('detecting');
        this.sustainedCount = 0;
      }
    } else {
      this.sustainedCount = 0;
    }
    return this.state;
  }

  private handleDetecting(apower: number, _timestamp: number): ChargeState {
    // DTW matching is driven externally by ChargeMonitor, which calls setMatch()
    // once a candidate commits. But if power collapses to ~idle before any match
    // commits — the device was unplugged, or finished charging while still
    // detecting — nothing here would ever leave 'detecting', so the session row
    // lingers forever as an orphaned 'detecting' zombie (no user feedback, and a
    // re-emit source that can drive the Pushover metronome). Recycle to 'idle'
    // after a sustained idle stretch; ChargeMonitor.handleTransition('idle')
    // then persists the row as aborted/detection_failed and cleans up.
    if (apower < IDLE_THRESHOLD) {
      this.idleCount++;
      if (this.idleCount >= SUSTAINED_READINGS) {
        this.transition('idle');
        this.idleCount = 0;
      }
    } else {
      this.idleCount = 0;
    }
    return this.state;
  }

  private handleMatched(_apower: number, timestamp: number): ChargeState {
    // Auto-transition to charging after display period
    if (this.matchedAt !== null && timestamp - this.matchedAt >= MATCHED_DISPLAY_MS) {
      this.transition('charging');
    }
    return this.state;
  }

  private handleCharging(apower: number, _timestamp: number): ChargeState {
    // FPD-01 watchdog runs BEFORE shouldStop so a stale plug aborts even
    // when the band is wide and shouldStop would never trip. If the watchdog
    // already fired this call, state is no longer 'charging' — bail out.
    if (this.checkStalePower(apower)) return this.state;

    this.chargingReadingCount++;

    if (this.targetSoc <= 0) return this.state;
    // Warm-up gate. The initial DTW match runs on a ~30s window of
    // mostly-flat CC power, which is structurally ambiguous between many
    // device profiles. Wait for at least one FPD-02 adaptive refresh before
    // honouring any stop predicate.
    if (this.chargingReadingCount < MIN_CHARGING_READINGS_FOR_STOP) return this.state;
    if (
      shouldStop({
        mode: this.stopMode,
        socMin: this.socMin,
        socMax: this.socMax,
        socBest: this.socBest,
        targetSoc: this.targetSoc,
      })
    ) {
      this.transition('countdown');
    }
    return this.state;
  }

  private handleCountdown(apower: number, _timestamp: number): ChargeState {
    if (this.checkStalePower(apower)) return this.state;

    if (
      shouldStop({
        mode: this.stopMode,
        socMin: this.socMin,
        socMax: this.socMax,
        socBest: this.socBest,
        targetSoc: this.targetSoc,
      })
    ) {
      this.transition('stopping');
    }
    return this.state;
  }

  /**
   * FPD-01 stale-power watchdog. Increments stalePowerCount on every reading
   * below stalePowerThresholdW (reading-based, NOT wall-clock — polling gaps
   * naturally pause the counter). Resets to 0 on the first reading >=
   * threshold. When count crosses stalePowerWindowReadings, fires
   * transition('aborted', { reason: 'stale_power' }) and zeroes the counter.
   *
   * Returns true if the watchdog just fired (caller short-circuits shouldStop).
   */
  private checkStalePower(apower: number): boolean {
    if (apower < this.stalePowerThresholdW) {
      this.stalePowerCount++;
      if (this.stalePowerCount >= this.stalePowerWindowReadings) {
        this.transition('aborted', { reason: 'stale_power' });
        this.stalePowerCount = 0;
        return true;
      }
    } else {
      this.stalePowerCount = 0;
    }
    return false;
  }

  private handleLearning(apower: number, timestamp: number): ChargeState {
    if (this.learnStartTimestamp === null) {
      this.learnStartTimestamp = timestamp;
    }
    if (apower > this.learnSessionMaxPower) {
      this.learnSessionMaxPower = apower;
    }

    this.learnReadings.push({ ts: timestamp, p: apower });
    const cutoff = timestamp - PLATEAU_WINDOW_MS;
    while (this.learnReadings.length > 0 && this.learnReadings[0].ts < cutoff) {
      this.learnReadings.shift();
    }

    if (timestamp - this.learnStartTimestamp >= LEARN_HARD_STOP_MS) {
      this.transition('learn_complete');
      return this.state;
    }

    if (apower < IDLE_THRESHOLD) {
      this.idleCount++;
      // Require that the session observed real charging power before honouring
      // idle. Without this guard a slow-start charger (DJI Mini 2 charger took
      // ~90s to draw current — Session 28 on 3.x, 2026-05-23) trips
      // learn_complete after the 60s idle window before any reading is
      // recorded, producing a 0-Wh garbage session. Mirrors the
      // PLATEAU_MIN_PEAK_W guard a few lines below.
      if (
        this.idleCount >= LEARN_IDLE_READINGS &&
        this.learnSessionMaxPower >= PLATEAU_MIN_PEAK_W
      ) {
        this.transition('learn_complete');
        return this.state;
      }
    } else {
      this.idleCount = 0;
    }

    if (this.learnSessionMaxPower < PLATEAU_MIN_PEAK_W) {
      return this.state;
    }
    if (this.learnReadings.length < PLATEAU_MIN_SAMPLES) {
      return this.state;
    }
    const windowSpanMs = timestamp - this.learnReadings[0].ts;
    if (windowSpanMs < PLATEAU_MIN_SPAN_MS) {
      return this.state;
    }

    let minP = Infinity;
    let maxP = -Infinity;
    let sumP = 0;
    for (const r of this.learnReadings) {
      if (r.p < minP) minP = r.p;
      if (r.p > maxP) maxP = r.p;
      sumP += r.p;
    }
    const avgP = sumP / this.learnReadings.length;
    const range = maxP - minP;
    const avgRatio = avgP / this.learnSessionMaxPower;

    if (range < PLATEAU_MAX_RANGE_W && avgRatio < PLATEAU_AVG_RATIO) {
      this.transition('learn_complete');
    }

    return this.state;
  }

  private transition(to: ChargeState, data?: unknown): void {
    const from = this.state;
    this.state = to;
    // Arm the warm-up counter only when we ENTER charging. Re-entry from
    // countdown→charging (band momentarily fell back below target) keeps the
    // gate closed once already cleared — that's the point of tying the reset
    // to from!=='charging' rather than every charging transition.
    if (to === 'charging' && from !== 'charging') {
      this.chargingReadingCount = 0;
    }
    this.onTransition?.(from, to, data);
  }

  private reset(): void {
    this.sustainedCount = 0;
    this.idleCount = 0;
    this.matchedAt = null;
    this.matchResult = null;
    this.sessionId = null;
    this.estimatedSoc = 0;
    this.socMin = 0;
    this.socMax = 100;
    this.socBest = 0;
    this.socBandConfidence = 0;
    this.stopMode = DEFAULT_STOP_MODE;
    this.stalePowerCount = 0;
    this.stalePowerThresholdW = DEFAULT_STALE_POWER_THRESHOLD_W;
    this.stalePowerWindowReadings = 60;
    this.chargingReadingCount = 0;
    this.learnStartTimestamp = null;
    this.learnSessionMaxPower = 0;
    this.learnReadings = [];
  }
}
