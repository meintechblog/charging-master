import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { switchRelayOnHttp, switchRelayOffHttp } from './relay-http';

describe('relay-http', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Test 1: switchRelayOnHttp calls fetch with correct URL and returns true on 200', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await switchRelayOnHttp('192.168.3.167');

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.3.167/rpc/Switch.Set?id=0&on=true',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('Test 2: switchRelayOffHttp calls fetch with correct URL and returns true on 200', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await switchRelayOffHttp('192.168.3.167');

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.3.167/rpc/Switch.Set?id=0&on=false',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('Test 3: switchRelayOnHttp returns false when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('device unreachable'));

    const result = await switchRelayOnHttp('192.168.3.167');

    expect(result).toBe(false);
  });

  it('Test 4: switchRelayOffHttp returns false when fetch returns non-200', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await switchRelayOffHttp('192.168.3.167');

    expect(result).toBe(false);
  });

  it('Test 5: Both functions use AbortSignal.timeout(3000)', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await switchRelayOnHttp('192.168.3.167');
    await switchRelayOffHttp('192.168.3.167');

    for (const call of mockFetch.mock.calls) {
      const options = call[1] as { signal: AbortSignal };
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
