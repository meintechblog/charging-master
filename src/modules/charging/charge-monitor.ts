/**
 * ChargeMonitor -- server-side singleton managing per-plug state machines.
 *
 * Listens to EventBus power readings, routes to per-plug ChargeStateMachine instances,
 * runs DTW matching, tracks SOC, triggers auto-stop via relay controller.
 *
 * Lifecycle: Created in server.ts, exposed on globalThis.__chargeMonitor.
 */

import { ChargeStateMachine, CHARGE_THRESHOLD } from './charge-state-machine';
import { matchCurve, type ProfileWithCurve } from './curve-matcher';
import { estimateSoc } from './soc-estimator';
import { switchRelayOff, canSwitchRelay } from './relay-controller';
import type { ChargeState, ChargeSessionData, ChargeStateEvent, MatchResult } from './types';
import type { EventBus, PowerReading } from '../events/event-bus';
import type { MqttService } from '../mqtt/mqtt-service';
import { db } from '@/db/client';
import {
  chargeSessions,
  deviceProfiles,
  referenceCurves,
  referenceCurvePoints,
  plugs,
} from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

const MIN_DETECTION_READINGS = 60;
const MAX_DETECTION_READINGS = 120;
const STATUS_POLL_INTERVAL_MS = 5000;

export class ChargeMonitor {
  private eventBus: EventBus;
  private mqttService: MqttService;

  private machines = new Map<string, ChargeStateMachine>();
  private detectionBuffers = new Map<string, number[]>();
  private sessionWh = new Map<string, number>();
  private lastRelayOff = new Map<string, number>();
  private sessionIds = new Map<string, number>();
  private sessionStartEnergy = new Map<string, number>();
  private matchData = new Map<string, MatchResult>();
  private pollingTimers = new Map<string, NodeJS.Timeout>();
  private plugTopics = new Map<string, string>();
  private learnReadingCount = new Map<string, number>();
  private learnCumulativeWh = new Map<string, number>();
  private learnLastPower = new Map<string, number>();
  private learnLastTimestamp = new Map<string, number>();
  private learnStartPower = new Map<string, number>();
  private learnPowerSum = new Map<string, number>();
  private learnMaxPower = new Map<string, number>();

  private powerHandler: ((reading: PowerReading) => void) | null = null;

  constructor(eventBus: EventBus, mqttService: MqttService, _db?: unknown) {
    this.eventBus = eventBus;
    this.mqttService = mqttService;
  }

  /**
   * Start listening to power readings and resume any active sessions from DB.
   */
  start(): void {
    this.powerHandler = (reading: PowerReading) => {
      this.handlePowerReading(reading);
    };
    this.eventBus.on('power:*', this.powerHandler);

    // Resume active sessions from DB (D-28)
    this.resumeActiveSessions();
  }

  /**
   * Stop listening, clear all timers.
   */
  stop(): void {
    if (this.powerHandler) {
      this.eventBus.removeListener('power:*', this.powerHandler);
      this.powerHandler = null;
    }
    for (const timer of this.pollingTimers.values()) {
      clearInterval(timer);
    }
    this.pollingTimers.clear();
    this.machines.clear();
    this.detectionBuffers.clear();
    this.sessionWh.clear();
  }

  /**
   * Override an active session's profile or target SOC.
   */
  overrideSession(sessionId: number, opts: { profileId?: number; targetSoc?: number }): void {
    // Find the plug for this session
    let targetPlugId: string | null = null;
    for (const [plugId, sid] of this.sessionIds.entries()) {
      if (sid === sessionId) {
        targetPlugId = plugId;
        break;
      }
    }
    if (!targetPlugId) return;

    const machine = this.machines.get(targetPlugId);
    if (!machine) return;

    if (opts.targetSoc !== undefined) {
      machine.targetSoc = opts.targetSoc;
      db.update(chargeSessions)
        .set({ targetSoc: opts.targetSoc })
        .where(eq(chargeSessions.id, sessionId))
        .run();
    }

    if (opts.profileId !== undefined) {
      // Load new profile's reference curve data
      const profile = db.select().from(deviceProfiles).where(eq(deviceProfiles.id, opts.profileId)).get();
      if (profile) {
        db.update(chargeSessions)
          .set({ profileId: opts.profileId })
          .where(eq(chargeSessions.id, sessionId))
          .run();

        // Update match data
        const existingMatch = this.matchData.get(targetPlugId);
        if (existingMatch) {
          existingMatch.profileId = opts.profileId;
          existingMatch.profileName = profile.name;
        }
      }
    }

    // Emit updated state so SSE clients reflect the change
    this.emitChargeEvent(targetPlugId, machine.state);
  }

  /**
   * Put a plug's state machine into LEARNING state.
   */
  startLearning(plugId: string, sessionId: number): void {
    const machine = this.getOrCreateMachine(plugId);
    this.sessionIds.set(plugId, sessionId);
    machine.startLearning(sessionId);
    this.startStatusPolling(plugId);
  }

  /**
   * Stop learning for a plug.
   */
  stopLearning(plugId: string): void {
    const machine = this.machines.get(plugId);
    if (machine && machine.state === 'learning') {
      machine.abort();
      this.stopStatusPolling(plugId);
    }
  }

  /**
   * Abort active session for a plug.
   */
  abortSession(plugId: string): void {
    const machine = this.machines.get(plugId);
    if (!machine) return;

    const sessionId = this.sessionIds.get(plugId);
    if (sessionId) {
      db.update(chargeSessions)
        .set({ state: 'aborted', stoppedAt: Date.now(), stopReason: 'user_abort' })
        .where(eq(chargeSessions.id, sessionId))
        .run();
    }

    machine.abort();
    this.stopStatusPolling(plugId);
    this.cleanupSession(plugId);
    this.emitChargeEvent(plugId, 'aborted');
  }

  /**
   * Return current session data for a plug.
   */
  getSessionData(plugId: string): ChargeSessionData | null {
    const machine = this.machines.get(plugId);
    if (!machine || machine.state === 'idle') return null;

    const sessionId = this.sessionIds.get(plugId);
    if (!sessionId) return null;

    const match = this.matchData.get(plugId);

    return {
      sessionId,
      plugId,
      state: machine.state,
      profileId: match?.profileId,
      profileName: match?.profileName,
      confidence: match?.confidence,
      estimatedSoc: machine.estimatedSoc,
      targetSoc: machine.targetSoc,
      energyWh: this.sessionWh.get(plugId) ?? 0,
      startedAt: 0, // Populated from DB if needed
    };
  }

  /**
   * Return all active sessions.
   */
  getActiveSessions(): ChargeSessionData[] {
    const sessions: ChargeSessionData[] = [];
    for (const [plugId] of this.machines) {
      const data = this.getSessionData(plugId);
      if (data) sessions.push(data);
    }
    return sessions;
  }

  // --- Internal ---

  private handlePowerReading(reading: PowerReading): void {
    const { plugId, apower, timestamp } = reading;

    // Cache plug topic for status polling
    if (!this.plugTopics.has(plugId)) {
      this.plugTopics.set(plugId, plugId);
    }

    const machine = this.getOrCreateMachine(plugId);
    const prevState = machine.state;

    machine.feedReading(apower, timestamp);

    const newState = machine.state;

    // Track learning readings
    if (newState === 'learning' || prevState === 'learning') {
      const count = (this.learnReadingCount.get(plugId) ?? 0) + 1;
      this.learnReadingCount.set(plugId, count);
      this.learnPowerSum.set(plugId, (this.learnPowerSum.get(plugId) ?? 0) + apower);
      if (!this.learnStartPower.has(plugId)) {
        this.learnStartPower.set(plugId, apower);
      }
      const currentMax = this.learnMaxPower.get(plugId) ?? 0;
      if (apower > currentMax) {
        this.learnMaxPower.set(plugId, apower);
      }

      // Use Shelly's hardware energy counter (aenergy.total) — far more accurate than software integration
      if (reading.totalEnergy > 0) {
        const startEnergy = this.sessionStartEnergy.get(plugId);
        if (startEnergy !== undefined) {
          this.learnCumulativeWh.set(plugId, reading.totalEnergy - startEnergy);
        } else {
          // First reading after start or resume — back-calculate start energy from stored Wh
          const storedWh = this.learnCumulativeWh.get(plugId) ?? 0;
          this.sessionStartEnergy.set(plugId, reading.totalEnergy - storedWh);
        }
      }

      this.learnLastPower.set(plugId, apower);
      this.learnLastTimestamp.set(plugId, timestamp);

      // Persist energy to DB every 5 readings (~5s) so restarts don't lose much
      if (count % 5 === 0) {
        const sessionId = this.sessionIds.get(plugId);
        if (sessionId) {
          db.update(chargeSessions).set({
            energyWh: this.learnCumulativeWh.get(plugId) ?? 0,
          }).where(eq(chargeSessions.id, sessionId)).run();
        }
      }
    }

    // Handle detection buffer accumulation
    if (newState === 'detecting') {
      let buffer = this.detectionBuffers.get(plugId);
      if (!buffer) {
        buffer = [];
        this.detectionBuffers.set(plugId, buffer);
      }
      buffer.push(apower);

      // Run matching after accumulating enough readings
      if (buffer.length >= MIN_DETECTION_READINGS) {
        this.tryMatch(plugId, buffer, timestamp);
      }

      // If still detecting after max readings, emit unknown device
      if (buffer.length >= MAX_DETECTION_READINGS && machine.state === 'detecting') {
        this.emitChargeEvent(plugId, 'detecting');
      }
    }

    // Handle state transitions
    if (prevState !== newState) {
      this.handleTransition(plugId, prevState, newState, reading);
    }

    // During charging/countdown, update SOC tracking
    if (newState === 'charging' || newState === 'countdown') {
      this.updateSocTracking(plugId, reading);
    }
  }

  private handleTransition(
    plugId: string,
    from: ChargeState,
    to: ChargeState,
    reading: PowerReading
  ): void {
    const machine = this.machines.get(plugId)!;

    switch (to) {
      case 'detecting': {
        // Create new charge session
        const sessionRow = db.insert(chargeSessions).values({
          plugId,
          state: 'detecting',
          startedAt: Date.now(),
          createdAt: Date.now(),
        }).returning().get();

        this.sessionIds.set(plugId, sessionRow.id);
        this.detectionBuffers.set(plugId, []);
        this.sessionStartEnergy.set(plugId, reading.totalEnergy);
        this.sessionWh.set(plugId, 0);
        this.emitChargeEvent(plugId, 'detecting');
        break;
      }

      case 'matched': {
        const sessionId = this.sessionIds.get(plugId);
        const match = this.matchData.get(plugId);
        if (sessionId && match) {
          // Load profile's target SOC
          const profile = db.select().from(deviceProfiles)
            .where(eq(deviceProfiles.id, match.profileId)).get();
          if (profile) {
            machine.targetSoc = profile.targetSoc;
          }

          db.update(chargeSessions).set({
            state: 'matched',
            profileId: match.profileId,
            detectionConfidence: match.confidence,
            curveOffsetSeconds: match.curveOffsetSeconds,
            targetSoc: machine.targetSoc,
            estimatedSoc: match.estimatedStartSoc,
          }).where(eq(chargeSessions.id, sessionId)).run();
        }
        this.emitChargeEvent(plugId, 'matched');
        break;
      }

      case 'charging': {
        const sessionId = this.sessionIds.get(plugId);
        if (sessionId) {
          db.update(chargeSessions).set({ state: 'charging' })
            .where(eq(chargeSessions.id, sessionId)).run();
        }
        this.startStatusPolling(plugId);
        this.emitChargeEvent(plugId, 'charging');
        break;
      }

      case 'countdown': {
        const sessionId = this.sessionIds.get(plugId);
        if (sessionId) {
          db.update(chargeSessions).set({ state: 'countdown' })
            .where(eq(chargeSessions.id, sessionId)).run();
        }
        this.emitChargeEvent(plugId, 'countdown');
        break;
      }

      case 'stopping': {
        this.handleStopping(plugId);
        break;
      }

      case 'learn_complete': {
        const sessionId = this.sessionIds.get(plugId);
        if (sessionId) {
          db.update(chargeSessions).set({
            state: 'learn_complete',
            stoppedAt: Date.now(),
            stopReason: 'learn_complete',
          }).where(eq(chargeSessions.id, sessionId)).run();
        }
        this.stopStatusPolling(plugId);

        // Turn the plug off now that the teach-in device has finished drawing
        // power. Mirrors the 'stopping' handler for regular charging sessions.
        const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
        if (plug && canSwitchRelay(this.lastRelayOff.get(plugId) ?? 0)) {
          switchRelayOff(
            this.mqttService,
            { mqttTopicPrefix: plug.mqttTopicPrefix, ipAddress: plug.ipAddress },
            this.eventBus
          ).then((ok) => {
            if (ok) this.lastRelayOff.set(plugId, Date.now());
          }).catch(() => { /* non-fatal */ });
        }

        this.emitChargeEvent(plugId, 'learn_complete');
        break;
      }

      case 'idle': {
        if (from !== 'idle') {
          this.stopStatusPolling(plugId);
          this.cleanupSession(plugId);
        }
        break;
      }
    }
  }

  private async tryMatch(plugId: string, buffer: number[], _timestamp: number): Promise<void> {
    const profiles = this.loadProfilesWithCurves();
    if (profiles.length === 0) return;

    const result = matchCurve(buffer, profiles);
    if (result) {
      this.matchData.set(plugId, result);
      const machine = this.machines.get(plugId);
      const sessionId = this.sessionIds.get(plugId);
      if (machine && sessionId) {
        machine.setMatch(result, sessionId, Date.now());
      }
    }
  }

  private loadProfilesWithCurves(): ProfileWithCurve[] {
    const profiles = db.select().from(deviceProfiles).all();
    const result: ProfileWithCurve[] = [];

    for (const profile of profiles) {
      const curve = db.select().from(referenceCurves)
        .where(eq(referenceCurves.profileId, profile.id)).get();
      if (!curve) continue;

      const points = db.select().from(referenceCurvePoints)
        .where(eq(referenceCurvePoints.curveId, curve.id)).all();

      result.push({
        id: profile.id,
        name: profile.name,
        curve: {
          startPower: curve.startPower,
          durationSeconds: curve.durationSeconds,
          totalEnergyWh: curve.totalEnergyWh,
        },
        curvePoints: points.map((p) => ({
          offsetSeconds: p.offsetSeconds,
          apower: p.apower,
          cumulativeWh: p.cumulativeWh,
        })),
      });
    }

    return result;
  }

  private updateSocTracking(plugId: string, reading: PowerReading): void {
    const startEnergy = this.sessionStartEnergy.get(plugId) ?? reading.totalEnergy;
    const currentWh = reading.totalEnergy - startEnergy;
    this.sessionWh.set(plugId, currentWh);

    const machine = this.machines.get(plugId);
    if (!machine) return;

    const match = this.matchData.get(plugId);
    if (!match) return;

    // Load total energy from profile's reference curve
    const curve = db.select().from(referenceCurves)
      .where(eq(referenceCurves.profileId, match.profileId)).get();
    if (!curve) return;

    const soc = estimateSoc(currentWh, curve.totalEnergyWh, match.estimatedStartSoc);
    machine.estimatedSoc = soc;

    // Update session in DB
    const sessionId = this.sessionIds.get(plugId);
    if (sessionId) {
      db.update(chargeSessions).set({
        estimatedSoc: soc,
        energyWh: currentWh,
      }).where(eq(chargeSessions.id, sessionId)).run();
    }

    this.emitChargeEvent(plugId, machine.state);
  }

  private async handleStopping(plugId: string): Promise<void> {
    const lastOff = this.lastRelayOff.get(plugId) ?? 0;
    if (!canSwitchRelay(lastOff)) {
      this.emitChargeEvent(plugId, 'error');
      return;
    }

    // Get plug info for relay control
    const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
    if (!plug) {
      this.emitChargeEvent(plugId, 'error');
      return;
    }

    const success = await switchRelayOff(
      this.mqttService,
      { mqttTopicPrefix: plug.mqttTopicPrefix, ipAddress: plug.ipAddress },
      this.eventBus
    );

    const sessionId = this.sessionIds.get(plugId);

    if (success) {
      this.lastRelayOff.set(plugId, Date.now());
      if (sessionId) {
        db.update(chargeSessions).set({
          state: 'complete',
          stoppedAt: Date.now(),
          stopReason: 'target_soc_reached',
        }).where(eq(chargeSessions.id, sessionId)).run();
      }
      this.stopStatusPolling(plugId);
      this.emitChargeEvent(plugId, 'complete');
      this.cleanupSession(plugId);
    } else {
      if (sessionId) {
        db.update(chargeSessions).set({
          state: 'error',
          stoppedAt: Date.now(),
          stopReason: 'relay_switch_failed',
        }).where(eq(chargeSessions.id, sessionId)).run();
      }
      this.emitChargeEvent(plugId, 'error');
    }
  }

  private emitChargeEvent(plugId: string, state: ChargeState): void {
    const machine = this.machines.get(plugId);
    const match = this.matchData.get(plugId);
    const sessionId = this.sessionIds.get(plugId);

    const event: ChargeStateEvent = {
      plugId,
      state,
      profileId: match?.profileId,
      profileName: match?.profileName,
      confidence: match?.confidence,
      estimatedSoc: machine?.estimatedSoc,
      targetSoc: machine?.targetSoc,
      sessionId,
    };

    this.eventBus.emitChargeState(event);
  }

  private getOrCreateMachine(plugId: string): ChargeStateMachine {
    let machine = this.machines.get(plugId);
    if (!machine) {
      machine = new ChargeStateMachine();
      machine.onTransition = (from, to) => {
        // Transitions handled in handlePowerReading via state comparison
      };
      this.machines.set(plugId, machine);
    }
    return machine;
  }

  private startStatusPolling(plugId: string): void {
    if (this.pollingTimers.has(plugId)) return;

    const topic = this.plugTopics.get(plugId) ?? plugId;
    const timer = setInterval(() => {
      this.mqttService.requestStatus(topic);
    }, STATUS_POLL_INTERVAL_MS);

    this.pollingTimers.set(plugId, timer);
  }

  private stopStatusPolling(plugId: string): void {
    const timer = this.pollingTimers.get(plugId);
    if (timer) {
      clearInterval(timer);
      this.pollingTimers.delete(plugId);
    }
  }

  private cleanupSession(plugId: string): void {
    this.sessionIds.delete(plugId);
    this.detectionBuffers.delete(plugId);
    this.sessionWh.delete(plugId);
    this.sessionStartEnergy.delete(plugId);
    this.matchData.delete(plugId);
  }

  /**
   * Resume active sessions from DB on startup (D-28).
   */
  private resumeActiveSessions(): void {
    const activeStates = ['detecting', 'matched', 'charging', 'countdown', 'learning'];
    const activeSessions = db.select().from(chargeSessions)
      .where(inArray(chargeSessions.state, activeStates))
      .all();

    const now = Date.now();
    const MAX_DETECTING_AGE_MS = 10 * 60 * 1000; // 10 minutes — detecting should never take longer

    for (const session of activeSessions) {
      // Abort stale detecting sessions that survived a restart
      if (session.state === 'detecting' && (now - session.startedAt) > MAX_DETECTING_AGE_MS) {
        db.update(chargeSessions)
          .set({ state: 'aborted', stoppedAt: now, stopReason: 'stale_on_restart' })
          .where(eq(chargeSessions.id, session.id))
          .run();
        console.log(`Aborted stale detecting session ${session.id} for plug ${session.plugId} (age: ${Math.round((now - session.startedAt) / 60000)} min)`);
        continue;
      }

      const machine = this.getOrCreateMachine(session.plugId);

      // Restore state machine to the correct state
      switch (session.state) {
        case 'learning':
          machine.startLearning(session.id);
          this.startStatusPolling(session.plugId);
          break;
        case 'detecting':
          // Re-enter detecting by simulating sustained readings
          machine.state = 'detecting' as ChargeState;
          break;
        case 'matched':
        case 'charging':
        case 'countdown':
          // Restore to charging state with match data
          if (session.profileId) {
            const profile = db.select().from(deviceProfiles)
              .where(eq(deviceProfiles.id, session.profileId)).get();
            if (profile) {
              const match: MatchResult = {
                profileId: profile.id,
                profileName: profile.name,
                confidence: session.detectionConfidence ?? 0,
                curveOffsetSeconds: session.curveOffsetSeconds ?? 0,
                estimatedStartSoc: 0,
              };
              this.matchData.set(session.plugId, match);
            }
          }
          machine.state = session.state as ChargeState;
          machine.sessionId = session.id;
          machine.targetSoc = session.targetSoc ?? 80;
          machine.estimatedSoc = session.estimatedSoc ?? 0;
          this.startStatusPolling(session.plugId);
          break;
      }

      this.sessionIds.set(session.plugId, session.id);
      this.sessionWh.set(session.plugId, session.energyWh ?? 0);

      // Restore learn tracking maps from DB for learning sessions
      if (session.state === 'learning') {
        this.learnCumulativeWh.set(session.plugId, session.energyWh ?? 0);
        this.learnReadingCount.set(session.plugId, 0);
        this.learnPowerSum.set(session.plugId, 0);
        // sessionStartEnergy will be recalculated from first reading: currentTotal - storedWh
        // This ensures the delta calculation stays correct across restarts
      }

      console.log(`Resumed session ${session.id} for plug ${session.plugId} in state ${session.state} (${(session.energyWh ?? 0).toFixed(1)} Wh)`);
    }
  }
}
