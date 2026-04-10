import { CURRENT_SHA, CURRENT_SHA_SHORT, BUILD_TIME } from '@/lib/version';
import { sqlite } from '@/db/client';
import { UpdateStateStore } from '@/modules/self-update/update-state-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type VersionResponse = {
  sha: string;
  shaShort: string;
  buildTime: string;
  rollbackSha: string | null;
  dbHealthy: boolean;
};

function probeDb(): boolean {
  try {
    // Synchronous SELECT 1 via better-sqlite3. Wrapped in try/catch so any
    // error (locked DB, missing file, permission issue) downgrades to
    // dbHealthy=false without breaking the endpoint.
    const row = sqlite.prepare('SELECT 1 as ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

function readRollbackSha(): string | null {
  try {
    // The file is guaranteed to exist because server.ts main() called
    // UpdateStateStore.init() before binding the HTTP server. If it is
    // somehow missing (manual deletion mid-run), return null gracefully.
    const store = new UpdateStateStore();
    return store.read().rollbackSha;
  } catch {
    return null;
  }
}

export function GET(): Response {
  const body: VersionResponse = {
    sha: CURRENT_SHA,
    shaShort: CURRENT_SHA_SHORT,
    buildTime: BUILD_TIME,
    rollbackSha: readRollbackSha(),
    dbHealthy: probeDb(),
  };
  return Response.json(body, {
    headers: {
      // Aggressively disable caching — every request must hit the live DB probe
      // so it doubles as the post-restart health check in Phase 9 (EXEC-04 / ROLL-04).
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
