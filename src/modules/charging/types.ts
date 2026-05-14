/**
 * Shared types for the charging intelligence domain.
 */

export type ChargeState =
  | 'idle'
  | 'detecting'
  | 'matched'
  | 'charging'
  | 'countdown'
  | 'stopping'
  | 'complete'
  | 'aborted'
  | 'learning'
  | 'learn_complete'
  | 'error';

export interface MatchResult {
  profileId: number;
  profileName: string;
  confidence: number;
  curveOffsetSeconds: number;
  estimatedStartSoc: number;
  // Phase 11 SOCB-01 confidence band. Tightened from OPTIONAL (Plan 11-01)
  // to REQUIRED in Plan 11-02 Task 3a, after every producer in
  // charge-monitor.ts (tryMatch, overrideSession, resumeActiveSessions,
  // in-place mutation site) was wired to populate the fields.
  // estimatedStartSoc remains the back-compat alias for socBest.
  socMin: number;
  socMax: number;
  socBest: number;
  bandConfidence: number;
}

export interface SocBoundary {
  soc: number;
  offsetSeconds: number;
  cumulativeWh: number;
}

export interface ChargeSessionData {
  sessionId: number;
  plugId: string;
  state: ChargeState;
  profileId?: number;
  profileName?: string;
  confidence?: number;
  estimatedSoc?: number;
  targetSoc?: number;
  energyWh?: number;
  startedAt: number;
}

export interface ChargeStateEvent {
  plugId: string;
  state: ChargeState;
  profileId?: number;
  profileName?: string;
  confidence?: number;
  estimatedSoc?: number;
  targetSoc?: number;
  sessionId?: number;
  // True once detection buffer hit MAX_DETECTION_READINGS without a match.
  // UI uses this to distinguish "still detecting" from "detection failed".
  detectionExhausted?: boolean;
  // Milliseconds since session.startedAt (wall-clock elapsed charging time).
  elapsedMs?: number;
  // Estimated seconds until estimatedSoc reaches targetSoc at current draw.
  // Only populated during charging/countdown with a matched profile.
  etaSeconds?: number;
  // Wh consumed in the current session so far.
  energyChargedWh?: number;
  // Wh still needed to reach targetSoc from current estimated SOC.
  energyRemainingWh?: number;
  // --- Detection-phase progress (only set while state === 'detecting') ---
  // Readings collected so far for the active detection buffer.
  detectionSamples?: number;
  // Total readings the buffer can hold before MAX_DETECTION_READINGS forces
  // detection-exhausted. Lets the UI render a progress fraction.
  detectionTargetSamples?: number;
  // Best speculative match the curve-matcher found at the latest probe.
  // Confidence may be below the commit threshold — this is informational
  // only and may flip to a different candidate as more samples arrive.
  bestCandidateProfileId?: number;
  bestCandidateName?: string;
  bestCandidateConfidence?: number;
  // Phase 11 SOC confidence band. socAsciiBar is populated by Plan 11-03's
  // notification-side renderer; declared here so 11-02 types compile while
  // the field stays undefined on the wire. All optional — legacy SSE
  // snapshot synthesizers (the /api/sse/power on-connect emit) don't need
  // to set them.
  socMin?: number;
  socMax?: number;
  socBandConfidence?: number;
  socAsciiBar?: string;
}
