// Shared types for the self-update subsystem.
// Shape locked by .planning/phases/07-version-foundation-state-persistence/07-CONTEXT.md

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'installing'
  | 'rolled_back'
  | 'failed';

export type LastCheckResult = 'up_to_date' | 'available' | 'error';

export type UpdateState = {
  /** Full SHA that is currently running (from CURRENT_SHA at boot). */
  currentSha: string;
  /** Full SHA to rollback to if an update fails. `null` on fresh install. */
  rollbackSha: string | null;
  /** Epoch ms of the last GitHub check. `null` if never checked. */
  lastCheckAt: number | null;
  /** ETag from the last GitHub /commits/main response, for `If-None-Match`. */
  lastCheckEtag: string | null;
  lastCheckResult: LastCheckResult | null;
  updateStatus: UpdateStatus;
  /** `true` when the most recent run ended in an auto-rollback. UI reads this to show the red banner. */
  rollbackHappened: boolean;
  rollbackReason: string | null;
};

export const DEFAULT_UPDATE_STATE: Omit<UpdateState, 'currentSha'> = {
  rollbackSha: null,
  lastCheckAt: null,
  lastCheckEtag: null,
  lastCheckResult: null,
  updateStatus: 'idle',
  rollbackHappened: false,
  rollbackReason: null,
};
