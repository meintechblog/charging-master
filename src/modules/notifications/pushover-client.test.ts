/**
 * Tests for sendPushover.
 *
 * Phase 11-03 SOCB-05: opt-in monospace field is forwarded only when truthy,
 * so legacy callers (priorities -1, 0, 1 without ASCII bars) send byte-identical
 * request bodies to pre-Phase-11.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPushover } from './pushover-client';

type FetchInit = RequestInit & { body?: string };

function lastFetchCall(): { url: string; init: FetchInit } | null {
  const fetchMock = global.fetch as unknown as { mock: { calls: Array<[string, FetchInit]> } };
  if (!fetchMock.mock?.calls?.length) return null;
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, init };
}

function lastFetchBody(): Record<string, unknown> {
  const call = lastFetchCall();
  if (!call) throw new Error('fetch was not called');
  return JSON.parse(String(call.init.body ?? '{}'));
}

describe('sendPushover — Phase 11-03 monospace forwarding', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('includes monospace: 1 in JSON body when caller passes monospace: 1', async () => {
    const ok = await sendPushover({
      userKey: 'u',
      apiToken: 't',
      title: 'Title',
      message: 'Body with bar',
      priority: 0,
      monospace: 1,
    });
    expect(ok).toBe(true);

    const body = lastFetchBody();
    expect(body).toMatchObject({
      token: 't',
      user: 'u',
      title: 'Title',
      message: 'Body with bar',
      priority: 0,
      monospace: 1,
    });
  });

  it('OMITS monospace key when caller passes no monospace field (legacy callers byte-identical)', async () => {
    await sendPushover({
      userKey: 'u',
      apiToken: 't',
      title: 'Title',
      message: 'Body without bar',
      priority: 0,
    });

    const body = lastFetchBody();
    expect(body).not.toHaveProperty('monospace');
  });

  it('OMITS monospace key when caller passes monospace: 0 (falsy)', async () => {
    await sendPushover({
      userKey: 'u',
      apiToken: 't',
      title: 'Title',
      message: 'Body',
      priority: 0,
      monospace: 0,
    });

    const body = lastFetchBody();
    expect(body).not.toHaveProperty('monospace');
  });

  it('returns false when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ok = await sendPushover({
      userKey: 'u',
      apiToken: 't',
      title: 'Title',
      message: 'Body',
      priority: 0,
    });
    expect(ok).toBe(false);
    consoleErr.mockRestore();
  });

  it('returns false when Pushover returns non-OK (e.g. 429 rate limit)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));

    const ok = await sendPushover({
      userKey: 'u',
      apiToken: 't',
      title: 'Title',
      message: 'Body',
      priority: 0,
    });
    expect(ok).toBe(false);
  });

  it('returns true on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const ok = await sendPushover({
      userKey: 'u',
      apiToken: 't',
      title: 'Title',
      message: 'Body',
      priority: 0,
    });
    expect(ok).toBe(true);
  });

  it('POSTs application/json to api.pushover.net/1/messages.json', async () => {
    await sendPushover({
      userKey: 'u',
      apiToken: 't',
      title: 'Title',
      message: 'Body',
      priority: 0,
      monospace: 1,
    });

    const call = lastFetchCall();
    expect(call?.url).toBe('https://api.pushover.net/1/messages.json');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});
