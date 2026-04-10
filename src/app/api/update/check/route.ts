// src/app/api/update/check/route.ts
// Manual trigger for an immediate GitHub check. 5-min server-side cooldown.
// Uses the global UpdateChecker singleton (set in server.ts main()).

import { UpdateStateStore } from '@/modules/self-update/update-state-store';
import type { UpdateChecker } from '@/modules/self-update/update-checker';
import type { LastCheckResult } from '@/modules/self-update/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type OkResponse = { result: LastCheckResult };
type CooldownResponse = { status: 'cooldown'; retryAfterSeconds: number };

function getChecker(): UpdateChecker | null {
  // server.ts main() assigns this after booting the singleton. If the route
  // is somehow hit before boot completes (shouldn't happen — Next.js only
  // accepts requests after server.listen), we degrade gracefully to 503.
  return (globalThis as typeof globalThis & { __updateChecker?: UpdateChecker }).__updateChecker ?? null;
}

export async function GET(): Promise<Response> {
  const store = new UpdateStateStore();
  let state;
  try {
    state = store.read();
  } catch (err) {
    return Response.json(
      { status: 'error', error: `state read failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Cooldown gate — single source of truth is state.lastCheckAt written by
  // UpdateChecker.check() on every outcome (ok, unchanged, rate_limited, error).
  // Use Date.now() explicitly (no client-supplied timestamp, no Date object
  // pass-through) to eliminate P17 clock-skew concerns.
  const now = Date.now();
  if (state.lastCheckAt !== null) {
    const elapsed = now - state.lastCheckAt;
    if (elapsed < COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      const body: CooldownResponse = { status: 'cooldown', retryAfterSeconds };
      return Response.json(body, {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(retryAfterSeconds),
        },
      });
    }
  }

  const checker = getChecker();
  if (checker === null) {
    return Response.json(
      { status: 'error', error: 'update checker not initialized' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const result = await checker.check({ manual: true });
  const body: OkResponse = { result };
  return Response.json(body, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
