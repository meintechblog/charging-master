/**
 * ChargeMonitor -- server-side singleton managing per-plug state machines.
 *
 * Listens to EventBus power readings, routes to per-plug ChargeStateMachine instances,
 * runs DTW matching, tracks SOC, triggers auto-stop via relay controller.
 *
 * Lifecycle: Created in server.ts, exposed on globalThis.__chargeMonitor.
 */

import { ChargeStateMachine, CHARGE_THRESHOLD, MIN_CHARGING_READINGS_FOR_STOP } from './charge-state-machine';
import {
  readStalePowerWindowSec,
  readMatcherRefreshReadings,
  readLowConfidenceThreshold,
  readMaxSessionHours,
  shouldStopEnergyFallback,
} from './stop-mode';
import * as curveMatcher from './curve-matcher';
import { type ProfileWithCurve } from './curve-matcher';
import {
  logSocCorrection,
  getStartSocBias,
  recalibrateEta,
  getEarlyCorrection,
} from './calibration';
import { estimateSoc, estimateSocTaperAware, type TaperCurvePoint } from './soc-estimator';
import { parseAllowedProfileIds, getPlugProfilePrior, isEnergyImpossible } from './plug-prior';
import { runPostCycleCalibration } from './post-cycle-calibration';
import {
  extractTransientFeatures,
  compareTransientFeatures,
  type TransientFeatures,
} from './plug-in-transient';
import type { PlugTransientEvent } from '../events/event-bus';
import { switchRelayOff, canSwitchRelay } from './relay-controller';
import { renderSocBandAscii } from './soc-band-ascii';
import type { ChargeState, ChargeSessionData, ChargeStateEvent, MatchResult } from './types';
import type { EventBus, PowerReading } from '../events/event-bus';
import { db } from '@/db/client';
import {
  chargeSessions,
  deviceProfiles,
  referenceCurves,
  referenceCurvePoints,
  plugs,
  config,
} from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

// First match attempt fires once the buffer crosses MIN_MATCH_READINGS.
// Earlier match attempts gate behind a stricter confidence to keep
// false-positives down — see DETECTION_PHASES below.
const MIN_MATCH_READINGS = 12;          // ~1 min at 5 s sampling
const MATCH_INTERVAL_READINGS = 12;     // re-probe every minute while detecting
const MAX_DETECTION_READINGS = 120;     // ~10 min hard cap → detectionExhausted
const DETECTION_TARGET_READINGS = 60;   // displayed denominator: "samples/60"

// v1.6.2 active-learning. After this many ms in 'detecting' without a clean
// commit, send one Pushover prompt listing the top-3 candidates. The user
// resolves manually via the dashboard's existing profile-override PUT path.
const AMBIGUITY_PROMPT_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

// Phase-appropriate thresholds. With a small buffer DTW can over-fit a
// transient slice of the wrong reference, so we demand near-perfect fit
// early and relax as samples accumulate.
const EARLY_CONFIDENCE = 0.85;          // 12-23 readings
const MID_CONFIDENCE = 0.75;            // 24-59 readings
const LATE_CONFIDENCE = 0.70;           // 60+ readings (matches old behavior)

function thresholdForBufferSize(n: number): number {
  if (n >= 60) return LATE_CONFIDENCE;
  if (n >= 24) return MID_CONFIDENCE;
  return EARLY_CONFIDENCE;
}

// Anomaly detection: live charging power vs reference curve.
const ANOMALY_DEVIATION_PCT = 0.40;          // 40 % off from expected
const ANOMALY_SUSTAINED_READINGS = 10;       // ~50 s at 5 s sample → no false-positive on transient noise
const ANOMALY_MIN_EXPECTED_W = 5;            // ignore noise comparison when expected is near zero
const ANOMALY_COOLDOWN_MS = 30 * 60 * 1000;  // notify at most once per 30 min per plug

/**
 * v1.7-D: Honor user anchor across FPD-02 adaptive matcher refresh.
 *
 * overrideSession (e.g. iOS Shortcut report-soc) sets match.bandConfidence=1
 * and match.socBest = userValue. Without this guard, the next adaptive refresh
 * runs DTW against the live curve (post-anchor) and computes a fresh socBest
 * that REPLACES the user's ground truth. Diagnosed on Session 23
 * (2026-05-18): user injected soc=13 on a real iPad → adaptive refresh
 * matched the iPad's mid-charge CC plateau against the 80%-region of the
 * reference curve → candidateSocBest jumped to 80 → shouldStop fired at
 * real ~68 %.
 *
 * Post-guard behavior: candidate.socBest stays pinned to the user anchor;
 * updateSocTracking continues to advance machine.socBest via energy fallback
 * from that anchor as Wh accumulate; DTW still refines band edges (socMin/
 * socMax) via the existing monotonic-narrowing path because we leave those
 * fields untouched.
 *
 * MUTATES candidate IN PLACE — the call site immediately reads candidate.*
 * to commit the band, so a returned copy would not propagate.
 */
export function applyUserAnchorGuard(
  candidate: MatchResult,
  priorMatch: MatchResult | undefined,
  plugId?: string,
): void {
  if (priorMatch?.bandConfidence === 1 && priorMatch.socBest != null) {
    candidate.socBest = priorMatch.socBest;
    candidate.estimatedStartSoc = priorMatch.socBest;
    candidate.bandConfidence = 1;
    console.log(
      `[user-anchor] preserved socBest=${priorMatch.socBest} across FPD-02 refresh${plugId ? ` for plug ${plugId}` : ''}`,
    );
  }
}

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
  // Phase 11 SOC confidence band, forward-propagated per reading.
  // Narrows ONLY on new tryMatch results (monotonic) and on override (collapse
  // to zero-width); Wh accumulation translates the band forward without
  // changing its width.
  private sessionSocMin = new Map<string, number>();
  private sessionSocMax = new Map<string, number>();
  private sessionBandConfidence = new Map<string, number>();
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

  // --- Anomaly detection ---
  // Cached reference curve points for the active match, in offset order.
  private anomalyCurve = new Map<string, Array<{ offsetSeconds: number; apower: number }>>();
  // Consecutive readings outside the deviation band — reset on every in-band
  // reading so brief spikes don't trigger a notification.
  private anomalyDeviationCount = new Map<string, number>();
  // Last anomaly notification per plug; we cool down for ANOMALY_COOLDOWN_MS.
  private anomalyNotifiedAt = new Map<string, number>();

  // FPD-01 stale-power watchdog. The state machine fires
  // transition('aborted', { reason: 'stale_power' }) and onTransition runs
  // synchronously inside feedReading; we stash the reason here so the
  // subsequent handleTransition('aborted') (which runs right after
  // feedReading returns in handlePowerReading) can route to the watchdog
  // abort path AND so captureEventContext can detect kind='fired'.
  // Persists until cleanupSession runs at end of the abort branch.
  private lastStopReason = new Map<string, string>();
  // FPD-02 adaptive matcher refresh. chargingBuffers caches per-plug apower
  // readings + the ProfileWithCurve picked up by tryMatch — refreshMatch
  // re-runs findBestCandidate against this in-memory ring every
  // matcherRefreshReadings readings WITHOUT a per-refresh DB round-trip.
  // Cleared by cleanupSession. readingsSinceLastMatch is the counter.
  // RESEARCH §FPD-02 Q3 + Pitfall 14: in-memory beats DB query (~138 KB / 24h).
  private chargingBuffers = new Map<string, { apower: number[]; profile: ProfileWithCurve }>();
  // v1.5 taper-aware SoC. Cached reference-curve points per session for the
  // taper-region apower→offset lookup. Lazy-loaded on the first
  // updateSocTracking call after match, cleared in cleanupSession.
  private taperCurvePoints = new Map<string, TaperCurvePoint[]>();

  // v1.6.2 active-learning prompt. Track when the current detection cycle
  // started (set on transition to 'detecting', cleared on commit /
  // cleanupSession) and whether we've already sent the Pushover prompt
  // (one per session — don't spam). When detection has been running for
  // more than AMBIGUITY_PROMPT_THRESHOLD_MS without a commit, fire a
  // Pushover with the top candidate profiles. The user opens the dashboard
  // and resolves manually via the existing PUT override path.
  private detectionStartedAt = new Map<string, number>();
  private ambiguityPromptSentAt = new Map<string, number>();
  private readingsSinceLastMatch = new Map<string, number>();
  // FPD-03 last-stop-mode surface. Written synchronously BEFORE the
  // handleStopping invocation (so captureEventContext's snapshot reads the
  // fresh value) — either in handleTransition('stopping') for normal band-mode
  // stops, OR before machine.forceStop('energy_fallback') in handlePowerReading
  // for the low-confidence dispatch. Cleared by cleanupSession.
  private lastStopMode = new Map<string, 'aggressive' | 'conservative' | 'energy_fallback'>();
  // Per-plug stash for the transition data parameter set by ChargeStateMachine.
  // Cleared by handleTransition once consumed.
  private pendingTransitionData = new Map<string, unknown>();

  private powerHandler: ((reading: PowerReading) => void) | null = null;
  private transientHandler: ((event: PlugTransientEvent) => void) | null = null;
  // v1.7-B per-plug latest captured plug-in transient features. Lifetime
  // mirrors detectionBuffers: populated by the eventBus transient
  // subscription, read in tryMatch, cleared on cleanupSession.
  private sessionTransientFeatures = new Map<string, TransientFeatures>();

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

    // v1.7-B subscribe to transient features. HttpPollingService emits one
    // PlugTransientEvent per (plug, plug-in-edge) once the 30 s burst
    // closes. Stash the features in `sessionTransientFeatures` so the next
    // tryMatch consults them as a multiplicative confidence boost in the
    // layered matcher.
    this.transientHandler = (event: PlugTransientEvent) => {
      this.sessionTransientFeatures.set(event.plugId, event.features);
    };
    this.eventBus.on('transient:*', this.transientHandler);

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
    if (this.transientHandler) {
      this.eventBus.removeListener('transient:*', this.transientHandler);
      this.transientHandler = null;
    }
    this.machines.clear();
    this.detectionBuffers.clear();
    this.sessionWh.clear();
    this.sessionTransientFeatures.clear();
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
            // Synthetic MatchResult from a user profile-override has no
            // matcher-derived band — collapse to a zero-width band at the
            // current estimatedSoc. The next tryMatch run can re-derive.
            socMin: machine.estimatedSoc,
            socMax: machine.estimatedSoc,
            socBest: machine.estimatedSoc,
            bandConfidence: 1,
          });
        }
      }
    }

    if (opts.estimatedSoc !== undefined) {
      // Capture predictedSoc + chargedWh BEFORE we mutate anything so the
      // calibration log gets the matcher's actual estimate at the moment
      // of correction (not the user-supplied target).
      const predictedSoc = machine.estimatedSoc;
      const chargedWhAtCorrection = this.sessionWh.get(targetPlugId) ?? 0;
      const profileIdForLog = this.matchData.get(targetPlugId)?.profileId ?? opts.profileId;
      if (profileIdForLog != null) {
        try {
          logSocCorrection({
            profileId: profileIdForLog,
            sessionId,
            predictedSoc,
            correctedSoc: opts.estimatedSoc,
            chargedWhAtCorrection,
          });
        } catch (err) {
          console.error('[Calibration] logSocCorrection failed:', err instanceof Error ? err.message : err);
        }
      }

      // Rebase the SOC math baseline (socBaselineEnergy) to the current plug
      // totalEnergy so the next reading computes currentWh-for-soc ≈ 0 and
      // updateSocTracking tracks forward from the user's value. The SEPARATE
      // sessionStartEnergy / sessionWh stay anchored at session creation and
      // keep the "Wh geladen" display stable across corrections.
      machine.estimatedSoc = opts.estimatedSoc;
      // Collapse the band to zero-width at the user-supplied value. The
      // matcher's plausible-offset set is no longer the source of truth — the
      // user just told us the actual SOC. Next tryMatch run may re-widen.
      machine.socMin = opts.estimatedSoc;
      machine.socMax = opts.estimatedSoc;
      machine.socBest = opts.estimatedSoc;
      machine.socBandConfidence = 1;
      this.sessionSocMin.set(targetPlugId, opts.estimatedSoc);
      this.sessionSocMax.set(targetPlugId, opts.estimatedSoc);
      this.sessionBandConfidence.set(targetPlugId, 1);

      const existingMatch = this.matchData.get(targetPlugId);
      if (existingMatch) {
        existingMatch.estimatedStartSoc = opts.estimatedSoc;
        existingMatch.socMin = opts.estimatedSoc;
        existingMatch.socMax = opts.estimatedSoc;
        existingMatch.socBest = opts.estimatedSoc;
        existingMatch.bandConfidence = 1;
      }

      const oldBaseline = this.socBaselineEnergy.get(targetPlugId);
      const sessionStart = this.sessionStartEnergy.get(targetPlugId);
      const totalConsumed = this.sessionWh.get(targetPlugId) ?? 0;
      if (oldBaseline !== undefined && sessionStart !== undefined) {
        // New baseline = session start + all consumption so far
        this.socBaselineEnergy.set(targetPlugId, sessionStart + totalConsumed);
      }

      db.update(chargeSessions)
        .set({
          estimatedSoc: opts.estimatedSoc,
          socMin: opts.estimatedSoc,
          socMax: opts.estimatedSoc,
          bandConfidence: 1,
        })
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

    // Cut power BEFORE state cleanup. Earlier path left the relay 'on' because
    // handleTransition('aborted') intentionally no-ops for user_abort (DB row
    // already written above) and the relay-off pathway only lives inside
    // handleStopping / the stale_power|timeout arm. Session 19 incident
    // 2026-05-15: POST /abort returned ok:true while plug 192.168.3.135 kept
    // delivering 38W. Fire-and-forget mirrors the learn_complete / stale_power
    // arms — same canSwitchRelay throttle, same non-fatal catch.
    const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
    if (plug && plug.ipAddress && canSwitchRelay(this.lastRelayOff.get(plugId) ?? 0)) {
      switchRelayOff(
        { id: plug.id, ipAddress: plug.ipAddress, channel: plug.channel ?? 0 },
        this.eventBus,
      ).then((ok) => {
        if (ok) this.lastRelayOff.set(plugId, Date.now());
      }).catch(() => { /* non-fatal */ });
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

    // FPD-03 low-confidence energy-fallback gate. Runs BEFORE feedReading so
    // the band-mode shouldStop never gets a chance to fire on an untrusted
    // band. Ordering invariant (Pitfall 5): low-confidence gate runs FIRST.
    //
    // Note: machine.estimatedSoc is read one-reading-stale at this dispatch
    // point because updateSocTracking runs AFTER feedReading. Acceptable per
    // design — band-mode dispatch inside shouldStop has the same property.
    if (
      (prevState === 'charging' || prevState === 'countdown') &&
      machine.socBandConfidence < readLowConfidenceThreshold() &&
      machine.targetSoc > 0 &&
      // Warm-up gate — mirror the state-machine's MIN_CHARGING_READINGS gate
      // so the FPD-03 energy-fallback path can't fire before FPD-02 has had
      // a chance to refresh the initial DTW match. Without this, a wrong
      // initial profile match whose energy_fallback estimatedSoc already
      // crosses target (Session 20: Winbot @ socBest=83 on real iPad) would
      // bypass the warm-up via the FPD-03 short-circuit.
      machine.chargingReadingCount >= MIN_CHARGING_READINGS_FOR_STOP &&
      shouldStopEnergyFallback({
        estimatedSoc: machine.estimatedSoc,
        targetSoc: machine.targetSoc,
      })
    ) {
      // PLAN-CHECK H6: write lastStopMode BEFORE forceStop, so the
      // synchronous handleTransition('stopping') → handleStopping →
      // captureEventContext snapshot reads the fresh 'energy_fallback' value.
      this.lastStopMode.set(plugId, 'energy_fallback');
      machine.forceStop('energy_fallback');
      // PLAN-CHECK H1: handleTransition fires synchronously via onTransition
      // inside forceStop (already wired through getOrCreateMachine's
      // onTransition handler — see below). The state-comparison dispatch
      // (prevState !== newState) at the end of this method would re-fire
      // handleTransition; to avoid double-dispatching the 'stopping' case,
      // run it directly here and EARLY RETURN. feedReading must NOT be called
      // on this reading — the recycle gate at charge-state-machine.ts:76-85
      // would otherwise reset 'stopping' → 'idle' before relay-off runs.
      this.handleTransition(plugId, prevState, machine.state, reading);
      return;
    }

    machine.feedReading(apower, timestamp);

    // FPD-04 max-session-duration watchdog. Wall-clock based (Date.now() vs
    // sessionStartedAt) — UNLIKE FPD-01 which is reading-based. RESEARCH
    // Pitfall 10: this is the absolute last-line-of-defense; a session that
    // survived 24h is by definition pathological. If the watchdog just fired,
    // bail out early so the natural prevState!==newState dispatch routes the
    // 'aborted' transition through handleTransition (reason='timeout').
    if (this.checkSessionTimeout(plugId)) {
      this.handleTransition(plugId, prevState, machine.state, reading);
      return;
    }

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

      // Run matching every MATCH_INTERVAL_READINGS once we have enough
      // samples to attempt one. tryMatch() commits only if the result's
      // confidence meets the phase-appropriate threshold; otherwise it
      // updates this.matchData with the best speculative candidate so
      // the UI can show "vermutlich iPad Pro (78%)" while still detecting.
      if (
        buffer.length >= MIN_MATCH_READINGS &&
        buffer.length % MATCH_INTERVAL_READINGS === 0
      ) {
        this.tryMatch(plugId, buffer, timestamp);
      }

      // Push a progress event on every reading during detection so the UI
      // shows a live counter. emitChargeEvent already includes the latest
      // speculative best-candidate via the matchData map.
      if (machine.state === 'detecting') {
        this.emitChargeEvent(plugId, 'detecting');
      }

      // Once detection exhausts buffer without commit, emit with detectionExhausted
      // flag so UI switches from progress to UnknownDeviceDialog.
      if (buffer.length >= MAX_DETECTION_READINGS && machine.state === 'detecting') {
        this.emitChargeEvent(plugId, 'detecting', true);
      }

      // v1.6.2 active-learning prompt. If detection has been running > 5 min
      // without a commit AND we haven't already prompted this session, fire
      // one Pushover with the top candidates. The user resolves via the
      // dashboard's PUT-override path (same flow as the manual /override
      // smoke-test from yesterday's iPad UAT).
      const startedAt = this.detectionStartedAt.get(plugId);
      if (
        machine.state === 'detecting' &&
        startedAt !== undefined &&
        timestamp - startedAt >= AMBIGUITY_PROMPT_THRESHOLD_MS &&
        !this.ambiguityPromptSentAt.has(plugId)
      ) {
        this.fireAmbiguousDetectionPrompt(plugId, buffer);
        this.ambiguityPromptSentAt.set(plugId, timestamp);
      }
    }

    // Handle state transitions
    if (prevState !== newState) {
      this.handleTransition(plugId, prevState, newState, reading);
    }

    // During charging/countdown, update SOC tracking + anomaly detection
    if (newState === 'charging' || newState === 'countdown') {
      this.updateSocTracking(plugId, reading);
      this.checkAnomaly(plugId, reading);
    }
  }

  /**
   * Compare live apower against the matched reference curve. After
   * ANOMALY_SUSTAINED_READINGS consecutive deviations beyond
   * ANOMALY_DEVIATION_PCT, fire a Pushover notification. Cooldown
   * prevents repeated notifications for a single anomaly run.
   */
  private checkAnomaly(plugId: string, reading: PowerReading): void {
    const curve = this.anomalyCurve.get(plugId);
    const match = this.matchData.get(plugId);
    const sessionStartedAt = this.sessionStartedAt.get(plugId);
    if (!curve || curve.length === 0 || !match || sessionStartedAt === undefined) return;

    const offsetSeconds = Math.floor((reading.timestamp - sessionStartedAt) / 1000) + match.curveOffsetSeconds;
    const expected = this.lookupCurvePower(curve, offsetSeconds);
    if (expected === null || expected < ANOMALY_MIN_EXPECTED_W) {
      // Outside curve range or expected ~0 → reset, no signal
      this.anomalyDeviationCount.set(plugId, 0);
      return;
    }

    const deviation = Math.abs(reading.apower - expected) / expected;
    const out = deviation > ANOMALY_DEVIATION_PCT;
    const count = (this.anomalyDeviationCount.get(plugId) ?? 0) + (out ? 1 : -1);
    this.anomalyDeviationCount.set(plugId, Math.max(0, Math.min(count, ANOMALY_SUSTAINED_READINGS + 5)));

    if ((this.anomalyDeviationCount.get(plugId) ?? 0) < ANOMALY_SUSTAINED_READINGS) return;

    const lastNotified = this.anomalyNotifiedAt.get(plugId) ?? 0;
    if (Date.now() - lastNotified < ANOMALY_COOLDOWN_MS) return;
    this.anomalyNotifiedAt.set(plugId, Date.now());

    this.fireAnomalyNotification(plugId, match.profileName, reading.apower, expected);
  }

  private lookupCurvePower(
    curve: Array<{ offsetSeconds: number; apower: number }>,
    targetSeconds: number,
  ): number | null {
    if (curve.length === 0) return null;
    if (targetSeconds <= curve[0].offsetSeconds) return curve[0].apower;
    if (targetSeconds >= curve[curve.length - 1].offsetSeconds) return null;
    // Binary-search-ish lookup for the bracketing pair.
    let lo = 0;
    let hi = curve.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (curve[mid].offsetSeconds <= targetSeconds) lo = mid;
      else hi = mid;
    }
    const a = curve[lo];
    const b = curve[hi];
    const span = b.offsetSeconds - a.offsetSeconds;
    if (span === 0) return a.apower;
    const t = (targetSeconds - a.offsetSeconds) / span;
    return a.apower + (b.apower - a.apower) * t;
  }

  private fireAnomalyNotification(plugId: string, profileName: string, actual: number, expected: number): void {
    const userKeyRow = db.select().from(config).where(eq(config.key, 'pushover.userKey')).get();
    const tokenRow = db.select().from(config).where(eq(config.key, 'pushover.apiToken')).get();
    if (!userKeyRow?.value || !tokenRow?.value) return;

    const direction = actual > expected ? 'höher' : 'niedriger';
    const deltaPct = Math.round(Math.abs(actual - expected) / expected * 100);
    const title = `Lade-Anomalie: ${profileName}`;
    const baseMessage =
      `Live-Power ${actual.toFixed(0)} W liegt ${deltaPct} % ${direction} als die Referenzkurve erwartet (${expected.toFixed(0)} W). ` +
      `Mögliche Ursachen: Zell-Alterung, Charger-Defekt, falsche Profil-Erkennung. Plug bleibt aktiv — bitte prüfen.`;

    // Phase 11-03 SOCB-05: attach the rendered ASCII band when the plug's
    // session Maps carry one. Pushover ASCII-mode glyphs (Pitfall 3 — lock
    // screen rendering can mangle Unicode box-drawing chars).
    const socMin = this.sessionSocMin.get(plugId);
    const socMax = this.sessionSocMax.get(plugId);
    const machine = this.machines.get(plugId);
    const hasBand = socMin !== undefined && socMax !== undefined && machine !== undefined;
    let message = baseMessage;
    let monospace: '1' | undefined;
    if (hasBand) {
      const bar = renderSocBandAscii({
        socMin: socMin!,
        socMax: socMax!,
        socBest: machine!.socBest,
        targetSoc: machine!.targetSoc,
        mode: 'pushover',
      });
      message = `${baseMessage}\n${bar}`;
      monospace = '1';
    }

    const body: Record<string, string> = {
      token: tokenRow.value,
      user: userKeyRow.value,
      title,
      message,
      priority: '1',
    };
    if (monospace) body.monospace = monospace;

    fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }).catch(() => { /* non-fatal */ });
  }

  /**
   * v1.6.2 active-learning Pushover prompt. Fires once per detecting cycle
   * after AMBIGUITY_PROMPT_THRESHOLD_MS without a clean commit. Lists the
   * top-3 candidate profiles (post-whitelist, post-energy-bound, with
   * Bayesian prior applied) so the user can resolve via the dashboard.
   *
   * Body explicitly does NOT include action URLs — the app is LAN-only and
   * Pushover requires absolute URLs which won't work when the user's phone
   * is on cellular. Plain-text prompt; user opens the dashboard manually.
   */
  private fireAmbiguousDetectionPrompt(plugId: string, buffer: number[]): void {
    const userKeyRow = db.select().from(config).where(eq(config.key, 'pushover.userKey')).get();
    const tokenRow = db.select().from(config).where(eq(config.key, 'pushover.apiToken')).get();
    if (!userKeyRow?.value || !tokenRow?.value) return;

    const plugRow = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
    if (!plugRow) return;

    const profiles = this.loadProfilesWithCurves();
    const whitelistIds = parseAllowedProfileIds(plugRow.allowedProfileIds ?? null);
    const currentSessionWh = this.sessionWh.get(plugId) ?? 0;
    const profileMaxEnergyWh = new Map<number, number>();
    for (const p of profiles) profileMaxEnergyWh.set(p.id, p.curve.totalEnergyWh);
    const candidateIds = (whitelistIds ?? profiles.map((p) => p.id)).filter((id) => {
      const max = profileMaxEnergyWh.get(id);
      return max === undefined || !isEnergyImpossible(currentSessionWh, max);
    });
    if (candidateIds.length === 0) return;
    const prior = getPlugProfilePrior(db, plugId, candidateIds);

    // Get ranked candidates (uses the same posterior logic the matcher does).
    const ranked = curveMatcher.findMatchWithMarginAndPrior(buffer, profiles, {
      whitelistIds: candidateIds,
      prior,
      profileMaxEnergyWh,
      currentSessionWh,
      confidenceThreshold: 0,
      marginRatio: 0,
    });
    if (!ranked.match) return;

    // Look up the top-3 names by profile ID (the ranked.match is just the
    // winner; we want the others too for the prompt).
    const candidates = candidateIds
      .map((id) => profiles.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .slice(0, 3);

    const title = `Erkennung unsicher: ${plugRow.name}`;
    const lines = [
      `Der Plug "${plugRow.name}" lädt seit 5+ Minuten ohne dass ein eindeutiges Profil erkannt wurde.`,
      ``,
      `Mögliche Kandidaten:`,
      ...candidates.map((p) => `• ${p.name}`),
      ``,
      `Bitte am Dashboard das richtige Profil auswählen, damit Auto-Stop bei ${plugRow.name} korrekt greifen kann.`,
    ];

    const body: Record<string, string> = {
      token: tokenRow.value,
      user: userKeyRow.value,
      title,
      message: lines.join('\n'),
      priority: '0',
    };
    fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }).catch(() => { /* non-fatal */ });
  }

  /**
   * FPD-01 stale-power Pushover anomaly. Mirrors fireAnomalyNotification
   * body shape (same fetch / URLSearchParams / monospace=1 ASCII bar) and
   * only swaps the title + body text. Lock-screen-safe ASCII glyphs via
   * renderSocBandAscii({mode:'pushover'}) — Unicode mangles on some
   * Android lock screens (Phase 11 Pitfall 3).
   */
  private fireStalePowerNotification(plugId: string, profileName: string, secondsAtZero: number): void {
    const userKeyRow = db.select().from(config).where(eq(config.key, 'pushover.userKey')).get();
    const tokenRow = db.select().from(config).where(eq(config.key, 'pushover.apiToken')).get();
    if (!userKeyRow?.value || !tokenRow?.value) return;

    const minutes = Math.max(1, Math.round(secondsAtZero / 60));
    const title = 'Watchdog: Akku voll?';
    const baseMessage =
      `${profileName} zieht seit ${minutes} Min < 1 W. Wahrscheinlich Akku voll oder Charger fertig.\n` +
      `\n` +
      `Plug abgeschaltet (stop_reason=stale_power).`;

    const socMin = this.sessionSocMin.get(plugId);
    const socMax = this.sessionSocMax.get(plugId);
    const machine = this.machines.get(plugId);
    const hasBand = socMin !== undefined && socMax !== undefined && machine !== undefined;
    let message = baseMessage;
    let monospace: '1' | undefined;
    if (hasBand) {
      const bar = renderSocBandAscii({
        socMin: socMin!,
        socMax: socMax!,
        socBest: machine!.socBest,
        targetSoc: machine!.targetSoc,
        mode: 'pushover',
      });
      message = `${baseMessage}\n\n${bar}`;
      monospace = '1';
    }

    const body: Record<string, string> = {
      token: tokenRow.value,
      user: userKeyRow.value,
      title,
      message,
      priority: '1',
    };
    if (monospace) body.monospace = monospace;

    fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }).catch(() => { /* non-fatal */ });
  }

  /**
   * FPD-04 max-session-duration watchdog. Wall-clock based (Date.now() -
   * sessionStartedAt) per RESEARCH Pitfall 10 — UNLIKE FPD-01's reading-based
   * counter. Rationale: this is the absolute last-line-of-defense; the cap
   * must fire even when polling has stopped entirely. Returns true if the
   * watchdog fired this call (caller MUST early-return so handleTransition
   * dispatches the 'aborted' transition before any post-feedReading
   * bookkeeping runs).
   *
   * Only arms in active states (detecting/matched/charging/countdown). Idle /
   * stopping / aborted / etc. are out of scope — those sessions are already
   * in some terminal/transient state and would either self-recycle or have
   * been cleared by cleanupSession.
   */
  private checkSessionTimeout(plugId: string): boolean {
    const startedAt = this.sessionStartedAt.get(plugId);
    if (startedAt === undefined) return false;
    const machine = this.machines.get(plugId);
    if (!machine) return false;
    const activeStates: ChargeState[] = ['detecting', 'matched', 'charging', 'countdown'];
    if (!activeStates.includes(machine.state)) return false;
    const maxMs = readMaxSessionHours() * 3_600_000;
    if (Date.now() - startedAt < maxMs) return false;
    machine.forceTimeout();
    return true;
  }

  /**
   * FPD-04 max-session-duration Pushover anomaly. Mirrors
   * fireStalePowerNotification verbatim (same fetch / URLSearchParams /
   * monospace=1 ASCII bar) and only swaps the title + body text.
   */
  private fireTimeoutNotification(plugId: string, profileName: string, hoursActive: number): void {
    const userKeyRow = db.select().from(config).where(eq(config.key, 'pushover.userKey')).get();
    const tokenRow = db.select().from(config).where(eq(config.key, 'pushover.apiToken')).get();
    if (!userKeyRow?.value || !tokenRow?.value) return;

    const title = 'Watchdog: Session-Timeout';
    const baseMessage =
      `${profileName} läuft seit ${hoursActive} h. Max-Session-Dauer überschritten (config.charging.maxSessionHours).\n` +
      `\n` +
      `Plug abgeschaltet (stop_reason=timeout). Falls absichtlich: maxSessionHours in /settings erhöhen.`;

    const socMin = this.sessionSocMin.get(plugId);
    const socMax = this.sessionSocMax.get(plugId);
    const machine = this.machines.get(plugId);
    const hasBand = socMin !== undefined && socMax !== undefined && machine !== undefined;
    let message = baseMessage;
    let monospace: '1' | undefined;
    if (hasBand) {
      const bar = renderSocBandAscii({
        socMin: socMin!,
        socMax: socMax!,
        socBest: machine!.socBest,
        targetSoc: machine!.targetSoc,
        mode: 'pushover',
      });
      message = `${baseMessage}\n\n${bar}`;
      monospace = '1';
    }

    const body: Record<string, string> = {
      token: tokenRow.value,
      user: userKeyRow.value,
      title,
      message,
      priority: '1',
    };
    if (monospace) body.monospace = monospace;

    fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }).catch(() => { /* non-fatal */ });
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
        this.detectionStartedAt.set(plugId, now);
        this.ambiguityPromptSentAt.delete(plugId);
        this.emitChargeEvent(plugId, 'detecting');

        // v1.6 single-profile-whitelist shortcut. When a plug's
        // allowed_profile_ids is a JSON array of length 1, treat it as a
        // hard pin and bypass DTW entirely. Multi-profile whitelists fall
        // through to the regular detection flow, where tryMatch consults
        // the same whitelist + Bayesian prior to narrow candidates.
        const plugRow = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
        const allowed = parseAllowedProfileIds(plugRow?.allowedProfileIds ?? null);
        if (allowed && allowed.length === 1) {
          this.commitPinnedMatch(plugId, allowed[0], reading.timestamp);
        }
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
        // FPD-02: initialize the adaptive-refresh buffer with the cached
        // ProfileWithCurve so refreshMatch doesn't re-query the DB every 60
        // readings. loadProfilesWithCurves() is the one place that joins
        // device_profiles + reference_curves + reference_curve_points; we
        // call it ONCE here and stash the matched profile on the buffer.
        const storedMatch = this.matchData.get(plugId);
        if (storedMatch) {
          const profiles = this.loadProfilesWithCurves();
          const matchedProfile = profiles.find((p) => p.id === storedMatch.profileId);
          if (matchedProfile) {
            this.chargingBuffers.set(plugId, { apower: [], profile: matchedProfile });
            this.readingsSinceLastMatch.set(plugId, 0);
          } else {
            console.warn('[refreshMatch] missing profile for plugId', plugId);
          }
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
        // PLAN-CHECK H6: write lastStopMode BEFORE handleStopping runs. The
        // synchronous captureEventContext snapshot inside handleStopping reads
        // this Map; without the pre-write, complete events emit
        // stopMode=undefined for the high-confidence aggressive/conservative
        // path. The low-confidence energy_fallback path already wrote the Map
        // before forceStop() — this branch handles the band-mode paths whose
        // forcing is via machine.handleCharging → transition('stopping').
        // Idempotent for the energy_fallback case: if the Map already holds
        // 'energy_fallback', leave it alone (do NOT overwrite with
        // machine.stopMode which is restricted to 'aggressive'|'conservative').
        if (this.lastStopMode.get(plugId) !== 'energy_fallback') {
          this.lastStopMode.set(plugId, machine.stopMode);
        }
        // Emit the 'stopping' transition synchronously so SSE clients
        // (and tests) see the stopMode tag immediately — handleStopping's
        // 'complete' emit is post-await and not visible until the relay-off
        // promise resolves on the microtask queue.
        this.emitChargeEvent(plugId, 'stopping');
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
            { id: plug.id, ipAddress: plug.ipAddress, channel: plug.channel ?? 0 },
            this.eventBus
          ).then((ok) => {
            if (ok) this.lastRelayOff.set(plugId, Date.now());
          }).catch(() => { /* non-fatal */ });
        }

        this.emitChargeEvent(plugId, 'learn_complete');
        break;
      }

      case 'aborted': {
        // Watchdog abort dispatch. State machine fired transition('aborted',
        // { reason }) and the data parameter was stashed in
        // pendingTransitionData. Type-narrow it — tampering protection per
        // threat T-12-01 (12-01) + T-12-08 (12-03). Currently produced
        // reasons: 'stale_power' (FPD-01), 'timeout' (FPD-04). The default
        // arm is intentionally INERT — abortSession (user_abort) writes the
        // DB directly and bypasses handleTransition entirely; a defensive
        // write here would double-write or overwrite the user_abort row
        // (PLAN-CHECK H3 resolution).
        const raw = this.pendingTransitionData.get(plugId);
        this.pendingTransitionData.delete(plugId);
        const reason =
          raw && typeof raw === 'object' && 'reason' in raw
            ? String((raw as { reason: unknown }).reason)
            : null;
        if (reason !== 'stale_power' && reason !== 'timeout') {
          // Unknown reason — log and bail. abortSession (user-driven) writes
          // its own DB row directly with stopReason='user_abort' and never
          // routes through handleTransition.
          console.warn('[handleTransition] unexpected aborted reason', {
            plugId,
            reason,
          });
          break;
        }

        // Snapshot context BEFORE any await — same discipline as
        // handleStopping (2640873 bug class). cleanupSession() runs at the
        // end of this branch and will clear the per-plug Maps; the snapshot
        // preserves the band fields + watchdog 'fired' kind for the emit.
        // lastStopReason is set BEFORE captureEventContext so the snapshot
        // reads the fresh value (only matters for the 'stale_power' path
        // which populates watchdogKind='fired').
        this.lastStopReason.set(plugId, reason);
        const abortCtx = this.captureEventContext(plugId);
        const sessionId = abortCtx.sessionId;
        const profileName = abortCtx.match?.profileName ?? 'Unbekanntes Profil';

        // Pushover anomaly fires FIRST so the user is notified even if the
        // DB / relay step has a race. Body shape mirrors fireAnomalyNotification;
        // only the title + body template differs per reason.
        if (reason === 'stale_power') {
          const secondsAtZero = readStalePowerWindowSec();
          this.fireStalePowerNotification(plugId, profileName, secondsAtZero);
        } else {
          // 'timeout' — derive hours-active from sessionStartedAt for the
          // notification body. captureEventContext snapshot preserves
          // startedAt past the cleanupSession that follows the emit.
          const startedAt = abortCtx.startedAt;
          const hoursActive = startedAt !== undefined
            ? Math.max(1, Math.round((Date.now() - startedAt) / 3_600_000))
            : readMaxSessionHours();
          this.fireTimeoutNotification(plugId, profileName, hoursActive);
        }

        // DB write: state='aborted', stopReason=reason.
        if (sessionId) {
          db.update(chargeSessions).set({
            state: 'aborted',
            stoppedAt: Date.now(),
            stopReason: reason,
          }).where(eq(chargeSessions.id, sessionId)).run();

          // v1.7-C — stale-power aborts are usually "device finished charging"
          // (apower drops to 0 because BMS taper-stopped). Their delivered
          // Wh is excellent ground truth — score it.
          if (reason === 'stale_power') {
            try {
              const match = this.matchData.get(plugId);
              const deliveredWh = this.sessionWh.get(plugId) ?? 0;
              runPostCycleCalibration(db, sessionId, plugId, match?.profileId ?? null, deliveredWh);
            } catch (err) {
              console.error('[post-cycle-calibration] failed:', err instanceof Error ? err.message : err);
            }
          }
        }

        // Relay off — mirrors the learn_complete fire-and-forget pattern.
        const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
        if (plug && plug.ipAddress && canSwitchRelay(this.lastRelayOff.get(plugId) ?? 0)) {
          switchRelayOff(
            { id: plug.id, ipAddress: plug.ipAddress, channel: plug.channel ?? 0 },
            this.eventBus
          ).then((ok) => {
            if (ok) this.lastRelayOff.set(plugId, Date.now());
          }).catch(() => { /* non-fatal */ });
        }

        this.emitChargeEvent(plugId, 'aborted', false, abortCtx);
        this.cleanupSession(plugId);
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

    // v1.6 — gather the three layered gates BEFORE running DTW so the
    // speculative-best snapshot we publish to the UI is computed over the
    // narrowed candidate set, not the full catalogue. Layers: (1) plug
    // whitelist, (2) Bayesian per-plug prior, (3) energy-bound elimination.
    const plugRow = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
    const whitelistIds = parseAllowedProfileIds(plugRow?.allowedProfileIds ?? null);
    const currentSessionWh = this.sessionWh.get(plugId) ?? 0;
    const profileMaxEnergyWh = new Map<number, number>();
    for (const p of profiles) profileMaxEnergyWh.set(p.id, p.curve.totalEnergyWh);
    const candidateIds = (whitelistIds ?? profiles.map((p) => p.id)).filter((id) => {
      const max = profileMaxEnergyWh.get(id);
      return max === undefined || !isEnergyImpossible(currentSessionWh, max);
    });
    const prior = getPlugProfilePrior(db, plugId, candidateIds);

    // v1.7-B transient features blend. If a plug-in transient was captured
    // during the first 30 s of charging, extract per-profile reference
    // transient features and merge them into the per-candidate prior. The
    // similarity score becomes a multiplicative boost on top of the
    // Bayesian prior — clean stacking, no special-case branching.
    const observedTransient = this.sessionTransientFeatures.get(plugId);
    let priorWithTransient = prior;
    if (observedTransient) {
      const transientBoosted = new Map<number, number>();
      let scaleSum = 0;
      const boosts = new Map<number, number>();
      for (const id of candidateIds) {
        const profile = profiles.find((p) => p.id === id);
        if (!profile) continue;
        const refFirst30s: TransientFeatures = extractTransientFeatures(
          profile.curvePoints
            .filter((p) => p.offsetSeconds <= 30)
            .map((p) => ({ ts: p.offsetSeconds * 1000, apower: p.apower })),
        );
        const similarity = compareTransientFeatures(observedTransient, refFirst30s);
        // Boost = similarity in [0,1]. Final prior contribution =
        // base_prior × boost. Re-normalise so the distribution still sums
        // to 1 (multinomial posterior — well-defined).
        const base = prior.get(id) ?? 1 / Math.max(1, candidateIds.length);
        const blended = base * similarity;
        boosts.set(id, blended);
        scaleSum += blended;
      }
      if (scaleSum > 0) {
        for (const [id, blended] of boosts) {
          transientBoosted.set(id, blended / scaleSum);
        }
        priorWithTransient = transientBoosted;
      }
    }

    const speculative = curveMatcher.findMatchWithMarginAndPrior(buffer, profiles, {
      whitelistIds: candidateIds,
      prior: priorWithTransient,
      profileMaxEnergyWh,
      currentSessionWh,
      confidenceThreshold: 0, // speculative pass — don't gate, just want the best
      marginRatio: 0,
    });
    if (!speculative.match) return; // candidate set is empty (whitelist + energy-bound killed everyone)
    this.matchData.set(plugId, speculative.match);

    const threshold = thresholdForBufferSize(buffer.length);
    const gated = curveMatcher.findMatchWithMarginAndPrior(buffer, profiles, {
      whitelistIds: candidateIds,
      prior: priorWithTransient,
      profileMaxEnergyWh,
      currentSessionWh,
      confidenceThreshold: threshold,
    });
    if (!gated.match) return; // keep accumulating
    // The candidate that passed the gates IS the speculative match by
    // construction (same call, same ranking) — bind it as the canonical
    // `candidate` reference downstream code paths use.
    const candidate = gated.match;

    // Confidence cleared the phase threshold → commit.
    const matchedProfile = profiles.find((p) => p.id === candidate.profileId);
    if (matchedProfile) {
      this.anomalyCurve.set(plugId, matchedProfile.curvePoints.map((p) => ({
        offsetSeconds: p.offsetSeconds,
        apower: p.apower,
      })));
      this.anomalyDeviationCount.set(plugId, 0);
    }
    const machine = this.machines.get(plugId);
    const sessionId = this.sessionIds.get(plugId);
    if (!machine || !sessionId) return;

    // Apply learned start-SOC bias from past corrections of this profile.
    // Median of recent (corrected − predicted) deltas, clipped ±15.
    let biasedStartSoc = candidate.estimatedStartSoc;
    let biasApplied = 0;
    try {
      const bias = getStartSocBias(candidate.profileId);
      if (bias !== 0) {
        biasedStartSoc = Math.max(0, Math.min(100, candidate.estimatedStartSoc + bias));
        biasApplied = bias;
      }
    } catch (err) {
      console.error('[Calibration] getStartSocBias failed:', err instanceof Error ? err.message : err);
    }
    if (biasedStartSoc !== candidate.estimatedStartSoc) {
      candidate.estimatedStartSoc = biasedStartSoc;
      console.log(`[Calibration] applied start-SOC bias ${biasApplied >= 0 ? '+' : ''}${biasApplied} for profile ${candidate.profileId} → estimatedStartSoc=${biasedStartSoc}`);
    }

    // v1.7-D: Honor user anchor across FPD-02 adaptive refresh.
    // See applyUserAnchorGuard for rationale + Session 23 incident details.
    applyUserAnchorGuard(candidate, this.matchData.get(plugId), plugId);

    // Commit the band to the per-plug Maps. Monotonic narrowing (Pitfall 1):
    // if a prior band exists for this plug, never widen — take max of socMin
    // and min of socMax. Override is the only path that widens (sets band to
    // zero-width at the user-supplied value).
    const candidateSocMin = candidate.socMin ?? candidate.estimatedStartSoc;
    const candidateSocMax = candidate.socMax ?? candidate.estimatedStartSoc;
    const candidateSocBest = candidate.socBest ?? candidate.estimatedStartSoc;
    const candidateBandConfidence = candidate.bandConfidence ?? 1;
    const priorSocMin = this.sessionSocMin.get(plugId);
    const priorSocMax = this.sessionSocMax.get(plugId);
    const newSocMin = priorSocMin !== undefined
      ? Math.max(priorSocMin, candidateSocMin)
      : candidateSocMin;
    const newSocMax = priorSocMax !== undefined
      ? Math.min(priorSocMax, candidateSocMax)
      : candidateSocMax;
    this.sessionSocMin.set(plugId, newSocMin);
    this.sessionSocMax.set(plugId, newSocMax);
    this.sessionBandConfidence.set(plugId, candidateBandConfidence);
    // Sync the band onto the state-machine instance immediately so the next
    // handleCharging's shouldStop sees fresh values.
    machine.socMin = newSocMin;
    machine.socMax = newSocMax;
    machine.socBest = candidateSocBest;
    machine.socBandConfidence = candidateBandConfidence;

    machine.setMatch(candidate, sessionId, Date.now());

    // Persist match to DB directly — handleTransition('detecting','matched')
    // is skipped because setMatch mutates state synchronously from inside
    // handlePowerReading after newState was already captured. Without this
    // write, profile_id / target_soc / detection_confidence never land in
    // the DB, and resume-after-restart loses the match entirely.
    const profile = db.select().from(deviceProfiles)
      .where(eq(deviceProfiles.id, candidate.profileId)).get();
    if (profile) {
      machine.targetSoc = profile.targetSoc;
    }
    db.update(chargeSessions).set({
      state: 'matched',
      profileId: candidate.profileId,
      detectionConfidence: candidate.confidence,
      curveOffsetSeconds: candidate.curveOffsetSeconds,
      targetSoc: machine.targetSoc,
      estimatedSoc: candidate.estimatedStartSoc,
    }).where(eq(chargeSessions.id, sessionId)).run();

    this.emitChargeEvent(plugId, 'matched');
  }

  /**
   * v1.5 plug pinning. Commit a synthetic match against `pinnedProfileId`
   * with no DTW — the plug owner has guaranteed the device. Band starts
   * fully uncertain ([0, 100], bandConfidence=0) so FPD-03's low-confidence
   * gate routes every stop predicate through the energy-fallback path
   * (estSoc grows with delivered Wh, stop fires at estSoc≥targetSoc). The
   * user can refine via PUT /api/charging/sessions/<id> if they know the
   * starting real SoC. Mirrors the commit half of tryMatch — sessionId
   * lookup, anomalyCurve setup, matchData write, DB UPDATE.
   */
  private commitPinnedMatch(plugId: string, pinnedProfileId: number, timestamp: number): void {
    const sessionId = this.sessionIds.get(plugId);
    const machine = this.machines.get(plugId);
    if (!sessionId || !machine) return;

    const profile = db.select().from(deviceProfiles).where(eq(deviceProfiles.id, pinnedProfileId)).get();
    if (!profile) return;

    const profilesWithCurves = this.loadProfilesWithCurves();
    const matchedProfile = profilesWithCurves.find((p) => p.id === pinnedProfileId);
    if (!matchedProfile) return;

    this.anomalyCurve.set(plugId, matchedProfile.curvePoints.map((p) => ({
      offsetSeconds: p.offsetSeconds,
      apower: p.apower,
    })));
    this.anomalyDeviationCount.set(plugId, 0);

    const syntheticMatch: MatchResult = {
      profileId: profile.id,
      profileName: profile.name,
      confidence: 1.0,        // user-pinned ≡ ground truth from the plug owner
      curveOffsetSeconds: 0,
      estimatedStartSoc: 0,
      socMin: 0,
      socMax: 100,
      socBest: 0,
      bandConfidence: 0,      // fully uncertain → FPD-03 fallback path
    };
    this.matchData.set(plugId, syntheticMatch);

    this.sessionSocMin.set(plugId, 0);
    this.sessionSocMax.set(plugId, 100);
    this.sessionBandConfidence.set(plugId, 0);
    machine.socMin = 0;
    machine.socMax = 100;
    machine.socBest = 0;
    machine.socBandConfidence = 0;
    machine.targetSoc = profile.targetSoc;

    machine.setMatch(syntheticMatch, sessionId, timestamp);

    db.update(chargeSessions).set({
      state: 'matched',
      profileId: profile.id,
      detectionConfidence: 1.0,
      curveOffsetSeconds: 0,
      targetSoc: machine.targetSoc,
      estimatedSoc: 0,
    }).where(eq(chargeSessions.id, sessionId)).run();

    this.emitChargeEvent(plugId, 'matched');
  }

  /**
   * On session complete, try to refit the charger efficiency from this
   * session's data. Only fires when an early correction (chargedWh below
   * the EARLY_CORRECTION_WH_THRESHOLD in calibration.ts) gave us a clean
   * start-SOC anchor — otherwise we'd treat matcher-guessed start-SOC as
   * ground truth and bake the matcher's bias into eta.
   */
  private recalibrateChargerEtaIfPossible(plugId: string, sessionId: number): void {
    const machine = this.machines.get(plugId);
    const match = this.matchData.get(plugId);
    if (!machine || !match) return;

    const anchor = getEarlyCorrection(sessionId);
    if (!anchor) return;

    const acWh = this.sessionWh.get(plugId) ?? 0;
    if (acWh <= 0) return;

    // The correction snapshot: at moment X (chargedWh ≈ small), real SOC
    // was correctedSoc. From X to session end, AC consumption =
    // (totalSessionWh − chargedWhAtCorrection). Final SOC = machine.estimatedSoc
    // (which on complete equals machine.targetSoc, modulo last-reading drift).
    const acWhSinceAnchor = Math.max(0, acWh - anchor.chargedWhAtCorrection);
    if (acWhSinceAnchor <= 0) return;

    const result = recalibrateEta({
      profileId: match.profileId,
      startSoc: anchor.correctedSoc,
      endSoc: machine.estimatedSoc,
      acWh: acWhSinceAnchor,
    });

    if (result.applied && result.oldEta != null && result.newEta != null) {
      const delta = result.newEta - result.oldEta;
      console.log(
        `[Calibration] eta refit for profile ${match.profileId}: ` +
        `${result.oldEta.toFixed(3)} → ${result.newEta.toFixed(3)} ` +
        `(${delta >= 0 ? '+' : ''}${delta.toFixed(3)}, anchor SOC=${anchor.correctedSoc}, ` +
        `ΔSOC=${machine.estimatedSoc - anchor.correctedSoc}, AC Wh=${acWhSinceAnchor.toFixed(1)})`
      );
    } else if (!result.applied) {
      console.log(`[Calibration] eta refit skipped: ${result.reason}`);
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

    // v1.5 taper-aware SoC. When live apower is below the taper threshold
    // (default 70% of peakPower), prefer curve-position lookup over pure
    // energy-fallback math. Session 22 (2026-05-15) overshot real SoC by
    // ~15% because the iPad's BMS started tapering at ~80% real while the
    // energy math kept treating each Wh as if the BMS were still in CC.
    // Curve points are lazy-loaded once per session via taperCurvePoints
    // (cached after first taper-region entry).
    let curvePointsForTaper = this.taperCurvePoints.get(plugId);
    if (!curvePointsForTaper) {
      const points = db.select().from(referenceCurvePoints)
        .where(eq(referenceCurvePoints.curveId, curve.id)).all();
      curvePointsForTaper = points.map((p) => ({ offsetSeconds: p.offsetSeconds, apower: p.apower }));
      this.taperCurvePoints.set(plugId, curvePointsForTaper);
    }
    const taperResult = estimateSocTaperAware({
      apower: reading.apower,
      peakPower: curve.peakPower,
      currentWh: socWh,
      totalWh: curve.totalEnergyWh,
      startSoc: match.estimatedStartSoc,
      curvePoints: curvePointsForTaper,
      totalDurationSeconds: curve.durationSeconds,
    });
    const soc = taperResult.soc;
    machine.estimatedSoc = soc;

    // Forward-propagate the band edges in lock-step with socBest (Pattern 2,
    // RESEARCH.md). Width stays constant during Wh accumulation; the band
    // only narrows on new tryMatch runs (which already wrote the Maps in
    // tryMatch above) or on override (collapse to zero-width).
    const bandSocBestAnchor = match.socBest ?? match.estimatedStartSoc;
    const bandSocMinAnchor = match.socMin ?? bandSocBestAnchor;
    const bandSocMaxAnchor = match.socMax ?? bandSocBestAnchor;
    const socBestNew = estimateSoc(socWh, curve.totalEnergyWh, bandSocBestAnchor);
    const socMinNew = estimateSoc(socWh, curve.totalEnergyWh, bandSocMinAnchor);
    const socMaxNew = estimateSoc(socWh, curve.totalEnergyWh, bandSocMaxAnchor);
    this.sessionSocMin.set(plugId, socMinNew);
    this.sessionSocMax.set(plugId, socMaxNew);
    if (!this.sessionBandConfidence.has(plugId)) {
      this.sessionBandConfidence.set(plugId, match.bandConfidence ?? 1);
    }
    machine.socBest = socBestNew;
    machine.socMin = socMinNew;
    machine.socMax = socMaxNew;

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

    // Update session in DB — also persist the band fields landed in the
    // Maps above so resume-after-restart reconstructs the correct band.
    const sessionId = this.sessionIds.get(plugId);
    if (sessionId) {
      db.update(chargeSessions).set({
        estimatedSoc: soc,
        energyWh: sessionWh,
        socMin: socMinNew,
        socMax: socMaxNew,
        bandConfidence: this.sessionBandConfidence.get(plugId) ?? null,
      }).where(eq(chargeSessions.id, sessionId)).run();
    }

    // FPD-02: adaptive matcher refresh. Append apower to the per-plug buffer
    // and re-run findBestCandidate every matcherRefreshReadings readings
    // (default 60 ≈ 5 min at 5s polling). Buffer init lives in
    // handleTransition('charging'); buffer growth + DB-side cost is bounded
    // (~138 KB / 24h). refreshMatch awaits nothing in the hot path — it's
    // declared async only because it logs / writes DB on the accepted-narrow
    // branch.
    const buffer = this.chargingBuffers.get(plugId);
    if (buffer) {
      buffer.apower.push(reading.apower);
      const counter = (this.readingsSinceLastMatch.get(plugId) ?? 0) + 1;
      const refreshEvery = readMatcherRefreshReadings();
      if (counter >= refreshEvery) {
        this.readingsSinceLastMatch.set(plugId, 0);
        // Fire-and-forget: refreshMatch is async only for the DB write +
        // emitChargeEvent path, never blocks the polling tick. Errors are
        // logged inside the method (matcher failures are non-fatal).
        void this.refreshMatch(plugId, reading.timestamp);
      } else {
        this.readingsSinceLastMatch.set(plugId, counter);
      }
    }

    this.emitChargeEvent(plugId, machine.state);
  }

  /**
   * FPD-02 adaptive matcher refresh. Re-runs findBestCandidate against the
   * accumulated chargingBuffer with the cached ProfileWithCurve. The
   * returned MatchResult is gated by INLINE monotonic narrowing (Math.max /
   * Math.min) — DO NOT extract a helper; the existing tryMatch clamp at
   * lines ~870-880 handles the prior-undefined fallback, and two-site
   * duplication of 4 LOC is safer than a refactor that risks drift between
   * the two phases (PLAN-CHECK H4).
   *
   * Two-argument call only — findBestCandidate has no third opts arg
   * (signature at curve-matcher.ts:141-144). The band threshold is the
   * compile-time DEFAULT_BAND_THRESHOLD_PCT baked into deriveBand
   * (curve-matcher.ts:172) — the v1.3.1-tuned 0.20 value already used by
   * initial-match; adaptive refresh respects the same threshold by design
   * (PLAN-CHECK B1).
   */
  private async refreshMatch(plugId: string, _timestamp: number): Promise<void> {
    const entry = this.chargingBuffers.get(plugId);
    if (!entry || entry.apower.length === 0) return;

    const candidate = curveMatcher.findBestCandidate(entry.apower, [entry.profile]);
    if (!candidate) return;

    // v1.7-E: honor user anchor on the recurring-refresh path too. v1.7-D
    // covered tryMatch (initial commit) but missed this site — diagnosed on
    // Session 25 (2026-05-19): user injected real-SoC, charge proceeded
    // correctly, then the 5-min FPD-02 refreshMatch tick overwrote
    // machine.socBest at line below with the raw DTW candidate (≈ live
    // taper-region offset), pulling socBest BACK below target. shouldStop
    // then re-armed and the charge ran past the intended cutoff. Same
    // guard, same MatchResult-mutation contract.
    applyUserAnchorGuard(candidate, this.matchData.get(plugId), plugId);

    const priorSocMin = this.sessionSocMin.get(plugId);
    const priorSocMax = this.sessionSocMax.get(plugId);
    // refreshMatch only runs after handleTransition('charging') which seeds
    // the band Maps via the matched-transition path (or override). If the
    // Maps are unexpectedly empty, bail — we have no prior to narrow against.
    if (priorSocMin === undefined || priorSocMax === undefined) return;

    // PLAN-CHECK H4 INLINE monotonic narrowing (NOT a helper). Math.max /
    // Math.min independently clamp each edge — the band can ONLY narrow.
    // This is the SAFETY property: a single widening edge in the candidate is
    // silently held at the prior cached value; if both edges widen, both are
    // held and the cached band is preserved. No explicit reject-and-bail is
    // needed because the clamp IS the rejection. (Mirrors the existing
    // tryMatch clamp at the matched-commit site lines ~869-880; two-site 4-LOC
    // duplication is acceptable per PLAN-CHECK H4.)
    const newSocMin = Math.max(priorSocMin, candidate.socMin);
    const newSocMax = Math.min(priorSocMax, candidate.socMax);
    if (candidate.socMin < priorSocMin || candidate.socMax > priorSocMax) {
      console.debug('[refreshMatch] widening candidate clamped to prior band', {
        plugId,
        prior: { socMin: priorSocMin, socMax: priorSocMax },
        candidate: { socMin: candidate.socMin, socMax: candidate.socMax },
        clamped: { socMin: newSocMin, socMax: newSocMax },
      });
    }

    this.sessionSocMin.set(plugId, newSocMin);
    this.sessionSocMax.set(plugId, newSocMax);
    this.sessionBandConfidence.set(plugId, candidate.bandConfidence);

    const machine = this.machines.get(plugId);
    if (machine) {
      machine.socMin = newSocMin;
      machine.socMax = newSocMax;
      machine.socBest = candidate.socBest;
      machine.socBandConfidence = candidate.bandConfidence;
    }

    // Sync the cached MatchResult so updateSocTracking's band propagation
    // anchors on the narrowed values on the next tick.
    const cachedMatch = this.matchData.get(plugId);
    if (cachedMatch) {
      cachedMatch.socMin = newSocMin;
      cachedMatch.socMax = newSocMax;
      cachedMatch.socBest = candidate.socBest;
      cachedMatch.bandConfidence = candidate.bandConfidence;
    }

    // Persist refreshed band; mirrors the updateSocTracking DB write path.
    const sessionId = this.sessionIds.get(plugId);
    if (sessionId) {
      db.update(chargeSessions).set({
        socMin: newSocMin,
        socMax: newSocMax,
        bandConfidence: candidate.bandConfidence,
      }).where(eq(chargeSessions.id, sessionId)).run();
    }

    // OQ-5 resolved: emit the same 'charging' event tag — SocBandIndicator's
    // CSS transition animates the change without needing a new 'rematch' kind.
    this.emitChargeEvent(plugId, 'charging');
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

    // Snapshot event context BEFORE the await. switchRelayOff resolves on the
    // next power reading via waitForPowerDrop, and that reading's feedReading()
    // hits the recycle gate (stopping→idle), which resets machine.estimatedSoc
    // to 0 and fires handleTransition(idle) → cleanupSession() that clears
    // matchData/sessionIds before we get back here. Without the snapshot, the
    // post-await 'complete' event would emit profileName=undefined and
    // estimatedSoc=0, producing a "Akku voll: Akku -> 0% erreicht." Pushover.
    const completionCtx = this.captureEventContext(plugId);
    const sessionId = completionCtx.sessionId;

    const success = await switchRelayOff(
      { id: plug.id, ipAddress: plug.ipAddress, channel: plug.channel ?? 0 },
      this.eventBus
    );

    if (success) {
      this.lastRelayOff.set(plugId, Date.now());
      if (sessionId) {
        db.update(chargeSessions).set({
          state: 'complete',
          stoppedAt: Date.now(),
          stopReason: 'target_soc_reached',
        }).where(eq(chargeSessions.id, sessionId)).run();

        // Eta recalibration: only when an early correction (chargedWh
        // small) gave us a clean ground-truth start-SOC anchor. Without
        // that, computing eta from a matcher-guessed start would just
        // bake the matcher's bias into the charger efficiency.
        try {
          this.recalibrateChargerEtaIfPossible(plugId, sessionId);
        } catch (err) {
          console.error('[Calibration] recalibrateChargerEta failed:', err instanceof Error ? err.message : err);
        }

        // v1.7-C post-cycle self-calibration. Score delivered Wh against
        // the committed profile + plug whitelist; verify or flag for review.
        try {
          const match = this.matchData.get(plugId);
          const deliveredWh = this.sessionWh.get(plugId) ?? 0;
          runPostCycleCalibration(db, sessionId, plugId, match?.profileId ?? null, deliveredWh);
        } catch (err) {
          console.error('[post-cycle-calibration] failed:', err instanceof Error ? err.message : err);
        }
      }
      this.emitChargeEvent(plugId, 'complete', false, completionCtx);
      this.cleanupSession(plugId);
    } else {
      if (sessionId) {
        db.update(chargeSessions).set({
          state: 'error',
          stoppedAt: Date.now(),
          stopReason: 'relay_switch_failed',
        }).where(eq(chargeSessions.id, sessionId)).run();
      }
      this.emitChargeEvent(plugId, 'error', false, completionCtx);
    }
  }

  /**
   * Snapshot the per-plug state that emitChargeEvent reads, so callers
   * spanning an async boundary can preserve event context across the
   * state-machine recycle gate (which resets estimatedSoc) and the
   * idle-transition cleanupSession() (which drops matchData/sessionIds).
   * Without this snapshot, the post-await 'complete' event emits
   * profileName=undefined and estimatedSoc=0, producing the bogus
   * "Akku voll: Akku -> 0% erreicht." Pushover message.
   */
  private captureEventContext(plugId: string): {
    match: MatchResult | undefined;
    estimatedSoc: number | undefined;
    targetSoc: number | undefined;
    sessionId: number | undefined;
    startedAt: number | undefined;
    etaSeconds: number | undefined;
    sessionWh: number | undefined;
    energyRemainingWh: number | undefined;
    // Phase 11 band — captured here so the post-await 'complete' event
    // (handleStopping → switchRelayOff await → cleanupSession clears the
    // Maps) still emits a populated band. Same bug class as 2640873; that
    // commit fixed estimatedSoc, this snapshot fixes the band fields too.
    socMin: number | undefined;
    socMax: number | undefined;
    socBandConfidence: number | undefined;
    socAsciiBar: string | undefined;
    // Phase 12 FPD-01 stale-power watchdog. Read synchronously from
    // machine.stalePowerCount (single source of truth) and lastStopReason
    // Map (cleared at cleanupSession). 'fired' wins over 'warning' so
    // post-abort events carry the correct kind.
    watchdogKind: 'none' | 'warning' | 'fired' | undefined;
    stalePowerSeconds: number | undefined;
    stalePowerFiresAt: number | undefined;
    // FPD-03 stop-mode surface — populated synchronously BEFORE any await so
    // handleStopping's post-relay-off emitChargeEvent('complete') still carries
    // the right mode. Set by handleTransition('stopping') for band-mode stops,
    // OR by handlePowerReading's energy-fallback dispatch BEFORE forceStop.
    stopMode: 'aggressive' | 'conservative' | 'energy_fallback' | undefined;
  } {
    const machine = this.machines.get(plugId);
    const socMin = this.sessionSocMin.get(plugId);
    const socMax = this.sessionSocMax.get(plugId);
    // Phase 11-03 W1 (closed): render the bar at SNAPSHOT time so the post-await
    // 'complete' event carries a non-empty bar string for the SSE/dashboard
    // payload. The snapshot must precede the relay-off await — otherwise
    // cleanupSession() clears the Maps and the dashboard sees socAsciiBar=undefined
    // even though the user's Pushover already received the rendered bar (same
    // 2640873 bug class as the original estimatedSoc snapshot fix).
    //
    // Unicode mode here: this string feeds the SSE / dashboard / server log.
    // The Pushover-mode bar is rendered separately inside
    // NotificationService.buildCompleteMessage (lock-screen safety).
    const socAsciiBar = socMin !== undefined && socMax !== undefined && machine !== undefined
      ? renderSocBandAscii({
          socMin,
          socMax,
          socBest: machine.socBest,
          targetSoc: machine.targetSoc,
          mode: 'unicode',
          width: 80,
        })
      : undefined;

    // FPD-01 watchdog snapshot. Read machine.stalePowerCount directly (single
    // source of truth). 'fired' takes precedence — it persists post-abort
    // via lastStopReason until cleanupSession runs. 20% of window — see
    // CONTEXT design-decision (relative warning so a 120s custom window
    // gets a 24s warning, not the hardcoded 60s).
    const stalePowerCount = machine?.stalePowerCount ?? 0;
    const stalePowerSeconds = stalePowerCount * 5;
    const windowSec = readStalePowerWindowSec();
    const firedNow = this.lastStopReason.get(plugId) === 'stale_power';
    let watchdogKind: 'none' | 'warning' | 'fired';
    let stalePowerFiresAt: number | undefined;
    if (firedNow) {
      watchdogKind = 'fired';
    } else if (stalePowerSeconds === 0) {
      watchdogKind = 'none';
    } else if (stalePowerSeconds >= 0.20 * windowSec) {
      watchdogKind = 'warning';
      stalePowerFiresAt = Date.now() + (windowSec - stalePowerSeconds) * 1000;
    } else {
      watchdogKind = 'none';
    }

    return {
      match: this.matchData.get(plugId),
      estimatedSoc: machine?.estimatedSoc,
      targetSoc: machine?.targetSoc,
      sessionId: this.sessionIds.get(plugId),
      startedAt: this.sessionStartedAt.get(plugId),
      etaSeconds: this.sessionEtaSeconds.get(plugId),
      sessionWh: this.sessionWh.get(plugId),
      energyRemainingWh: this.sessionEnergyRemainingWh.get(plugId),
      socMin,
      socMax,
      socBandConfidence: this.sessionBandConfidence.get(plugId),
      socAsciiBar,
      watchdogKind,
      stalePowerSeconds,
      stalePowerFiresAt,
      stopMode: this.lastStopMode.get(plugId),
    };
  }

  private emitChargeEvent(
    plugId: string,
    state: ChargeState,
    detectionExhausted = false,
    ctx?: ReturnType<typeof this.captureEventContext>
  ): void {
    const effective = ctx ?? this.captureEventContext(plugId);
    const {
      match,
      estimatedSoc,
      targetSoc,
      sessionId,
      startedAt,
      etaSeconds,
      sessionWh,
      energyRemainingWh,
      socMin,
      socMax,
      socBandConfidence,
      socAsciiBar,
      watchdogKind,
      stalePowerSeconds,
      stalePowerFiresAt,
      stopMode,
    } = effective;

    // During detection the matchData entry is a speculative candidate, not
    // a committed match — it must not surface as profileName (the UI would
    // render it as if the device had been identified). Promote it to the
    // dedicated bestCandidate* fields instead. Once we transition to
    // 'matched' or beyond, the committed match is exposed normally.
    const isDetecting = state === 'detecting';
    const buffer = this.detectionBuffers.get(plugId);

    const event: ChargeStateEvent = {
      plugId,
      state,
      profileId: isDetecting ? undefined : match?.profileId,
      profileName: isDetecting ? undefined : match?.profileName,
      confidence: isDetecting ? undefined : match?.confidence,
      estimatedSoc,
      targetSoc,
      sessionId,
      detectionExhausted,
      elapsedMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
      etaSeconds,
      energyChargedWh: sessionWh,
      energyRemainingWh,
      // Detection-progress fields. Only meaningful while state==='detecting'.
      detectionSamples: isDetecting ? (buffer?.length ?? 0) : undefined,
      detectionTargetSamples: isDetecting ? DETECTION_TARGET_READINGS : undefined,
      bestCandidateProfileId: isDetecting ? match?.profileId : undefined,
      bestCandidateName: isDetecting ? match?.profileName : undefined,
      bestCandidateConfidence: isDetecting ? match?.confidence : undefined,
      socMin,
      socMax,
      socBandConfidence,
      socAsciiBar,
      watchdogKind,
      stalePowerSeconds,
      stalePowerFiresAt,
      stopMode,
    };

    this.eventBus.emitChargeState(event);
  }

  private getOrCreateMachine(plugId: string): ChargeStateMachine {
    let machine = this.machines.get(plugId);
    if (!machine) {
      machine = new ChargeStateMachine();
      // Transitions are dispatched in handlePowerReading via state comparison
      // (prevState vs newState). The data parameter — set by the state
      // machine on transition('aborted', { reason: 'stale_power' }) — is
      // stashed in pendingTransitionData so handleTransition can read it.
      // Synchronous: onTransition fires inside feedReading, handleTransition
      // runs right after feedReading returns in the same tick.
      machine.onTransition = (_from, _to, data) => {
        if (data !== undefined) {
          this.pendingTransitionData.set(plugId, data);
        }
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
    this.sessionSocMin.delete(plugId);
    this.sessionSocMax.delete(plugId);
    this.sessionBandConfidence.delete(plugId);
    this.anomalyCurve.delete(plugId);
    this.anomalyDeviationCount.delete(plugId);
    this.anomalyNotifiedAt.delete(plugId);
    this.lastStopReason.delete(plugId);
    this.pendingTransitionData.delete(plugId);
    // FPD-02
    this.chargingBuffers.delete(plugId);
    this.readingsSinceLastMatch.delete(plugId);
    // FPD-03
    this.lastStopMode.delete(plugId);
    // v1.5 taper-aware SoC
    this.taperCurvePoints.delete(plugId);
    // v1.6.2 active-learning
    this.detectionStartedAt.delete(plugId);
    this.ambiguityPromptSentAt.delete(plugId);
    // v1.7-B plug-in transient features
    this.sessionTransientFeatures.delete(plugId);
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
              // Plan 11-02 Task 3b: read socMin / socMax / bandConfidence
              // from the DB row. Legacy rows (created before migration 0009)
              // have NULL columns — degrade to a zero-width band at the
              // saved estimatedSoc.
              const fallbackSoc = session.estimatedSoc ?? 0;
              const resumedSocMin = session.socMin ?? fallbackSoc;
              const resumedSocMax = session.socMax ?? fallbackSoc;
              const resumedBandConfidence = session.bandConfidence ?? 1;
              const match: MatchResult = {
                profileId: profile.id,
                profileName: profile.name,
                confidence: session.detectionConfidence ?? 1,
                curveOffsetSeconds: session.curveOffsetSeconds ?? 0,
                estimatedStartSoc: fallbackSoc,
                socMin: resumedSocMin,
                socMax: resumedSocMax,
                socBest: fallbackSoc,
                bandConfidence: resumedBandConfidence,
              };
              this.matchData.set(session.plugId, match);
              // Seed the band Maps so updateSocTracking's first call after
              // resume reads the correct anchors. Sync onto the state-machine
              // instance so shouldStop reads correct values immediately.
              this.sessionSocMin.set(session.plugId, resumedSocMin);
              this.sessionSocMax.set(session.plugId, resumedSocMax);
              this.sessionBandConfidence.set(session.plugId, resumedBandConfidence);
              machine.socMin = resumedSocMin;
              machine.socMax = resumedSocMax;
              machine.socBest = fallbackSoc;
              machine.socBandConfidence = resumedBandConfidence;
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
