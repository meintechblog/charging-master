import { describe, it, expect, vi } from 'vitest';
import {
  ChargeStateMachine,
  CHARGE_THRESHOLD,
  IDLE_THRESHOLD,
  SUSTAINED_READINGS,
  LEARN_IDLE_READINGS,
  LEARN_HARD_STOP_MS,
  PLATEAU_WINDOW_MS,
  PLATEAU_MIN_PEAK_W,
} from './charge-state-machine';
import type { MatchResult } from './types';

function createMachine() {
  return new ChargeStateMachine();
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

    const match: MatchResult = {
      profileId: 1,
      profileName: 'E-Bike',
      confidence: 0.85,
      curveOffsetSeconds: 0,
      estimatedStartSoc: 0,
    };
    machine.setMatch(match, 42);
    expect(machine.state).toBe('matched');
    expect(machine.sessionId).toBe(42);
  });

  it('transitions MATCHED -> CHARGING after display period', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);

    machine.setMatch({
      profileId: 1,
      profileName: 'E-Bike',
      confidence: 0.85,
      curveOffsetSeconds: 0,
      estimatedStartSoc: 0,
    }, 42);
    expect(machine.state).toBe('matched');

    // Feed a reading after the display period (5 seconds)
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000);
    expect(machine.state).toBe('charging');
  });

  it('transitions CHARGING -> COUNTDOWN when SOC reaches target - 5', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch({
      profileId: 1,
      profileName: 'E-Bike',
      confidence: 0.85,
      curveOffsetSeconds: 0,
      estimatedStartSoc: 0,
    }, 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging

    // Set target and simulate SOC reaching threshold
    machine.targetSoc = 80;
    machine.estimatedSoc = 75; // target - 5
    machine.feedReading(CHARGE_THRESHOLD + 10, 20000);
    expect(machine.state).toBe('countdown');
  });

  it('transitions COUNTDOWN -> STOPPING when SOC reaches target', () => {
    const machine = createMachine();
    feedReadings(machine, CHARGE_THRESHOLD + 10, SUSTAINED_READINGS);
    machine.setMatch({
      profileId: 1,
      profileName: 'E-Bike',
      confidence: 0.85,
      curveOffsetSeconds: 0,
      estimatedStartSoc: 0,
    }, 42);
    machine.feedReading(CHARGE_THRESHOLD + 10, 10000); // -> charging

    machine.targetSoc = 80;
    machine.estimatedSoc = 75;
    machine.feedReading(CHARGE_THRESHOLD + 10, 20000); // -> countdown

    machine.estimatedSoc = 80;
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

    // Sudden CV drop to ~7W plateau, hold ~5min — should trigger
    for (let i = 0; i < 80; i++) {
      machine.feedReading(7 + (i % 2) * 0.3, t); t += 5000;
    }
    expect(machine.state).toBe('learn_complete');
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
});
