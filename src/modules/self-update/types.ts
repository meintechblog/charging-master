// Shared types for the self-update subsystem.
// Shape extended in Phase 8 (08-CONTEXT.md) to replace the simple
// LastCheckResult union with a discriminated union that carries remote-commit
// metadata directly, eliminating the need to thread separate fields through state.

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'installing'
  | 'rolled_back'
  | 'failed';

/**
 * Discriminated result of the most recent GitHub check.
 *
 * - `ok`: 200 OK with a successfully-parsed commit payload. Carries the remote
 *    SHA and commit metadata so the UI can render the banner without another API call.
 * - `unchanged`: 304 Not Modified (ETag matched). Previous remote info is preserved
 *    in lastCheckResult IF the previous status was `ok` — we do NOT overwrite it
 *    with `unchanged` because the banner should keep showing whatever we last saw.
 *    See UpdateChecker.check() for the merge rule.
 * - `rate_limited`: 403/429 with x-ratelimit-reset epoch seconds.
 * - `error`: anything else (timeout, network, 5xx, zod parse failure).
 */
export type LastCheckResult =
  | {
      status: 'ok';
      remoteSha: string;
      remoteShaShort: string;
      message: string;
      author: string;
      date: string; // ISO string from GitHub's commit.author.date
    }
  | { status: 'unchanged' }
  | { status: 'rate_limited'; resetAt: number } // epoch seconds from GitHub
  | { status: 'error'; error: string };

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
  // Phase 10 additions — optional so existing state.json files on disk
  // (written before Phase 10) continue to parse with null defaults.
  /** Target SHA the in-flight update is heading to. Set by the trigger endpoint. */
  targetSha?: string | null;
  /** Epoch ms when the trigger endpoint launched the updater unit. */
  updateStartedAt?: number | null;
  /**
   * Which rollback stage fired (if any). Written by the Phase 9 bash updater
   * on rollback; read-only from Node. `stage1` = git-reset rollback,
   * `stage2` = tarball-restore rollback.
   */
  rollbackStage?: 'stage1' | 'stage2' | null;
};

export const DEFAULT_UPDATE_STATE: Omit<UpdateState, 'currentSha'> = {
  rollbackSha: null,
  lastCheckAt: null,
  lastCheckEtag: null,
  lastCheckResult: null,
  updateStatus: 'idle',
  rollbackHappened: false,
  rollbackReason: null,
  targetSha: null,
  updateStartedAt: null,
  rollbackStage: null,
};

/**
 * Response body from `POST /api/update/trigger`. Discriminated on `status`.
 * On success, the client stores `startedAt` + `targetSha` so it can match the
 * restart handoff (reconnect overlay polls /api/version and compares the SHA).
 */
export type UpdateTriggerResponse =
  | { status: 'triggered'; startedAt: number; targetSha: string }
  | { status: 'error'; error: string };

/**
 * The 9 pipeline stages emitted as `[stage=<name>]` markers by
 * scripts/update/run-update.sh. The UI stage-stepper maps these to visual
 * steps. Order matches the updater's execution sequence.
 */
export type UpdatePipelineStage =
  | 'preflight'
  | 'snapshot'
  | 'drain'
  | 'stop'
  | 'fetch'
  | 'install'
  | 'build'
  | 'start'
  | 'verify';

/**
 * View-model derived from UpdateState + CURRENT_SHA at render time. Returned
 * by `UpdateStateStore.getUpdateInfo()` and shipped to the UI via
 * `GET /api/update/status`. Kept deliberately flat so the UI does not need to
 * discriminate on the union itself.
 *
 * P9 (stale check result) note: `updateAvailable` reflects the state at the
 * time of the last successful GitHub call, NOT the live remote repo. The UI
 * re-reads this on every Settings page load, which is good enough for Phase 8
 * (Phase 10 adds SSE-driven freshness).
 */
export type UpdateInfoView = {
  currentSha: string;
  currentShaShort: string;
  /** Epoch ms of the last check attempt (any outcome). `null` if never checked. */
  lastCheckAt: number | null;
  /** 'never' when lastCheckResult is null; otherwise mirrors lastCheckResult.status. */
  lastCheckStatus: 'never' | 'ok' | 'unchanged' | 'rate_limited' | 'error';
  /** True iff the last successful (`ok`) check returned a remoteSha different from CURRENT_SHA. */
  updateAvailable: boolean;
  /** Populated when the last known-good (`ok`) result carried remote metadata. */
  remote?: {
    sha: string;
    shaShort: string;
    message: string;
    author: string;
    date: string;
  };
  /** Populated when lastCheckStatus === 'error'; human-readable reason. */
  error?: string;
  /** Populated when lastCheckStatus === 'rate_limited'; epoch seconds. */
  rateLimitResetAt?: number;
  // Phase 10 additions — surfaced from UpdateState so the UI can render the
  // red rollback banner (ROLL-06) without a second API call.
  /** True when the most recent update pipeline ended in auto-rollback. */
  rollbackHappened?: boolean;
  /** Human-readable reason for the rollback, if any. */
  rollbackReason?: string | null;
  /** Which rollback stage fired (stage1 = git-reset, stage2 = tarball). */
  rollbackStage?: 'stage1' | 'stage2' | null;
  /**
   * Set when updateStatus === 'installing' — the updater unit is currently
   * running in a sibling systemd process. UI uses this to auto-resume the
   * streaming view if the user navigates away during an update.
   */
  inProgressUpdate?: {
    targetSha: string;
    targetShaShort: string;
    startedAt: number;
  };
};
