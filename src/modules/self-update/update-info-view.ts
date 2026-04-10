// src/modules/self-update/update-info-view.ts
// Pure function: UpdateState + current SHAs -> UpdateInfoView.
// No fs, no globals, no imports from @/lib/version — caller provides the SHAs.
// This keeps the function 100% unit-testable and eliminates any build-time
// coupling between the store and the generated version file.

import type { LastCheckResult, UpdateInfoView, UpdateState } from './types';

export function deriveUpdateInfoView(
  state: UpdateState,
  currentSha: string,
  currentShaShort: string,
): UpdateInfoView {
  const result: LastCheckResult | null = state.lastCheckResult;

  // Default view — no check has ever happened.
  const base: UpdateInfoView = {
    currentSha,
    currentShaShort,
    lastCheckAt: state.lastCheckAt,
    lastCheckStatus: 'never',
    updateAvailable: false,
  };

  if (result === null) return base;

  switch (result.status) {
    case 'ok':
      return {
        ...base,
        lastCheckStatus: 'ok',
        updateAvailable: result.remoteSha !== currentSha,
        remote: {
          sha: result.remoteSha,
          shaShort: result.remoteShaShort,
          message: result.message,
          author: result.author,
          date: result.date,
        },
      };
    case 'unchanged':
      // Should not normally be persisted as the authoritative lastCheckResult —
      // UpdateChecker preserves the previous 'ok' result when a 304 arrives.
      // This case only triggers if state.json is hand-edited or a legacy
      // state from an aborted checker run lingers.
      return { ...base, lastCheckStatus: 'unchanged' };
    case 'rate_limited':
      return {
        ...base,
        lastCheckStatus: 'rate_limited',
        rateLimitResetAt: result.resetAt,
        error: 'GitHub Rate-Limit erreicht',
      };
    case 'error':
      return {
        ...base,
        lastCheckStatus: 'error',
        error: result.error,
      };
  }
}
