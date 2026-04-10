// src/app/api/update/trigger/route.ts
// POST /api/update/trigger — fires the charging-master-updater.service via
// systemctl start --no-block, pre-marks state.json so concurrent retries bounce
// with 409, and falls back to a 503 dev_mode response when systemctl or the
// unit file is unavailable on this host.
//
// Satisfies LIVE-01 prereq. Host-header guard is the entire auth story —
// copy-pasted verbatim from /api/internal/prepare-for-shutdown/route.ts so
// the two endpoints share one audited pattern.

import { spawn } from 'node:child_process';
import { UpdateStateStore } from '@/modules/self-update/update-state-store';
import type { UpdateTriggerResponse } from '@/modules/self-update/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' } as const;

function isLocalhostHost(request: Request): boolean {
  const raw = request.headers.get('host');
  if (!raw) return false;
  // Strip :port suffix. Handle both `127.0.0.1:80` and `[::1]:80`.
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return ALLOWED_HOSTS.has(host);
}

/**
 * POST /api/update/trigger
 *
 * Body: optional `{ targetSha?: string }` — if omitted, the endpoint uses the
 * remoteSha from the most recent successful GitHub check.
 *
 * Responses:
 *   202 { status: "triggered", startedAt, targetSha }  — updater launched
 *   400 { status: "error", error: "targetSha unknown" } — no body + no cached remote
 *   403 { status: "error", error: "forbidden" }         — non-localhost Host
 *   409 { status: "error", error: "no update available" }
 *   409 { status: "error", error: "update already running" }
 *   500 { status: "error", error: "state ... failed: ..." }
 *   503 { status: "error", error: "dev_mode: updater service not available on this host" }
 *
 * Security: Host-header guard only. Rejects anything that isn't 127.0.0.1 /
 * localhost / ::1. No auth beyond that -- the LAN-only deployment model
 * combined with the guard is the full threat story (see 10-01-PLAN threat
 * model, T-10-01 / T-10-09 / T-10-10).
 */
export async function POST(request: Request): Promise<Response> {
  // 1) Host guard — 403 for non-localhost
  if (!isLocalhostHost(request)) {
    const body: UpdateTriggerResponse = { status: 'error', error: 'forbidden' };
    return Response.json(body, { status: 403, headers: NO_CACHE });
  }

  // 2) Parse optional body { targetSha?: string }. A missing/empty/invalid
  // body is fine — we derive targetSha from the last check below.
  let targetSha: string | null = null;
  try {
    const body = (await request.json().catch(() => ({}))) as { targetSha?: unknown };
    if (typeof body?.targetSha === 'string') targetSha = body.targetSha;
  } catch {
    /* ignore */
  }

  // 3) Read state — must have an update available and not already running.
  const store = new UpdateStateStore();
  let state;
  try {
    state = store.read();
  } catch (err) {
    const body: UpdateTriggerResponse = {
      status: 'error',
      error: `state read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return Response.json(body, { status: 500, headers: NO_CACHE });
  }

  const updateAvailable =
    state.lastCheckResult?.status === 'ok' &&
    state.lastCheckResult.remoteSha !== state.currentSha;
  if (!updateAvailable) {
    const body: UpdateTriggerResponse = { status: 'error', error: 'no update available' };
    return Response.json(body, { status: 409, headers: NO_CACHE });
  }
  if (state.updateStatus === 'installing') {
    const body: UpdateTriggerResponse = { status: 'error', error: 'update already running' };
    return Response.json(body, { status: 409, headers: NO_CACHE });
  }

  // Derive targetSha if not supplied — fall back to the remote SHA from the
  // last successful check. After the updateAvailable branch above, this must
  // exist, but the type narrowing isn't automatic across the store call.
  if (targetSha === null && state.lastCheckResult?.status === 'ok') {
    targetSha = state.lastCheckResult.remoteSha;
  }
  if (targetSha === null) {
    const body: UpdateTriggerResponse = { status: 'error', error: 'targetSha unknown' };
    return Response.json(body, { status: 400, headers: NO_CACHE });
  }

  // 4) Pre-mark state to 'installing'. A concurrent retry arriving between
  // this write and the spawn call will read the fresh state, see 'installing',
  // and return 409. UpdateStateStore.write() is atomic (tmp + rename) so the
  // window cannot observe a partial file. Mitigates T-10-02.
  const startedAt = Date.now();
  const previousUpdateStatus = state.updateStatus;
  try {
    store.write({ updateStatus: 'installing', targetSha, updateStartedAt: startedAt });
  } catch (err) {
    const body: UpdateTriggerResponse = {
      status: 'error',
      error: `state write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return Response.json(body, { status: 500, headers: NO_CACHE });
  }

  // 5) Fire-and-forget systemctl start. Every flag is load-bearing:
  //    - 'start --no-block' returns immediately (mitigates P1 parent-cgroup kill)
  //    - detached: true spawns into its own process group (extra safety)
  //    - stdio: 'ignore' closes stdin/out/err so the parent can exit cleanly
  //    - .unref() lets the Node event loop exit without waiting for the child
  //
  // On dev machine (macOS, no systemctl): spawn will error with ENOENT, OR
  // systemctl will exit code 4 (unit not found) / exit code 5 (unit not loaded).
  // In both cases, roll back the state write and return 503 with a dev-mode
  // marker so the UI can render a friendly "not available in dev" message.
  try {
    const child = spawn(
      'systemctl',
      ['start', '--no-block', 'charging-master-updater.service'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    // Detect ENOENT and exit=4/5 synchronously. We CANNOT await the child
    // (would defeat --no-block), so we race a 200ms window: on ENOENT the
    // 'error' event fires synchronously, and on a missing unit systemctl
    // exits almost immediately. A real Linux systemctl --no-block call
    // returns in <50ms, so the 200ms window never delays production.
    const spawnError = await new Promise<Error | null>((resolvePromise) => {
      let resolved = false;
      const done = (e: Error | null): void => {
        if (!resolved) {
          resolved = true;
          resolvePromise(e);
        }
      };
      child.once('error', (e) => done(e));
      child.once('exit', (code) => {
        if (code === 4 || code === 5) done(new Error(`systemctl exit ${code}`));
        else done(null);
      });
      setTimeout(() => done(null), 200).unref();
    });

    if (spawnError !== null) {
      // Roll back the state write so the UI doesn't get stuck in 'installing'.
      try {
        store.write({
          updateStatus: previousUpdateStatus,
          targetSha: null,
          updateStartedAt: null,
        });
      } catch {
        /* best effort — the dev_mode response is more important than the rollback */
      }
      const code = (spawnError as NodeJS.ErrnoException).code;
      const isDevMode = code === 'ENOENT' || /exit 4|exit 5/.test(spawnError.message);
      if (isDevMode) {
        const body: UpdateTriggerResponse = {
          status: 'error',
          error: 'dev_mode: updater service not available on this host',
        };
        return Response.json(body, { status: 503, headers: NO_CACHE });
      }
      const body: UpdateTriggerResponse = {
        status: 'error',
        error: `spawn failed: ${spawnError.message}`,
      };
      return Response.json(body, { status: 500, headers: NO_CACHE });
    }
  } catch (err) {
    try {
      store.write({
        updateStatus: previousUpdateStatus,
        targetSha: null,
        updateStartedAt: null,
      });
    } catch {
      /* best effort */
    }
    const body: UpdateTriggerResponse = {
      status: 'error',
      error: `spawn threw: ${err instanceof Error ? err.message : String(err)}`,
    };
    return Response.json(body, { status: 500, headers: NO_CACHE });
  }

  const body: UpdateTriggerResponse = { status: 'triggered', startedAt, targetSha };
  return Response.json(body, { status: 202, headers: NO_CACHE });
}
