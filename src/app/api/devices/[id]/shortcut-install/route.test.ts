/**
 * GET /api/devices/[id]/shortcut-install — wire-contract tests.
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

const iOSUserAgent =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const desktopUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function makeReq(ua: string | null): Request {
  const headers = new Headers();
  if (ua) headers.set('user-agent', ua);
  return new Request('http://charging-master.local/api/devices/plug-x/shortcut-install', {
    method: 'GET',
    headers,
  });
}

const ctx = { params: Promise.resolve({ id: 'plug-x' }) };

describe('GET /api/devices/[id]/shortcut-install', () => {
  it('redirects iOS UA to shortcuts:// import URL', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    const res = await GET(makeReq(iOSUserAgent), ctx);
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location');
    expect(loc).toMatch(/^shortcuts:\/\/import-shortcut\?url=/);
    expect(loc).toContain(encodeURIComponent('http://charging-master.local/api/devices/plug-x/shortcut.plist'));
    expect(loc).toContain('name=');
    expect(decodeURIComponent(loc!.split('name=')[1])).toBe('Charging-Master SoC Büro');
  });

  it('redirects desktop UA to the .plist file directly', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    const res = await GET(makeReq(desktopUserAgent), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      'http://charging-master.local/api/devices/plug-x/shortcut.plist'
    );
  });

  it('returns 404 when plug is missing', async () => {
    const res = await GET(makeReq(iOSUserAgent), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 403 from non-allowed host', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    const { isAllowedBrowserHost } = await import('@/lib/host-guard');
    (isAllowedBrowserHost as unknown as { mockReturnValueOnce: (v: boolean) => void })
      .mockReturnValueOnce(false);
    const res = await GET(makeReq(iOSUserAgent), ctx);
    expect(res.status).toBe(403);
  });

  it('treats missing UA as non-iOS (downloads file)', async () => {
    fakeState.plugRows.push({ id: 'plug-x', name: 'Büro' });
    const res = await GET(makeReq(null), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')!.endsWith('.plist')).toBe(true);
  });
});
