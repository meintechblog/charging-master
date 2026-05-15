// src/app/api/admin/update-state/quarantine/route.ts
//
// DELETE /api/admin/update-state/quarantine — clears the on-disk quarantine
// directory recorded at state.lastQuarantine.path and patches state.json to
// set `lastQuarantine = null`. Backs the "Alle löschen" button on the new
// /settings/update-state admin page (shipped in Plan 13-04).
//
// Host guard: isAllowedBrowserHost (LAN browser allowlist — charging-master.local
// IS allowed). This is the BROWSER-FACING variant; do NOT confuse with the
// stricter localhost-only guard at /api/internal/prepare-for-shutdown.
// See RESEARCH.md Pitfall 12 + PATTERNS.md §5 Idiom B for the distinction.
//
// Side effects: filesystem rm-rf of state.lastQuarantine.path + state.json
// patch { lastQuarantine: null }. No DB write — single-purpose per
// CONTEXT.md §Design Decision 6 (PIPE-04 owns the update_runs audit row).
//
// Idempotent for the no-quarantine case: returns 200 with removedPath:null
// when state.lastQuarantine is already null/undefined.

import { rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAllowedBrowserHost } from '@/lib/host-guard';
import { UpdateStateStore } from '@/modules/self-update/update-state-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const;

// Defense-in-depth: every quarantine dir written by the bash updater lives
// directly under <cwd>/.update-state/quarantine-<stamp>. We refuse to rm any
// path outside that prefix even if state.json points elsewhere — a corrupted
// or malicious state.lastQuarantine.path must NEVER turn this endpoint into
// an arbitrary rm-rf primitive.
const QUARANTINE_PATH_PREFIX = resolve(process.cwd(), '.update-state') + '/quarantine-';

export async function DELETE(request: Request): Promise<Response> {
  if (!isAllowedBrowserHost(request)) {
    return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_CACHE_HEADERS });
  }

  const store = new UpdateStateStore();
  let state;
  try {
    state = store.read();
  } catch (err) {
    return Response.json(
      { error: 'state_read_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }

  const quarantine = state.lastQuarantine;
  if (quarantine === undefined || quarantine === null) {
    return Response.json(
      { ok: true, removedPath: null, removedFileCount: null },
      { status: 200, headers: NO_CACHE_HEADERS },
    );
  }

  const target = quarantine.path;

  if (!target.startsWith(QUARANTINE_PATH_PREFIX)) {
    console.warn(
      `[DELETE /api/admin/update-state/quarantine] refusing rm: path "${target}" not under ${QUARANTINE_PATH_PREFIX}`,
    );
    return Response.json(
      { error: 'path_not_in_state_dir', message: target },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }

  // Best-effort file count BEFORE rm. Informational only — readdir failure
  // (e.g. operator hand-removed the dir) does NOT block the rm.
  let removedFileCount: number | null = null;
  try {
    const entries = await readdir(target, { recursive: true, withFileTypes: true });
    removedFileCount = entries.filter((e) => e.isFile()).length;
  } catch {
    // ignored — informational metric only
  }

  try {
    await rm(target, { recursive: true, force: true });
  } catch (err) {
    return Response.json(
      { error: 'rm_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }

  try {
    store.write({ lastQuarantine: null });
  } catch (err) {
    // Partial-failure surface: the directory is gone but state.json still
    // claims a quarantine exists. Surface 500 so the UI does NOT show
    // "success" while the underlying invariant is broken.
    return Response.json(
      { error: 'state_write_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }

  return Response.json(
    { ok: true, removedPath: target, removedFileCount },
    { status: 200, headers: NO_CACHE_HEADERS },
  );
}
