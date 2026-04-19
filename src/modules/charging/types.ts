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
}
