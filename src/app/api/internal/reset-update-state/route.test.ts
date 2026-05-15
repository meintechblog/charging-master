/**
 * POST /api/internal/reset-update-state — unit tests.
 *
 * Covers:
 *   - 200 + state patch + audit row insert on localhost (3 cases).
 *   - 403 on non-localhost hosts (LAN hostname, random hostname, missing Host).
 *   - 200 on IPv6 bracketed loopback ([::1]:80).
 *   - Audit insert failure is non-fatal (state reset still 200).
 *   - state.read() failure → 500 state_read_failed (no write, no audit).
 *   - state.write() failure → 500 state_write_failed (no audit).
 *
 * Pattern mirrors src/app/api/charging/sessions/[id]/route.test.ts —
 * vi.mock the db client + module-level dependencies BEFORE importing the
 * route handler so the route imports the mocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdateState } from '@/modules/self-update/types';

// --- Mocks (must be hoisted via vi.hoisted so the factories can reference these) ---

const mocks = vi.hoisted(() => {
  const insertRun = vi.fn();
  // Explicit (..._args: unknown[]) signatures so vitest's mock.calls is
  // typed as `unknown[][]` (not `[][]`) and we can read calls[0][0] under
  // strict mode without TS2493.
  const insertValues = vi.fn((..._args: unknown[]) => ({ run: insertRun }));
  const insertFn = vi.fn((..._args: unknown[]) => ({ values: insertValues }));
  const readFn = vi.fn<(...args: unknown[]) => unknown>();
  const writeFn = vi.fn<(...args: unknown[]) => unknown>();
  return { insertRun, insertValues, insertFn, readFn, writeFn };
});

vi.mock('@/db/client', () => ({ db: { insert: mocks.insertFn } }));

vi.mock('@/db/schema', () => ({ updateRuns: 'updateRuns' }));

// update-state-store.ts imports @/lib/version at module top-level.
vi.mock('@/lib/version', () => ({
  CURRENT_SHA: 'abc1234567890abc1234567890abc1234567890a',
  CURRENT_SHA_SHORT: 'abc1234',
  BUILD_TIME: '2026-05-15T03:17:41.230Z',
}));

vi.mock('@/modules/self-update/update-state-store', () => ({
  UpdateStateStore: class {
    read = mocks.readFn;
    write = mocks.writeFn;
  },
}));

const { insertRun, insertValues, insertFn, readFn, writeFn } = mocks;

// Import AFTER mocks are in place.
import { POST } from './route';

// --- Helpers ---

const SEEDED_SHA = 'abc1234567890abc1234567890abc1234567890a';

function defaultUpdateState(): UpdateState {
  return {
    currentSha: SEEDED_SHA,
    rollbackSha: 'rollback123456789012345678901234567890ab',
    lastCheckAt: 1700000000000,
    lastCheckEtag: 'W/"some-etag"',
    lastCheckResult: { status: 'unchanged' },
    updateStatus: 'installing',
    rollbackHappened: false,
    rollbackReason: null,
    targetSha: 'def5678901234567890123456789012345678901',
    updateStartedAt: 1700000001000,
    rollbackStage: null,
    lastQuarantine: {
      timestamp: 1700000000500,
      fileCount: 2,
      path: '/opt/charging-master/.update-state/quarantine-20260515-221500',
    },
  };
}

function buildRequest(host: string | null): Request {
  const headers: Record<string, string> = {};
  if (host !== null) headers.host = host;
  return new Request('http://localhost/api/internal/reset-update-state', {
    method: 'POST',
    headers,
  });
}

// --- Tests ---

describe('POST /api/internal/reset-update-state', () => {
  beforeEach(() => {
    insertFn.mockClear();
    insertValues.mockClear();
    insertRun.mockClear();
    insertRun.mockReset();
    insertRun.mockReturnValue(undefined);
    readFn.mockReset();
    writeFn.mockReset();
    readFn.mockReturnValue(defaultUpdateState());
    writeFn.mockImplementation(() => defaultUpdateState());
  });

  it('returns 200 { ok: true } for a localhost POST', async () => {
    const res = await POST(buildRequest('localhost'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'no-store, no-cache, must-revalidate',
    );
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it('patches state.json with only the three in-flight fields', async () => {
    await POST(buildRequest('127.0.0.1'));

    expect(writeFn).toHaveBeenCalledTimes(1);
    const patch = writeFn.mock.calls[0]![0];
    expect(patch).toEqual({
      updateStatus: 'idle',
      targetSha: null,
      updateStartedAt: null,
    });
    // Hard guarantee: lastQuarantine etc. are NEVER in the patch.
    // UpdateStateStore.write spread-merges everything else.
    expect(Object.keys(patch as object).sort()).toEqual([
      'targetSha',
      'updateStartedAt',
      'updateStatus',
    ]);
  });

  it('inserts an update_runs audit row with status=recovery_reset', async () => {
    await POST(buildRequest('localhost'));

    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(insertFn).toHaveBeenCalledWith('updateRuns');
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertRun).toHaveBeenCalledTimes(1);

    const row = insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.status).toBe('recovery_reset');
    expect(row.fromSha).toBe(SEEDED_SHA);
    expect(row.toSha).toBeNull();
    expect(row.stage).toBe('recovery');
    expect(row.errorMessage).toBe(
      'manual recovery via /api/internal/reset-update-state',
    );
    expect(row.rollbackStage).toBeNull();
    expect(row.startAt).toBeInstanceOf(Date);
    expect(row.endAt).toBeInstanceOf(Date);
  });

  it('rejects Host: charging-master.local with 403 (narrower than browser host-guard)', async () => {
    const res = await POST(buildRequest('charging-master.local'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'forbidden' });
    expect(writeFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('rejects a random LAN hostname with 403', async () => {
    const res = await POST(buildRequest('evil.example.com'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'forbidden' });
    expect(writeFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('rejects a request with no Host header with 403', async () => {
    // Fetch sometimes refuses to construct a Request with empty headers.
    // The isLocalhostHost guard treats empty-string raw as "fails Set lookup"
    // → 403. Verify whichever path the Request impl takes still yields 403.
    const res = await POST(buildRequest(''));
    expect(res.status).toBe(403);
    expect(writeFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('accepts the IPv6 bracketed loopback Host [::1]:80', async () => {
    const res = await POST(buildRequest('[::1]:80'));
    expect(res.status).toBe(200);
    expect(writeFn).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when the audit-row insert throws', async () => {
    insertRun.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await POST(buildRequest('localhost'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
    // State write still happened — load-bearing part is intact.
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('returns 500 state_read_failed when store.read throws', async () => {
    readFn.mockImplementation(() => {
      throw new Error('state.json corrupt');
    });

    const res = await POST(buildRequest('localhost'));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('state_read_failed');
    expect(body.message).toBe('state.json corrupt');
    expect(writeFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('returns 500 state_write_failed when store.write throws', async () => {
    writeFn.mockImplementation(() => {
      throw new Error('readonly filesystem');
    });

    const res = await POST(buildRequest('localhost'));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('state_write_failed');
    expect(body.message).toBe('readonly filesystem');
    expect(insertFn).not.toHaveBeenCalled();
  });
});
