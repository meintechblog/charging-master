import { UpdateStateStore } from '@/modules/self-update/update-state-store';
import { db } from '@/db/client';
import { updateRuns } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Localhost-only allowlist. Deliberately NARROWER than the browser-facing
// host-guard (`src/lib/host-guard.ts` permits `charging-master.local`) — this
// endpoint is the SSH-from-LXC emergency recovery path, and admitting
// `charging-master.local` would let any LAN-attached browser (or its tabs)
// trigger an in-flight update reset. The Host header is the entire auth story
// (single-user LAN deployment, no forwarded-client headers honored).
//
// Mirrors the prior-art template at
// `src/app/api/internal/prepare-for-shutdown/route.ts:15` verbatim.
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const;

function isLocalhostHost(request: Request): boolean {
  const raw = request.headers.get('host');
  if (!raw) return false;
  // Strip :port suffix. Handle both `127.0.0.1:80` and `[::1]:80`.
  // Host header is already lowercased by Next.js Headers API.
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return ALLOWED_HOSTS.has(host);
}

/**
 * POST /api/internal/reset-update-state
 *
 * Last-resort emergency recovery for when `.update-state/state.json` is
 * stuck on `updateStatus='installing'` and no other mechanism can clear it
 * (e.g. a crash between `state_set_installing` and the on_error trap before
 * Plan 13-01's idempotent reset shipped, or a future incident class).
 *
 * Caller: an operator with SSH access to the LXC runs
 *
 *   curl -X POST http://localhost/api/internal/reset-update-state
 *
 * After a successful 200, the next `POST /api/update/trigger` is no longer
 * blocked by the 409 "already in progress" guard.
 *
 * Single-purpose: only resets the three in-flight state fields
 * (`updateStatus`, `targetSha`, `updateStartedAt`). Does NOT touch
 * `lastQuarantine`, `rollbackHappened`, `rollbackReason`, `rollbackStage`,
 * `currentSha`, `rollbackSha`, `lastCheckResult`, `lastCheckEtag`, or
 * `lastCheckAt` — the UpdateStateStore spread-merge preserves every field
 * not explicitly patched.
 *
 * NOT exposed in any UI (per Phase 13 CONTEXT.md §PIPE-04 + Design Decision 6).
 * Manual operation only.
 *
 * Concurrency: the operator MUST verify no live updater process before
 * calling (`ps -ef | grep run-update.sh`). The writeAtomic tmp+rename
 * protects against torn writes, but a concurrent bash `state_set_*` call
 * during this endpoint's write is operator error.
 *
 * Audit: every call inserts an `update_runs` row with
 * `status='recovery_reset'` — non-idempotent by design. Same-state re-runs
 * still produce a new audit entry; audit trail > de-dup. The audit row's
 * `fromSha` is the pre-reset `currentSha` (the version that was running
 * when recovery happened), `toSha` is null (nothing rolled forward).
 *
 * The audit insert is best-effort: a DB failure logs to console.warn but
 * does NOT roll back the state reset. The state reset is the load-bearing
 * part — if state.json is fixed but the audit row is missing, the operator
 * can still trigger updates; the reverse leaves the system stuck.
 *
 * Security: Host-header guard only, localhost-only allowlist. See the
 * `ALLOWED_HOSTS` comment above for why this is narrower than the browser
 * host-guard.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isLocalhostHost(request)) {
    return Response.json(
      { error: 'forbidden' },
      { status: 403, headers: NO_CACHE_HEADERS },
    );
  }

  const store = new UpdateStateStore();

  let before;
  try {
    before = store.read();
  } catch (err) {
    return Response.json(
      {
        error: 'state_read_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }

  try {
    store.write({
      updateStatus: 'idle',
      targetSha: null,
      updateStartedAt: null,
    });
  } catch (err) {
    return Response.json(
      {
        error: 'state_write_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }

  try {
    const now = new Date();
    db.insert(updateRuns)
      .values({
        startAt: now,
        endAt: now,
        fromSha: before.currentSha,
        toSha: null,
        status: 'recovery_reset',
        stage: 'recovery',
        errorMessage: 'manual recovery via /api/internal/reset-update-state',
        rollbackStage: null,
      })
      .run();
  } catch (err) {
    console.warn(
      `[POST /api/internal/reset-update-state] audit row insert failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: NO_CACHE_HEADERS },
  );
}
