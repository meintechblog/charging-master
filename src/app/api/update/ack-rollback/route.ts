// src/app/api/update/ack-rollback/route.ts
// POST /api/update/ack-rollback — clears the three rollback fields in
// state.json so the red "last update failed" banner stops rendering on the
// Settings page. Backs the "Verstanden" button in the Phase 10 UI (ROLL-06).
//
// Security: Host-header guard only, same pattern as prepare-for-shutdown +
// trigger. The endpoint writes ONLY the three rollback fields so a hostile
// caller (bypassing the guard, which requires LAN access) could at worst
// hide a prior failure — see threat model T-10-03 for the accept rationale.

import { UpdateStateStore } from '@/modules/self-update/update-state-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' } as const;

function isLocalhostHost(request: Request): boolean {
  const raw = request.headers.get('host');
  if (!raw) return false;
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return ALLOWED_HOSTS.has(host);
}

type AckResponse = { status: 'acked' } | { error: string };

export async function POST(request: Request): Promise<Response> {
  if (!isLocalhostHost(request)) {
    const body: AckResponse = { error: 'forbidden' };
    return Response.json(body, { status: 403, headers: NO_CACHE });
  }

  try {
    const store = new UpdateStateStore();
    // UpdateStateStore.write() merges via object spread, so all other state
    // fields (currentSha, lastCheckResult, updateStatus, etc.) are preserved.
    store.write({
      rollbackHappened: false,
      rollbackReason: null,
      rollbackStage: null,
    });
  } catch (err) {
    const body: AckResponse = {
      error: `state write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return Response.json(body, { status: 500, headers: NO_CACHE });
  }

  const body: AckResponse = { status: 'acked' };
  return Response.json(body, { status: 200, headers: NO_CACHE });
}
