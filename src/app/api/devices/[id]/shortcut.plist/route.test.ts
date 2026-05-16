/**
 * GET /api/devices/[id]/shortcut.plist — wire-contract tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeRow {
  [k: string]: unknown;
}

const fakeState = {
  plugRows: [] as FakeRow[],
};

function reset() {
  fakeState.plugRows = [];
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((pred: { col: unknown; val: unknown }) => ({
          get: vi.fn(() => fakeState.plugRows.find((r) => r.id === pred.val)),
        })),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({ plugs: 'plugs' }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((col, val) => ({ col, val })) }));
vi.mock('@/lib/host-guard', () => ({
  isAllowedBrowserHost: vi.fn(() => true),
}));

beforeEach(() => {
  reset();
});

import { GET } from './route';

function makeReq(url = 'http://charging-master.local/api/devices/plug-x/shortcut.plist'): Request {
  return new Request(url, { method: 'GET' });
}

const ctx = { params: Promise.resolve({ id: 'plug-x' }) };

describe('GET /api/devices/[id]/shortcut.plist', () => {
  it('returns 200 with valid plist body and shortcut MIME', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-apple-shortcut');
    const cd = res.headers.get('Content-Disposition');
    expect(cd).toMatch(/attachment; filename="Charging-Master-SoC-.*\.shortcut"/);
    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('is.workflow.actions.downloadurl');
    expect(body).toContain('http://charging-master.local/api/devices/plug-x/report-soc');
  });

  it('uses the Host header (not request.url) so reverse-proxy localhost leaks do not poison the URL', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    // Simulate a browser hitting via IP. The Host header is what we use.
    const req = new Request('http://localhost:3000/api/devices/plug-x/shortcut.plist', {
      method: 'GET',
      headers: { host: '192.168.3.185' },
    });
    const res = await GET(req, ctx);
    const body = await res.text();
    expect(body).toContain('http://192.168.3.185/api/devices/plug-x/report-soc');
  });

  it('returns 404 when plug is missing', async () => {
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('plug_not_found');
  });

  it('returns 403 from non-allowed host', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    const { isAllowedBrowserHost } = await import('@/lib/host-guard');
    (isAllowedBrowserHost as unknown as { mockReturnValueOnce: (v: boolean) => void })
      .mockReturnValueOnce(false);
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBe(403);
  });

  it('sets Cache-Control: no-store', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    const res = await GET(makeReq(), ctx);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
