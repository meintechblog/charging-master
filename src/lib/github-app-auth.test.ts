import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  mintJwt,
  getInstallationToken,
  __clearTokenCacheForTests,
} from './github-app-auth';

// Generate one ephemeral RSA keypair for the entire test suite. We only
// assert JWT *structure*, never verify the signature (that would be
// test-against-impl). The keypair is just so crypto.sign('RSA-SHA256', ...)
// accepts the PEM input.
const { privateKey: PRIVATE_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

describe('mintJwt', () => {
  it('produces a 3-part base64url JWT', () => {
    const jwt = mintJwt('12345', PRIVATE_KEY_PEM);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    // base64url alphabet only — no `+`, `/`, `=`.
    for (const p of parts) {
      expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('header decodes to {alg:RS256, typ:JWT}', () => {
    const jwt = mintJwt('12345', PRIVATE_KEY_PEM);
    const header = JSON.parse(b64urlDecode(jwt.split('.')[0]!));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('payload has iss/iat/exp with exp-iat in [540, 600] and iat back-shifted', () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = mintJwt('98765', PRIVATE_KEY_PEM);
    const after = Math.floor(Date.now() / 1000);
    const payload = JSON.parse(b64urlDecode(jwt.split('.')[1]!));
    expect(payload.iss).toBe('98765');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp - payload.iat).toBeGreaterThanOrEqual(540);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    // iat is back-shifted by 60s (with up-to-1s tolerance for clock-tick).
    expect(payload.iat).toBeLessThanOrEqual(before - 60 + 1);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60 - 1);
    // Sanity: iat must be relative to "now" (not, say, ms instead of seconds).
    expect(payload.iat).toBeLessThanOrEqual(after);
  });

  it('does not call fetch', () => {
    const fetchMock = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      mintJwt('1', PRIVATE_KEY_PEM);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('getInstallationToken', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    __clearTokenCacheForTests();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns {ok:true, token, expiresAt} on 201', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'ghs_abcdef1234567890abcd', expires_at: future }), { status: 201 }),
    ) as unknown as typeof fetch;

    const res = await getInstallationToken({
      appId: '1',
      installationId: 'inst-1',
      privateKey: PRIVATE_KEY_PEM,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.token).toBe('ghs_abcdef1234567890abcd');
      expect(res.expiresAt).toBe(new Date(future).getTime());
    }
  });

  it('maps 401 to github_app_unauthorized', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;
    const res = await getInstallationToken({ appId: '1', installationId: 'inst-1', privateKey: PRIVATE_KEY_PEM });
    expect(res).toEqual({ ok: false, error: 'github_app_unauthorized' });
  });

  it('maps 404 to installation_not_found', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 })) as unknown as typeof fetch;
    const res = await getInstallationToken({ appId: '1', installationId: 'inst-x', privateKey: PRIVATE_KEY_PEM });
    expect(res).toEqual({ ok: false, error: 'installation_not_found' });
  });

  it('maps 403 with rate-limit header to github_rate_limited', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', { status: 403, headers: { 'x-ratelimit-reset': '1234567890' } }),
    ) as unknown as typeof fetch;
    const res = await getInstallationToken({ appId: '1', installationId: 'inst-1', privateKey: PRIVATE_KEY_PEM });
    expect(res).toEqual({ ok: false, error: 'github_rate_limited' });
  });

  it('maps malformed response to token_response_shape_unexpected', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 201 }),
    ) as unknown as typeof fetch;
    const res = await getInstallationToken({ appId: '1', installationId: 'inst-1', privateKey: PRIVATE_KEY_PEM });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^token_response_shape_unexpected/);
  });

  it('caches the token: second call within TTL does not hit fetch again', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'ghs_abcdef1234567890abcd', expires_at: future }), { status: 201 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const a = await getInstallationToken({ appId: '1', installationId: 'inst-cache', privateKey: PRIVATE_KEY_PEM });
    const b = await getInstallationToken({ appId: '1', installationId: 'inst-cache', privateKey: PRIVATE_KEY_PEM });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the token 5min before expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    // First response: token expires in 10 minutes.
    const exp1 = new Date('2026-01-01T00:10:00Z').toISOString();
    const exp2 = new Date('2026-01-01T01:10:00Z').toISOString();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'ghs_first0000000000000000', expires_at: exp1 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'ghs_second000000000000000', expires_at: exp2 }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await getInstallationToken({ appId: '1', installationId: 'inst-refresh', privateKey: PRIVATE_KEY_PEM });
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance to T-4:59 (still within refresh buffer of 5min)
    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    const second = await getInstallationToken({ appId: '1', installationId: 'inst-refresh', privateKey: PRIVATE_KEY_PEM });
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (second.ok) expect(second.token).toBe('ghs_second000000000000000');
  });

  it('loads private key from file path when GITHUB_APP_PRIVATE_KEY is unset', async () => {
    const spy = vi.spyOn(fs, 'readFileSync').mockReturnValue(PRIVATE_KEY_PEM);
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'ghs_filepath0000000000000', expires_at: future }), { status: 201 }),
    ) as unknown as typeof fetch;

    const res = await getInstallationToken({
      appId: '1',
      installationId: 'inst-pathload',
      privateKeyPath: '/etc/charging-master/github-app.pem',
    });

    expect(spy).toHaveBeenCalledWith('/etc/charging-master/github-app.pem', 'utf8');
    expect(res.ok).toBe(true);
    spy.mockRestore();
  });

  it('returns github_app_private_key_missing if neither source is provided', async () => {
    const res = await getInstallationToken({ appId: '1', installationId: 'inst-no-key' });
    expect(res).toEqual({ ok: false, error: 'github_app_private_key_missing' });
  });

  it('returns github_app_token_exchange_timed_out on AbortError', async () => {
    // Simulate the SUT's AbortController firing: when fetch is called we
    // immediately throw an AbortError (the production code catches this via
    // its `err.name === 'AbortError'` branch).
    global.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const res = await getInstallationToken({ appId: '1', installationId: 'inst-timeout', privateKey: PRIVATE_KEY_PEM });
    expect(res).toEqual({ ok: false, error: 'github_app_token_exchange_timed_out' });
  });
});
