/**
 * Charge State Machine -- manages the lifecycle of a single charging session.
 *
 * States: idle -> detecting -> matched -> charging -> countdown -> stopping -> complete
 * Also: learning -> learn_complete (for device profile recording)
 * Also: aborted, error (terminal states that return to idle)
 */

import type { ChargeState, MatchResult } from './types';

// Thresholds (in Watts)
export const CHARGE_THRESHOLD = 5;
export const IDLE_THRESHOLD = 2;

// Timing constants
export const DETECTION_WINDOW_S = 120;
export const SUSTAINED_READINGS = 6;       // 30s at 5s interval
export const LEARN_IDLE_READINGS = 12;     // 60s at 5s interval
const MATCHED_DISPLAY_MS = 5000;           // 5 seconds to show banner

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

  onTransition: ((from: ChargeState, to: ChargeState, data?: unknown) => void) | null = null;

  // Internal counters
  private sustainedCount = 0;
  private idleCount = 0;
  private matchedAt: number | null = null;
  private matchResult: MatchResult | null = null;

  // Learn-mode plateau detection state
  private learnStartTimestamp: number | null = null;
  private learnSessionMaxPower = 0;
  private learnReadings: Array<{ ts: number; p: number }> = [];

  /**
   * Process one power reading. May trigger state transition.
   * Returns the current state after processing.
   */
  feedReading(apower: number, timestamp: number): ChargeState {
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

  // --- State handlers ---

  private handleIdle(apower: number): ChargeState {
    if (apower > CHARGE_THRESHOLD) {
      this.sustainedCount++;
      if (this.sustainedCount >= SUSTAINED_READINGS) {
        this.transition('detecting');
        this.sustainedCount = 0;
      }
    } else {
      this.sustainedCount = 0;
    }
    return this.state;
  }

  private handleDetecting(_apower: number, _timestamp: number): ChargeState {
    // Detection logic (DTW matching) is handled externally by ChargeMonitor.
    // The state machine just waits for setMatch() or timeout.
    return this.state;
  }

  private handleMatched(_apower: number, timestamp: number): ChargeState {
    // Auto-transition to charging after display period
    if (this.matchedAt !== null && timestamp - this.matchedAt >= MATCHED_DISPLAY_MS) {
      this.transition('charging');
    }
    return this.state;
  }

  private handleCharging(_apower: number, _timestamp: number): ChargeState {
    if (this.targetSoc > 0 && this.estimatedSoc >= this.targetSoc - 5) {
      this.transition('countdown');
    }
    return this.state;
  }

  private handleCountdown(_apower: number, _timestamp: number): ChargeState {
    if (this.estimatedSoc >= this.targetSoc) {
      this.transition('stopping');
    }
    return this.state;
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
      if (this.idleCount >= LEARN_IDLE_READINGS) {
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

  private transition(to: ChargeState): void {
    const from = this.state;
    this.state = to;
    this.onTransition?.(from, to, undefined);
  }

  private reset(): void {
    this.sustainedCount = 0;
    this.idleCount = 0;
    this.matchedAt = null;
    this.matchResult = null;
    this.sessionId = null;
    this.estimatedSoc = 0;
    this.learnStartTimestamp = null;
    this.learnSessionMaxPower = 0;
    this.learnReadings = [];
  }
}
