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

export class ChargeMonitor {
  private eventBus: EventBus;

  private machines = new Map<string, ChargeStateMachine>();
  private detectionBuffers = new Map<string, number[]>();
  private sessionWh = new Map<string, number>();
  private lastRelayOff = new Map<string, number>();
  private sessionIds = new Map<string, number>();
  private sessionStartEnergy = new Map<string, number>();
  private sessionStartedAt = new Map<string, number>();
  private sessionEtaSeconds = new Map<string, number>();
  private sessionEnergyRemainingWh = new Map<string, number>();
  // SOC-math baseline: shifts forward on estimatedSoc overrides so updateSocTracking
  // reads currentWh = 0 immediately after a correction. Distinct from sessionStartEnergy
  // which stays anchored at session start and drives the user-visible "Wh geladen".
  private socBaselineEnergy = new Map<string, number>();
  // Cumulative Wh saved to DB before the last service restart. On the first reading
  // after resume we use this to recover sessionStartEnergy so "Wh geladen" doesn't
  // snap back to 0 every time the service restarts.
  private sessionPriorEnergyWh = new Map<string, number>();
  private matchData = new Map<string, MatchResult>();
  private learnReadingCount = new Map<string, number>();
  private learnCumulativeWh = new Map<string, number>();
  private learnLastPower = new Map<string, number>();
  private learnLastTimestamp = new Map<string, number>();
  private learnStartPower = new Map<string, number>();
  private learnPowerSum = new Map<string, number>();
  private learnMaxPower = new Map<string, number>();

  private powerHandler: ((reading: PowerReading) => void) | null = null;

  constructor(eventBus: EventBus, _db?: unknown) {
    this.eventBus = eventBus;
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
   * Stop listening, clear all state.
   */
  stop(): void {
    if (this.powerHandler) {
      this.eventBus.removeListener('power:*', this.powerHandler);
      this.powerHandler = null;
    }
    this.machines.clear();
    this.detectionBuffers.clear();
    this.sessionWh.clear();
  }

  /**
   * Override an active session's profile, target SOC, or current estimated SOC.
   */
  overrideSession(
    sessionId: number,
    opts: { profileId?: number; targetSoc?: number; estimatedSoc?: number }
  ): void {
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
          .set({ profileId: opts.profileId, targetSoc: machine.targetSoc })
          .where(eq(chargeSessions.id, sessionId))
          .run();

        // Update or synthesize match data so updateSocTracking() can resume.
        // Synthesis is required when a session was resumed without a profile
        // (e.g. after a restart with a bug-clobbered DB row) — without a
        // match entry, SOC tracking would early-return forever.
        const existingMatch = this.matchData.get(targetPlugId);
        if (existingMatch) {
          existingMatch.profileId = opts.profileId;
          existingMatch.profileName = profile.name;
        } else {
          this.matchData.set(targetPlugId, {
            profileId: profile.id,
            profileName: profile.name,
            confidence: 1.0,
            curveOffsetSeconds: 0,
            estimatedStartSoc: machine.estimatedSoc,
          });
        }
      }
    }

    if (opts.estimatedSoc !== undefined) {
      // Rebase the SOC math baseline (socBaselineEnergy) to the current plug
      // totalEnergy so the next reading computes currentWh-for-soc ≈ 0 and
      // updateSocTracking tracks forward from the user's value. The SEPARATE
      // sessionStartEnergy / sessionWh stay anchored at session creation and
      // keep the "Wh geladen" display stable across corrections.
      machine.estimatedSoc = opts.estimatedSoc;

      const existingMatch = this.matchData.get(targetPlugId);
      if (existingMatch) {
        existingMatch.estimatedStartSoc = opts.estimatedSoc;
      }

      const oldBaseline = this.socBaselineEnergy.get(targetPlugId);
      const sessionStart = this.sessionStartEnergy.get(targetPlugId);
      const totalConsumed = this.sessionWh.get(targetPlugId) ?? 0;
      if (oldBaseline !== undefined && sessionStart !== undefined) {
        // New baseline = session start + all consumption so far
        this.socBaselineEnergy.set(targetPlugId, sessionStart + totalConsumed);
      }

      db.update(chargeSessions)
        .set({ estimatedSoc: opts.estimatedSoc })
        .where(eq(chargeSessions.id, sessionId))
        .run();
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
  }

  /**
   * Stop learning for a plug.
   */
  stopLearning(plugId: string): void {
    const machine = this.machines.get(plugId);
    if (machine && machine.state === 'learning') {
      machine.abort();
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

      // Once detection exhausts buffer without match, emit with detectionExhausted
      // flag so UI switches from "detecting..." spinner to UnknownDeviceDialog.
      if (buffer.length >= MAX_DETECTION_READINGS && machine.state === 'detecting') {
        this.emitChargeEvent(plugId, 'detecting', true);
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
        const now = Date.now();
        // Persist the Shelly aenergy.total snapshot so we can always recompute
        // displayed Wh = currentTotalEnergy - startTotalEnergy across restarts.
        const sessionRow = db.insert(chargeSessions).values({
          plugId,
          state: 'detecting',
          startedAt: now,
          createdAt: now,
          startTotalEnergy: reading.totalEnergy,
        }).returning().get();

        this.sessionIds.set(plugId, sessionRow.id);
        this.detectionBuffers.set(plugId, []);
        this.sessionStartEnergy.set(plugId, reading.totalEnergy);
        this.socBaselineEnergy.set(plugId, reading.totalEnergy);
        this.sessionStartedAt.set(plugId, now);
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

        // Turn the plug off now that the teach-in device has finished drawing
        // power. Mirrors the 'stopping' handler for regular charging sessions.
        const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
        if (plug && plug.ipAddress && canSwitchRelay(this.lastRelayOff.get(plugId) ?? 0)) {
          switchRelayOff(
            { id: plug.id, ipAddress: plug.ipAddress },
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

        // Persist match to DB directly — handleTransition('detecting','matched')
        // is skipped because setMatch mutates state synchronously from inside
        // handlePowerReading after newState was already captured. Without this
        // write, profile_id / target_soc / detection_confidence never land in
        // the DB, and resume-after-restart loses the match entirely.
        const profile = db.select().from(deviceProfiles)
          .where(eq(deviceProfiles.id, result.profileId)).get();
        if (profile) {
          machine.targetSoc = profile.targetSoc;
        }
        db.update(chargeSessions).set({
          state: 'matched',
          profileId: result.profileId,
          detectionConfidence: result.confidence,
          curveOffsetSeconds: result.curveOffsetSeconds,
          targetSoc: machine.targetSoc,
          estimatedSoc: result.estimatedStartSoc,
        }).where(eq(chargeSessions.id, sessionId)).run();

        this.emitChargeEvent(plugId, 'matched');
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
    // Lazy-init the session anchor so resumed sessions still get a stable
    // baseline. If we have a priorEnergyWh from DB (from before the restart),
    // walk it back from reading.totalEnergy to recover the TRUE session start;
    // otherwise anchor at NOW and accept that this session's display Wh will
    // count from here forward.
    let startEnergy = this.sessionStartEnergy.get(plugId);
    if (startEnergy === undefined) {
      const prior = this.sessionPriorEnergyWh.get(plugId) ?? 0;
      startEnergy = reading.totalEnergy - prior;
      this.sessionStartEnergy.set(plugId, startEnergy);
      this.sessionPriorEnergyWh.delete(plugId);
    }
    // socBaseline anchors SOC math; shifts on estimatedSoc overrides so SOC
    // retargets cleanly. On resume (or any other first-access) it MUST default
    // to the CURRENT reading.totalEnergy, not to startEnergy — because
    // match.estimatedStartSoc reflects the last-known SOC, not the SOC at
    // session start. Anchoring here keeps socWh = 0 initially so SOC doesn't
    // jump forward by the entire session's accumulated energy.
    let socBaseline = this.socBaselineEnergy.get(plugId);
    if (socBaseline === undefined) {
      socBaseline = reading.totalEnergy;
      this.socBaselineEnergy.set(plugId, socBaseline);
    }

    const sessionWh = reading.totalEnergy - startEnergy;   // display: total charged
    const socWh = reading.totalEnergy - socBaseline;       // math: since last override
    this.sessionWh.set(plugId, sessionWh);

    const machine = this.machines.get(plugId);
    if (!machine) return;

    const match = this.matchData.get(plugId);
    if (!match) return;

    // Load total energy from profile's reference curve
    const curve = db.select().from(referenceCurves)
      .where(eq(referenceCurves.profileId, match.profileId)).get();
    if (!curve) return;

    const soc = estimateSoc(socWh, curve.totalEnergyWh, match.estimatedStartSoc);
    machine.estimatedSoc = soc;

    // Remaining energy to reach targetSoc. Always computed (even at apower=0)
    // so the banner can still show "X Wh fehlen" when a charger pauses.
    const targetSoc = machine.targetSoc;
    if (targetSoc > soc) {
      const remainingWh = curve.totalEnergyWh * (targetSoc - soc) / 100;
      this.sessionEnergyRemainingWh.set(plugId, Math.max(0, remainingWh));
      if (reading.apower > 1) {
        this.sessionEtaSeconds.set(plugId, Math.max(0, Math.round(remainingWh / reading.apower * 3600)));
      } else {
        this.sessionEtaSeconds.delete(plugId);
      }
    } else {
      this.sessionEnergyRemainingWh.delete(plugId);
      this.sessionEtaSeconds.delete(plugId);
    }

    // Update session in DB
    const sessionId = this.sessionIds.get(plugId);
    if (sessionId) {
      db.update(chargeSessions).set({
        estimatedSoc: soc,
        energyWh: sessionWh,
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

    if (!plug.ipAddress) {
      console.error(`Cannot switch relay for plug ${plugId}: no IP address configured`);
      this.emitChargeEvent(plugId, 'error');
      return;
    }

    const success = await switchRelayOff(
      { id: plug.id, ipAddress: plug.ipAddress },
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

  private emitChargeEvent(plugId: string, state: ChargeState, detectionExhausted = false): void {
    const machine = this.machines.get(plugId);
    const match = this.matchData.get(plugId);
    const sessionId = this.sessionIds.get(plugId);
    const startedAt = this.sessionStartedAt.get(plugId);
    const etaSeconds = this.sessionEtaSeconds.get(plugId);

    const event: ChargeStateEvent = {
      plugId,
      state,
      profileId: match?.profileId,
      profileName: match?.profileName,
      confidence: match?.confidence,
      estimatedSoc: machine?.estimatedSoc,
      targetSoc: machine?.targetSoc,
      sessionId,
      detectionExhausted,
      elapsedMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
      etaSeconds,
      energyChargedWh: this.sessionWh.get(plugId),
      energyRemainingWh: this.sessionEnergyRemainingWh.get(plugId),
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

  private cleanupSession(plugId: string): void {
    this.sessionIds.delete(plugId);
    this.detectionBuffers.delete(plugId);
    this.sessionWh.delete(plugId);
    this.sessionStartEnergy.delete(plugId);
    this.sessionStartedAt.delete(plugId);
    this.sessionEtaSeconds.delete(plugId);
    this.sessionEnergyRemainingWh.delete(plugId);
    this.socBaselineEnergy.delete(plugId);
    this.sessionPriorEnergyWh.delete(plugId);
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
              // estimatedStartSoc must reflect the LAST known SOC, not 0.
              // Otherwise updateSocTracking's first call recomputes
              // soc = estimateSoc(0, totalWh, 0) = 0 and clobbers the saved
              // value, wiping out any prior "SOC korrigieren" correction.
              const match: MatchResult = {
                profileId: profile.id,
                profileName: profile.name,
                confidence: session.detectionConfidence ?? 1,
                curveOffsetSeconds: session.curveOffsetSeconds ?? 0,
                estimatedStartSoc: session.estimatedSoc ?? 0,
              };
              this.matchData.set(session.plugId, match);
            }
          }
          machine.state = session.state as ChargeState;
          machine.sessionId = session.id;
          machine.targetSoc = session.targetSoc ?? 80;
          machine.estimatedSoc = session.estimatedSoc ?? 0;
          break;
      }

      this.sessionIds.set(session.plugId, session.id);
      this.sessionWh.set(session.plugId, session.energyWh ?? 0);
      this.sessionStartedAt.set(session.plugId, session.startedAt);
      if (session.startTotalEnergy != null) {
        // Display anchor: totalEnergy at session start. sessionWh from here on
        // is computed as reading.totalEnergy - sessionStartEnergy.
        this.sessionStartEnergy.set(session.plugId, session.startTotalEnergy);
      } else {
        // Legacy fallback for pre-migration sessions: recover the session
        // anchor from the last-saved energyWh delta on first reading.
        this.sessionPriorEnergyWh.set(session.plugId, session.energyWh ?? 0);
      }
      // NOTE: socBaselineEnergy is intentionally NOT set here. On resume,
      // match.estimatedStartSoc is the LAST known SOC (not the session start
      // SOC), so socBaseline must anchor at the NEXT reading's totalEnergy so
      // socWh starts at 0 and SOC tracks forward from the saved value. The
      // lazy-init in updateSocTracking handles this correctly.

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
