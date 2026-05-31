import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db client + drizzle BEFORE importing the state machine, because
// setMatch() now calls readStopMode() which queries the config table.
vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get: vi.fn(() => undefined) })),
      })),
    })),
  },
}));
vi.mock('@/db/schema', () => ({
  config: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

import {
  ChargeStateMachine,
  CHARGE_THRESHOLD,
  IDLE_THRESHOLD,
  SUSTAINED_READINGS,
  LEARN_IDLE_READINGS,
  LEARN_HARD_STOP_MS,
  PLATEAU_WINDOW_MS,
  PLATEAU_MIN_PEAK_W,
  MIN_CHARGING_READINGS_FOR_STOP,
} from './charge-state-machine';

/**
 * Bypass the warm-up gate so a test that just transitioned into charging
 * can drive a stop-predicate without first having to feed
 * MIN_CHARGING_READINGS_FOR_STOP (60) sustained readings. Mirrors the
 * production invariant that handleCharging consumes ≥60 readings before
 * shouldStop is honoured — the band-mode and FPD-03 unit tests are
 * deliberately exempt from that invariant.
 */
function skipWarmUp(machine: ChargeStateMachine): void {
  machine.chargingReadingCount = MIN_CHARGING_READINGS_FOR_STOP;
}
import type { MatchResult } from './types';
import { __resetStopModeCacheForTests } from './stop-mode';

beforeEach(() => {
  __resetStopModeCacheForTests();
});

function createMachine() {
  return new ChargeStateMachine();
}

// Helper to build a MatchResult — Plan 11-02 tightened the band fields to
// required, so every test that constructs one needs them. Defaults match
// the "no band info yet" semantics (collapsed to estimatedStartSoc).
function makeMatch(overrides: Partial<MatchResult> & { estimatedStartSoc: number }): MatchResult {
  return {
    profileId: 1,
    profileName: 'E-Bike',
    confidence: 0.85,
    curveOffsetSeconds: 0,
    socMin: overrides.estimatedStartSoc,
    socMax: overrides.estimatedStartSoc,
    socBest: overrides.estimatedStartSoc,
    bandConfidence: 1,
    ...overrides,
  };
}

function feedReadings(machine: ChargeStateMachine, power: number, count: number, startTime = 0, interval = 5000) {
  let state = machine.state;
  for (let i = 0; i < count; i++) {
    state = machine.feedReading(power, startTime + i * interval);
  }
  return state;
}

describe('ChargeStateMachine', () => {
  it('starts in IDLE state', () => {
    const machine = createMachine();
    expect(machine.state).toBe('idle');
  });

  it('transitions IDLE -> DETECTING when power exceeds threshold for sustained period', () => {
    const machine = createMachine();
    // Feed readings above CHARGE_THRESHOLD for SUSTAINED_READINGS count
    const state = feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    expect(state).toBe('detecting');
  });

  it('stays IDLE if power is below threshold', () => {
    const machine = createMachine();
    const state = feedReadings(machine, CHARGE_THRESHOLD - 1, SUSTAINED_READINGS + 5);
    expect(state).toBe('idle');
  });

  it('resets sustained count if power dips below threshold', () => {
    const machine = createMachine();
    // Almost enough sustained readings
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS - 1);
    // One reading below threshold
    machine.feedReading(CHARGE_THRESHOLD - 1, 100000);
    // Start counting again
    const state = feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS - 1, 200000);
    expect(state).not.toBe('detecting');
  });

  it('transitions DETECTING -> MATCHED when DTW match found via setMatch', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    expect(machine.state).toBe('detecting');

    const match: MatchResult = makeMatch({ estimatedStartSoc: 0 });
    machine.setMatch(match, 42);
    expect(machine.state).toBe('matched');
    expect(machine.sessionId).toBe(42);
  });

  it('transitions MATCHED -> CHARGING after display period', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);

    machine.setMatch(makeMatch({ estimatedStartSoc: 0 }), 42);
    expect(machine.state).toBe('matched');

    // Feed a reading after the display period (5 seconds)
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000);
    expect(machine.state).toBe('charging');
  });

  it('transitions CHARGING -> COUNTDOWN when band collapses with socBest >= target (aggressive)', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch(makeMatch({ estimatedStartSoc: 0 }), 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging
    skipWarmUp(machine);

    // Collapse the band (width <= 5) with socBest at target → aggressive stop.
    machine.targetSoc = 80;
    machine.socMin = 78;
    machine.socMax = 82;
    machine.socBest = 80;
    machine.feedReading(CHARGE_THRESHOLD + 10, 20000);
    expect(machine.state).toBe('countdown');
  });

  it('transitions COUNTDOWN -> STOPPING when band stays narrow with socBest >= target', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch(makeMatch({ estimatedStartSoc: 0 }), 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging
    skipWarmUp(machine);

    machine.targetSoc = 80;
    machine.socMin = 78;
    machine.socMax = 82;
    machine.socBest = 80;
    machine.feedReading(CHARGE_THRESHOLD + 10, 20000); // -> countdown

    machine.feedReading(CHARGE_THRESHOLD + 10, 30000);
    expect(machine.state).toBe('stopping');
  });

  it('transitions any state -> IDLE on abort', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    expect(machine.state).toBe('detecting');

    machine.abort();
    expect(machine.state).toBe('idle');
  });

  it('recycles a stuck terminal/transient state on the next reading', () => {
    // Reproduces the production bug where a successful auto-stop left the
    // machine in `stopping` (or `complete` / `aborted` / `error`) and every
    // subsequent reading fell through the default branch, so the same plug
    // never re-armed detection on a continued or fresh load.
    const stuckStates: Array<'stopping' | 'complete' | 'aborted' | 'error' | 'learn_complete'> = [
      'stopping',
      'complete',
      'aborted',
      'error',
      'learn_complete',
    ];
    for (const stuck of stuckStates) {
      const machine = createMachine();
      machine.state = stuck;
      // First reading after the stuck state recycles to idle and counts.
      machine.feedReading(CHARGE_THRESHOLD + 10, 0);
      expect(machine.state).toBe('idle');
      // SUSTAINED_READINGS - 1 more readings reach detecting.
      const finalState = feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS - 1, 5000);
      expect(finalState).toBe('detecting');
    }
  });

  it('transitions IDLE -> LEARNING on learn mode start', () => {
    const machine = createMachine();
    machine.startLearning(99);
    expect(machine.state).toBe('learning');
    expect(machine.sessionId).toBe(99);
  });

  it('transitions LEARNING -> LEARN_COMPLETE when power drops to idle', () => {
    const machine = createMachine();
    machine.startLearning(99);

    // Feed some active readings
    feedReadings(machine, 50, 10);
    expect(machine.state).toBe('learning');

    // Feed idle readings for LEARN_IDLE_READINGS
    const state = feedReadings(machine, IDLE_THRESHOLD - 0.5, LEARN_IDLE_READINGS, 100000);
    expect(state).toBe('learn_complete');
  });

  it('calls onTransition callback on state changes', () => {
    const machine = createMachine();
    const callback = vi.fn();
    machine.onTransition = callback;

    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    expect(callback).toHaveBeenCalledWith('idle', 'detecting', undefined);
  });

  // --- Plateau detection (catches chargers with persistent standby >IDLE_THRESHOLD) ---

  it('LEARNING -> LEARN_COMPLETE via plateau detection (Winbot-style 7W standby)', () => {
    const machine = createMachine();
    machine.startLearning(99);

    // Climb to peak 100W over 10 readings (~50s), then hold 100W for 60 readings (~5min CC)
    let t = 0;
    for (let i = 0; i < 10; i++) {
      machine.feedReading(10 + i * 9, t); t += 5000;
    }
    for (let i = 0; i < 60; i++) {
      machine.feedReading(100, t); t += 5000;
    }
    expect(machine.state).toBe('learning');

    // Sudden CV drop to ~7W plateau, hold ~5min — plateau-detection should
    // fire once the window has filled. Stop feeding the moment it does, since
    // post-terminal readings recycle the machine back to idle (production
    // would have already toggled the relay off here).
    let plateauTriggered = false;
    for (let i = 0; i < 80; i++) {
      machine.feedReading(7 + (i % 2) * 0.3, t); t += 5000;
      if (machine.state === 'learn_complete') {
        plateauTriggered = true;
        break;
      }
    }
    expect(plateauTriggered).toBe(true);
  });

  it('plateau does NOT trigger during steady CC charging at 60W', () => {
    const machine = createMachine();
    machine.startLearning(99);

    // 10 minutes of steady 60W (range = 0, but avg/max = 100% — no plateau)
    let t = 0;
    for (let i = 0; i < 120; i++) {
      machine.feedReading(60, t); t += 5000;
    }
    expect(machine.state).toBe('learning');
  });

  it('plateau does NOT trigger when session peak is below PLATEAU_MIN_PEAK_W', () => {
    const machine = createMachine();
    machine.startLearning(99);

    // Tiny background load 3W never exceeds PLATEAU_MIN_PEAK_W (5W) — guards
    // against firing on idle plug.
    let t = 0;
    for (let i = 0; i < 80; i++) {
      machine.feedReading(3, t); t += 5000;
    }
    expect(machine.state).toBe('learning');
  });

  it('idle path does NOT trigger learn_complete when peak never crossed PLATEAU_MIN_PEAK_W', () => {
    // Regression: slow-start charger that takes longer than LEARN_IDLE_READINGS
    // (60s) to draw current. Pre-fix the idle counter fired learn_complete
    // before any reading was recorded, producing a 0-Wh garbage curve (DJI
    // Mini 2 Session 28, 2026-05-23).
    const machine = createMachine();
    machine.startLearning(99);

    const state = feedReadings(machine, 0, LEARN_IDLE_READINGS * 3);
    expect(state).toBe('learning');
  });

  it('idle path still triggers after peak has been observed', () => {
    // Companion test to the regression above: once real charging power has
    // been seen, the idle fast-path is still honoured for clean charger
    // shutoff (functional inverse of the slow-start guard).
    const machine = createMachine();
    machine.startLearning(99);

    // Brief CC at PLATEAU_MIN_PEAK_W + headroom, then drop to idle.
    let t = 0;
    for (let i = 0; i < 5; i++) {
      machine.feedReading(PLATEAU_MIN_PEAK_W + 10, t);
      t += 5000;
    }
    const state = feedReadings(machine, IDLE_THRESHOLD - 0.5, LEARN_IDLE_READINGS, t);
    expect(state).toBe('learn_complete');
  });

  it('plateau does NOT trigger before window has filled (< PLATEAU_MIN_SPAN_MS)', () => {
    const machine = createMachine();
    machine.startLearning(99);

    // 50W peak, then 30 readings at exactly 7W (~2.5min) — not enough span yet
    let t = 0;
    machine.feedReading(50, t); t += 5000;
    for (let i = 0; i < 30; i++) {
      machine.feedReading(7, t); t += 5000;
    }
    expect(machine.state).toBe('learning');
  });

  it('LEARNING -> LEARN_COMPLETE via hard-stop after LEARN_HARD_STOP_MS', () => {
    const machine = createMachine();
    machine.startLearning(99);

    // First reading at t=0 to anchor learnStartTimestamp
    machine.feedReading(60, 0);
    expect(machine.state).toBe('learning');

    // Jump to just past the hard-stop deadline at sustained power
    machine.feedReading(60, LEARN_HARD_STOP_MS + 1000);
    expect(machine.state).toBe('learn_complete');
  });

  it('fast-path IDLE_THRESHOLD still triggers on clean charger shutoff', () => {
    const machine = createMachine();
    machine.startLearning(99);

    // CC at 50W for a bit
    let t = 0;
    for (let i = 0; i < 10; i++) {
      machine.feedReading(50, t); t += 5000;
    }
    // Then sudden drop to 0W (charger powered off) — fast path fires after LEARN_IDLE_READINGS
    const state = feedReadings(machine, IDLE_THRESHOLD - 0.5, LEARN_IDLE_READINGS, t);
    expect(state).toBe('learn_complete');
  });

  // --- Plan 11-02 band-aware stop logic (SOCB-03) ---

  it('handleCharging transitions to countdown when socBest >= target even on a wide band', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch(makeMatch({ profileName: 'iPad', estimatedStartSoc: 0 }), 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging
    skipWarmUp(machine);

    // Session 19 (2026-05-15) incident: wide band 20-80 with socBest landing
    // on target previously locked aggressive out. Behaviour is now flipped —
    // socBest >= target is sufficient. FPD-04 wall-clock timeout remains the
    // backstop for noisy curve matches that hover near target indefinitely.
    machine.targetSoc = 80;
    machine.stopMode = 'aggressive';
    machine.socMin = 20;
    machine.socMax = 80;
    machine.socBest = 80;
    machine.feedReading(CHARGE_THRESHOLD + 10, 20000);
    expect(machine.state).toBe('countdown');
  });

  it('handleCharging then handleCountdown progress when band collapses (aggressive)', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch(makeMatch({ profileName: 'iPad', estimatedStartSoc: 0 }), 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging
    skipWarmUp(machine);

    machine.targetSoc = 80;
    machine.stopMode = 'aggressive';
    machine.socMin = 78;
    machine.socMax = 82;
    machine.socBest = 80;
    machine.feedReading(CHARGE_THRESHOLD + 10, 20000);
    expect(machine.state).toBe('countdown');

    // handleCountdown re-evaluates the same gate; transitions to stopping
    machine.feedReading(CHARGE_THRESHOLD + 10, 30000);
    expect(machine.state).toBe('stopping');
  });

  it('handleCharging conservative gating waits for socMin >= target', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch(makeMatch({ profileName: 'iPad', estimatedStartSoc: 0 }), 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging
    skipWarmUp(machine);

    machine.targetSoc = 80;
    machine.stopMode = 'conservative';
    // socMin=79 < target=80 → do NOT trip (band straddles target).
    machine.socMin = 79;
    machine.socMax = 81;
    machine.socBest = 85;
    machine.feedReading(CHARGE_THRESHOLD + 10, 20000);
    expect(machine.state).toBe('charging');

    // Propagate socMin to 80 (Wh accumulation in production) → conservative trips.
    machine.socMin = 80;
    machine.feedReading(CHARGE_THRESHOLD + 10, 30000);
    expect(machine.state).toBe('countdown');
  });

  it('SOCB warm-up gate — shouldStop is suppressed for the first MIN_CHARGING_READINGS_FOR_STOP readings (v1.4.2)', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch(makeMatch({ profileName: 'iPad', estimatedStartSoc: 0 }), 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging

    // Stop-eligible state from t=0 (Session 20 pattern: wrong-profile match
    // anchored socBest above target before any FPD-02 refresh).
    machine.targetSoc = 80;
    machine.stopMode = 'aggressive';
    machine.socMin = 78;
    machine.socMax = 82;
    machine.socBest = 83;

    // Feed exactly (MIN - 1) readings — still inside the warm-up window.
    for (let i = 0; i < MIN_CHARGING_READINGS_FOR_STOP - 1; i++) {
      machine.feedReading(CHARGE_THRESHOLD + 10, 20_000 + i * 5_000);
    }
    expect(machine.state).toBe('charging');

    // One more reading clears the gate — shouldStop fires.
    machine.feedReading(CHARGE_THRESHOLD + 10, 20_000 + MIN_CHARGING_READINGS_FOR_STOP * 5_000);
    expect(machine.state).toBe('countdown');
  });

  // --- Phase 12 FPD-01 stale-power watchdog ---

  function driveToCharging(machine: ChargeStateMachine): number {
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch(makeMatch({ profileName: 'iPad', estimatedStartSoc: 0 }), 42);
    // Keep socMin below target so shouldStop stays false during the test —
    // we want the stale-power gate to be the only path to abort.
    machine.targetSoc = 80;
    machine.stopMode = 'aggressive';
    machine.socMin = 10;
    machine.socMax = 30;
    machine.socBest = 20;
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging
    return 15000; // next timestamp
  }

  it('FPD-01: 60 consecutive readings at apower=0 transitions to aborted with stale_power reason', () => {
    const machine = createMachine();
    let t = driveToCharging(machine);
    expect(machine.state).toBe('charging');

    const transitionSpy = vi.fn();
    machine.onTransition = transitionSpy;

    // Feed 59 zero-power readings — should remain in 'charging'.
    for (let i = 0; i < 59; i++) {
      machine.feedReading(0, t);
      t += 5000;
    }
    expect(machine.state).toBe('charging');
    expect(machine.stalePowerCount).toBe(59);

    // The 60th zero-power reading crosses the window → abort.
    machine.feedReading(0, t);
    expect(machine.state).toBe('aborted');
    expect(transitionSpy).toHaveBeenCalledWith('charging', 'aborted', { reason: 'stale_power' });
    // Counter resets to 0 after firing.
    expect(machine.stalePowerCount).toBe(0);
  });

  it('FPD-01: a single reading >= threshold mid-window resets the counter', () => {
    const machine = createMachine();
    let t = driveToCharging(machine);

    // Feed 30 zero-power readings.
    for (let i = 0; i < 30; i++) {
      machine.feedReading(0, t);
      t += 5000;
    }
    expect(machine.state).toBe('charging');
    expect(machine.stalePowerCount).toBe(30);

    // One reading above threshold resets the counter.
    machine.feedReading(5, t);
    t += 5000;
    expect(machine.stalePowerCount).toBe(0);

    // 59 more zero-power readings — still 'charging' (we are at 59, not 60).
    for (let i = 0; i < 59; i++) {
      machine.feedReading(0, t);
      t += 5000;
    }
    expect(machine.state).toBe('charging');
    expect(machine.stalePowerCount).toBe(59);
  });

  it('FPD-01: stale-power watchdog also fires from countdown state', () => {
    const machine = createMachine();
    let t = driveToCharging(machine);

    // Force state to countdown directly (mirrors what shouldStop would do).
    machine.state = 'countdown';

    const transitionSpy = vi.fn();
    machine.onTransition = transitionSpy;

    for (let i = 0; i < 60; i++) {
      machine.feedReading(0, t);
      t += 5000;
    }
    expect(machine.state).toBe('aborted');
    expect(transitionSpy).toHaveBeenCalledWith('countdown', 'aborted', { reason: 'stale_power' });
  });

  it('FPD-01: stalePowerCount remains 0 in idle/detecting/matched (only counts in charging+countdown)', () => {
    const machine = createMachine();
    // Idle: feed zeros — should not increment.
    for (let i = 0; i < 10; i++) {
      machine.feedReading(0, i * 5000);
    }
    expect(machine.stalePowerCount).toBe(0);

    // Drive to charging and confirm the counter starts working.
    let t = driveToCharging(machine);
    machine.feedReading(0, t);
    expect(machine.stalePowerCount).toBe(1);
  });

  it('FPD-01: reset() zeroes stalePowerCount', () => {
    const machine = createMachine();
    let t = driveToCharging(machine);
    machine.feedReading(0, t); t += 5000;
    machine.feedReading(0, t);
    expect(machine.stalePowerCount).toBe(2);

    machine.abort();
    expect(machine.stalePowerCount).toBe(0);
  });

  // --- Phase 12 FPD-04 max-session-duration watchdog ---

  it('FPD-04: forceTimeout transitions to "aborted" with reason="timeout" synchronously', () => {
    const machine = createMachine();
    driveToCharging(machine);
    expect(machine.state).toBe('charging');

    const transitionSpy = vi.fn();
    machine.onTransition = transitionSpy;

    expect(machine.forceTimeout).toBeTypeOf('function');
    machine.forceTimeout();

    expect(machine.state).toBe('aborted');
    expect(transitionSpy).toHaveBeenCalledWith('charging', 'aborted', { reason: 'timeout' });
  });

  // --- Detection power-loss recovery (stuck-detecting / missing-feedback bug) ---
  // A device that briefly drew power (-> detecting) then dropped to ~0 W before
  // any match committed used to sit in 'detecting' forever. handleDetecting now
  // recycles to 'idle' after a sustained idle stretch.

  it('recycles to idle when power collapses during detection (no match)', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    expect(machine.state).toBe('detecting');

    // Power disappears (unplugged / finished before any setMatch commit).
    const state = feedReadings(machine, 0, SUSTAINED_READINGS, 100000);
    expect(state).toBe('idle');
    expect(machine.state).toBe('idle');
  });

  it('stays in detecting while charging power persists without a match', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    expect(machine.state).toBe('detecting');

    // Power continues with no match committed — detection must hold (exhaustion
    // / ambiguity handling is ChargeMonitor's concern, not a collapse).
    const state = feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS * 3, 100000);
    expect(state).toBe('detecting');
  });

  it('does not recycle on a brief power dip shorter than the idle window', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    expect(machine.state).toBe('detecting');

    // A dip one reading short of the window, then recovery, must NOT recycle.
    feedReadings(machine, IDLE_THRESHOLD - 1, SUSTAINED_READINGS - 1, 100000);
    expect(machine.state).toBe('detecting');
    const state = feedReadings(machine, CHARGE_THRESHOLD + 10, 1, 200000);
    expect(state).toBe('detecting');
  });
});
