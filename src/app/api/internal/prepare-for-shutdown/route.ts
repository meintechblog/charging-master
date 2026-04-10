import { sqlite } from '@/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hosts that are allowed to call this endpoint. Production uses 127.0.0.1:80,
// dev uses 127.0.0.1:3000 / localhost:3000. The :port suffix is stripped
// before comparison. IPv6 loopback is accepted for completeness even though
// the updater never hits it.
//
// SECURITY: This guard is the ENTIRE authentication story for this endpoint.
// We do NOT read any forwarded-client headers (not a reverse-proxied
// deployment) because those can be set by any caller. The Host header is
// the only gate.
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Wall-clock hard ceiling: the updater's curl has --max-time 10, so we have
// to respond before that. Drain is ~100ms + checkpoint is <1s on a healthy DB,
// so 10s is generous. We enforce a 5s soft ceiling on the drain itself so a
// stuck fetch cannot block us indefinitely.
const DRAIN_HARD_TIMEOUT_MS = 5_000;

type DrainOk = {
  status: 'drained';
  at: number;
  drainedPages: number;
  pollersStopped: number;
};

type DrainErr =
  | { error: 'forbidden' }
  | { error: 'polling_service_unavailable' }
  | { error: 'drain_timeout' }
  | { error: 'wal_checkpoint_failed'; message: string };

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
 * POST /api/internal/prepare-for-shutdown
 *
 * Called by scripts/update/run-update.sh right before `systemctl stop
 * charging-master` so the app can:
 *   1. Stop every HttpPollingService interval so no new writes hit SQLite.
 *   2. Wait a brief settle window for in-flight Shelly fetches.
 *   3. Run `PRAGMA wal_checkpoint(TRUNCATE)` to force every committed WAL page
 *      into the main .db file, eliminating the P3 (PITFALLS.md) corruption
 *      window during the systemd stop.
 *
 * Mitigates Pitfall 3 (SQLite WAL recovery races) and Pitfall 18 (silent
 * success -- the updater must know the DB is quiescent before stopping).
 *
 * Security: Host-header guard only. Rejects anything that isn't 127.0.0.1 /
 * localhost / ::1. No auth beyond that -- we rely on network segmentation
 * (LAN-only deployment, single-user) + the guard preventing a neighbor LAN
 * device from sending a bogus drain request.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isLocalhostHost(request)) {
    const body: DrainErr = { error: 'forbidden' };
    return Response.json(body, { status: 403, headers: NO_CACHE_HEADERS });
  }

  const httpPollingService = globalThis.__httpPollingService;
  if (!httpPollingService) {
    // Can happen during dev HMR or a half-booted test run. The updater script
    // treats any non-200 as a drain failure and aborts the update.
    const body: DrainErr = { error: 'polling_service_unavailable' };
    return Response.json(body, { status: 500, headers: NO_CACHE_HEADERS });
  }

  // Drain pollers with a hard timeout so a runaway settle cannot block us.
  let pollersStopped: number;
  try {
    pollersStopped = await Promise.race<number>([
      httpPollingService.stopPolling(),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('drain_timeout')), DRAIN_HARD_TIMEOUT_MS),
      ),
    ]);
  } catch {
    const body: DrainErr = { error: 'drain_timeout' };
    return Response.json(body, { status: 500, headers: NO_CACHE_HEADERS });
  }

  // Force WAL -> main DB. better-sqlite3's pragma() returns an array of rows;
  // the first row has { busy, log, checkpointed }. We report `checkpointed`
  // as drainedPages.
  let drainedPages = 0;
  try {
    const rows = sqlite.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    drainedPages = rows[0]?.checkpointed ?? 0;
  } catch (err) {
    const body: DrainErr = {
      error: 'wal_checkpoint_failed',
      message: err instanceof Error ? err.message : String(err),
    };
    return Response.json(body, { status: 500, headers: NO_CACHE_HEADERS });
  }

  const body: DrainOk = {
    status: 'drained',
    at: Date.now(),
    drainedPages,
    pollersStopped,
  };
  return Response.json(body, { status: 200, headers: NO_CACHE_HEADERS });
}
