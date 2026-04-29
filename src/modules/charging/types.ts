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
}
