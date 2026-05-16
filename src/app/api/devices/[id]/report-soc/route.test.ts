/**
 * POST /api/devices/[id]/report-soc — integration test.
 *
 * Wire-contract assertions (the override delegation is covered by
 * charge-monitor.test.ts). Covers: 404 plug-not-found, 409 no-active-
 * session, 400 invalid-soc, and the happy 200 path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeRow {
  [k: string]: unknown;
}

const fakeState = {
  chargeSessionRows: [] as FakeRow[],
  plugRows: [] as FakeRow[],
  deviceProfileRows: [] as FakeRow[],
  lastOverride: null as null | { sessionId: number; estimatedSoc: number | undefined },
};

function resetFakeState() {
  fakeState.chargeSessionRows = [];
  fakeState.plugRows = [];
  fakeState.deviceProfileRows = [];
  fakeState.lastOverride = null;
}

function tableToRows(table: unknown): FakeRow[] {
  switch (table) {
    case 'chargeSessions': return fakeState.chargeSessionRows;
    case 'plugs': return fakeState.plugRows;
    case 'deviceProfiles': return fakeState.deviceProfileRows;
    default: return [];
  }
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((pred: { col: unknown; val: unknown }) => ({
          get: vi.fn(() => {
            const rows = tableToRows(table);
            // The route uses `where(eq(chargeSessions.plugId, plugId))` for
            // the active-session query — match by plugId when col mentions
            // plugId, otherwise by id (the plug lookup).
            const colObj = pred.col as { col?: unknown };
            const colKey = String(colObj?.col ?? pred.col);
            if (colKey === 'plugId') {
              const match = rows.find((r) => r.plugId === pred.val);
              if (!match || !projection) return match;
              const result: FakeRow = {};
              for (const key of Object.keys(projection)) result[key] = match[key];
              return result;
            }
            const match = rows.find((r) => r.id === pred.val);
            if (!match || !projection) return match;
            const result: FakeRow = {};
            for (const key of Object.keys(projection)) result[key] = match[key];
            return result;
          }),
          orderBy: vi.fn(() => ({
            all: vi.fn(() => {
              const rows = tableToRows(table);
              const colObj = pred.col as { col?: unknown };
              const colKey = String(colObj?.col ?? pred.col);
              if (colKey === 'plugId') return rows.filter((r) => r.plugId === pred.val);
              return rows;
            }),
          })),
        })),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  chargeSessions: 'chargeSessions',
  plugs: 'plugs',
  deviceProfiles: 'deviceProfiles',
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock('@/lib/host-guard', () => ({
  isAllowedBrowserHost: vi.fn(() => true),
}));

// Stub the global ChargeMonitor used by the route to apply overrides.
beforeEach(() => {
  resetFakeState();
  // The route only ever calls `__chargeMonitor.overrideSession(...)` — we
  // mock just that surface. Cast to `any` to skirt the full ChargeMonitor
  // interface; the route is the contract under test, not the global.
  (globalThis as unknown as { __chargeMonitor?: unknown }).__chargeMonitor = {
    overrideSession: vi.fn((sessionId: number, opts: { estimatedSoc?: number }) => {
      fakeState.lastOverride = { sessionId, estimatedSoc: opts.estimatedSoc };
    }),
  };
});

import { POST } from './route';

function makeReq(body: unknown): Request {
  return new Request('http://charging-master.local/api/devices/plug-x/report-soc', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = { params: Promise.resolve({ id: 'plug-x' }) };

describe('POST /api/devices/[id]/report-soc', () => {
  it('returns 200 + applies override on a happy path', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    fakeState.chargeSessionRows.push({
      id: 42,
      plugId: 'plug-x',
      state: 'charging',
      estimatedSoc: 0,
      profileId: 4,
      startedAt: 1000,
    });
    fakeState.deviceProfileRows.push({ id: 4, name: 'iPad Pro 12.9" (2022, M2)' });

    const res = await POST(makeReq({ soc: 47 }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe(42);
    expect(body.before).toBe(0);
    expect(body.after).toBe(47);
    expect(body.profileName).toBe('iPad Pro 12.9" (2022, M2)');
    expect(fakeState.lastOverride).toEqual({ sessionId: 42, estimatedSoc: 47 });
  });

  it('returns 404 when the plug does not exist', async () => {
    const res = await POST(makeReq({ soc: 50 }), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('plug_not_found');
  });

  it('returns 409 when no active session is running on the plug', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    fakeState.chargeSessionRows.push({
      id: 41,
      plugId: 'plug-x',
      state: 'complete', // terminal — not active
      estimatedSoc: 80,
      startedAt: 900,
    });

    const res = await POST(makeReq({ soc: 50 }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_active_session');
  });

  it('rejects out-of-range and non-integer SoC payloads', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    fakeState.chargeSessionRows.push({
      id: 42, plugId: 'plug-x', state: 'charging', estimatedSoc: 0, startedAt: 0,
    });
    for (const bad of [-1, 101, 50.5, 'forty', null, undefined]) {
      const res = await POST(makeReq({ soc: bad }), ctx);
      expect(res.status).toBe(400);
    }
  });

  it('rejects requests from non-allowed hosts (403)', async () => {
    const { isAllowedBrowserHost } = await import('@/lib/host-guard');
    (isAllowedBrowserHost as unknown as { mockReturnValueOnce: (v: boolean) => void }).mockReturnValueOnce(false);
    const res = await POST(makeReq({ soc: 50 }), ctx);
    expect(res.status).toBe(403);
  });

  it('picks the most-recent active session when multiple sessions exist on the plug', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    fakeState.chargeSessionRows.push(
      { id: 40, plugId: 'plug-x', state: 'complete', startedAt: 100 },
      { id: 41, plugId: 'plug-x', state: 'aborted', startedAt: 200 },
      { id: 42, plugId: 'plug-x', state: 'charging', startedAt: 300, estimatedSoc: 10, profileId: 4 },
    );
    fakeState.deviceProfileRows.push({ id: 4, name: 'iPad' });

    const res = await POST(makeReq({ soc: 55 }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(42);
  });
});
