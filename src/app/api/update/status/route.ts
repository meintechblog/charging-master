// src/app/api/update/status/route.ts
// Pure read of UpdateInfoView. No side effects, no GitHub calls.
// Used by the Settings page (plan 08-02) to render the banner on every load.
// Designed to be sub-50ms: sync read of state.json + pure view derivation.

import { UpdateStateStore } from '@/modules/self-update/update-state-store';
import { CURRENT_SHA, CURRENT_SHA_SHORT } from '@/lib/version';
import type { UpdateInfoView } from '@/modules/self-update/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readInfoSafely(): UpdateInfoView {
  try {
    return new UpdateStateStore().getUpdateInfo();
  } catch (err) {
    // State file missing or corrupt. Return a minimal degraded view so the
    // Settings page still renders (with a 'never checked' label) instead of
    // showing a generic 500 error screen. The banner in plan 08-02 treats
    // lastCheckStatus === 'never' as the fallback.
    console.warn(
      `[GET /api/update/status] failed to read update state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      currentSha: CURRENT_SHA,
      currentShaShort: CURRENT_SHA_SHORT,
      lastCheckAt: null,
      lastCheckStatus: 'never',
      updateAvailable: false,
    };
  }
}

export function GET(): Response {
  const body = readInfoSafely();
  return Response.json(body, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
