import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../events/event-bus';

// Mock db client before importing the module under test
vi.mock('@/db/client', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        run: vi.fn(),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          run: vi.fn(),
        })),
      })),
    })),
  },
}));

// Mock schema
vi.mock('@/db/schema', () => ({
  plugs: { id: 'id' },
  powerReadings: {},
}));

// Mock drizzle-orm eq
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

import { HttpPollingService } from './http-polling-service';

// Helpers ---------------------------------------------------------------

function mockOk(data: unknown) {
  return { ok: true, json: async () => data };
}

/**
 * Queue ONE complete poll cycle's responses: Shelly.GetDeviceInfo first
 * (returns matching id), then Switch.GetStatus with the supplied data.
 * Use when a test only needs the first poll's data.
 */
function queueFirstPoll(mockFetch: ReturnType<typeof vi.fn>, switchData: unknown, plugId = 'plug-1') {
  const baseId = plugId.includes(':') ? plugId.split(':')[0] : plugId;
  mockFetch.mockResolvedValueOnce(mockOk({ id: baseId }));
  mockFetch.mockResolvedValueOnce(mockOk(switchData));
}

/**
 * Sticky fetch implementation that auto-resolves GetDeviceInfo with a matching
 * id (so the new id-validation always passes), and Switch.GetStatus with the
 * supplied default data. Use for tests that don't care about specific Switch
 * payloads and want continuous successful polling.
 */
function stickyOkImpl(mockFetch: ReturnType<typeof vi.fn>, defaultSwitch: object = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('Shelly.GetDeviceInfo')) {
      const ipMatch = url.match(/^http:\/\/([\d.]+)\//);
      const ip = ipMatch?.[1] ?? '';
      // Match by IP: tests below register plug-a@.10, plug-b@.11, etc.
      const idByIp: Record<string, string> = {
        '192.168.3.167': 'plug-1',
        '192.168.3.168': 'plug-2',
        '192.168.1.10': 'plug-a',
        '192.168.1.11': 'plug-b',
        '192.168.1.12': 'plug-c',
      };
      return mockOk({ id: idByIp[ip] ?? 'plug-1' });
    }
    return mockOk({
      apower: 0,
      voltage: 230,
      current: 0,
      output: false,
      aenergy: { total: 0 },
      ...defaultSwitch,
    });
  });
}

// -----------------------------------------------------------------------

describe('HttpPollingService', () => {
  let eventBus: EventBus;
  let service: HttpPollingService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    service = new HttpPollingService(eventBus);

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    service.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Test 1: startPolling() calls fetch with correct Switch URL', async () => {
    queueFirstPoll(mockFetch, { apower: 10, voltage: 230, current: 0.04, output: true, aenergy: { total: 50 } });

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.3.167/rpc/Switch.GetStatus?id=0',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('Test 2: Successful poll emits PowerReading via eventBus', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emitPowerReading');

    queueFirstPoll(mockFetch, { apower: 42, voltage: 231, current: 0.18, output: true, aenergy: { total: 123.4 } });

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        plugId: 'plug-1',
        apower: 42,
        voltage: 231,
        current: 0.18,
        output: true,
        totalEnergy: 123.4,
        timestamp: expect.any(Number),
      })
    );
  });

  it('Test 3: Failed poll (network) emits PlugOnline(false)', async () => {
    const onlineSpy = vi.spyOn(eventBus, 'emitPlugOnline');

    // First fetch (GetDeviceInfo) rejects → markOffline before Switch.GetStatus.
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(onlineSpy).toHaveBeenCalledWith('plug-1', false);
  });

  it('Test 4: stopPolling(plugId) clears the interval for that plug', async () => {
    stickyOkImpl(mockFetch);

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isPolling('plug-1')).toBe(true);

    service.stopPolling('plug-1');
    expect(service.isPolling('plug-1')).toBe(false);

    const callCount = mockFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockFetch.mock.calls.length).toBe(callCount);
  });

  it('Test 5: stopAll() clears all active polling intervals', async () => {
    stickyOkImpl(mockFetch);

    service.startPolling('plug-1', '192.168.3.167');
    service.startPolling('plug-2', '192.168.3.168');
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isPolling('plug-1')).toBe(true);
    expect(service.isPolling('plug-2')).toBe(true);

    service.stopAll();

    expect(service.isPolling('plug-1')).toBe(false);
    expect(service.isPolling('plug-2')).toBe(false);
  });

  it('Test 6: startPolling() with custom intervalMs respects that interval', async () => {
    stickyOkImpl(mockFetch);

    service.startPolling('plug-1', '192.168.3.167', 5000);
    await vi.advanceTimersByTimeAsync(0);

    const countAfterInitial = mockFetch.mock.calls.length; // 2 (id check + Switch)

    await vi.advanceTimersByTimeAsync(4999);
    expect(mockFetch.mock.calls.length).toBe(countAfterInitial);

    // 5000ms total → second poll fires. id-check is within 60s window, skipped.
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch.mock.calls.length).toBe(countAfterInitial + 1);
  });

  it('Test 7: persistIfDue writes at ACTIVE_INTERVAL > 5W, IDLE_INTERVAL <= 5W', async () => {
    const { db } = await import('@/db/client');
    const insertSpy = vi.mocked(db.insert);

    // First poll: device-info + Switch (active power)
    queueFirstPoll(mockFetch, { apower: 42, voltage: 230, current: 0.18, output: true, aenergy: { total: 10 } });

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    const firstInsertCount = insertSpy.mock.calls.length;
    expect(firstInsertCount).toBeGreaterThan(0);

    // 500ms — should NOT persist (< 1000ms ACTIVE_INTERVAL). id-check skipped.
    mockFetch.mockResolvedValueOnce(mockOk({ apower: 42, voltage: 230, current: 0.18, output: true, aenergy: { total: 10 } }));
    await vi.advanceTimersByTimeAsync(500);

    // 1000ms — should persist
    mockFetch.mockResolvedValueOnce(mockOk({ apower: 42, voltage: 230, current: 0.18, output: true, aenergy: { total: 10 } }));
    await vi.advanceTimersByTimeAsync(500);

    const afterActiveCount = insertSpy.mock.calls.length;
    expect(afterActiveCount).toBeGreaterThan(firstInsertCount);

    // Idle interval: 30s should NOT persist for power <= 5W
    insertSpy.mockClear();
    mockFetch.mockResolvedValueOnce(mockOk({ apower: 2, voltage: 230, current: 0.01, output: true, aenergy: { total: 10 } }));
    await vi.advanceTimersByTimeAsync(1000);
    const idleFirstCount = insertSpy.mock.calls.length;

    mockFetch.mockResolvedValueOnce(mockOk({ apower: 2, voltage: 230, current: 0.01, output: true, aenergy: { total: 10 } }));
    await vi.advanceTimersByTimeAsync(30000);
    expect(insertSpy.mock.calls.length).toBe(idleFirstCount);
  });

  it('startPolling() guards against double-polling same plugId', async () => {
    stickyOkImpl(mockFetch);

    service.startPolling('plug-1', '192.168.3.167');
    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isPolling('plug-1')).toBe(true);
  });
});

describe('HttpPollingService device-id validation', () => {
  let eventBus: EventBus;
  let service: HttpPollingService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    service = new HttpPollingService(eventBus);

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    service.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('id mismatch on first poll → marks offline, suppresses Switch fetch, no PowerReading', async () => {
    const onlineSpy = vi.spyOn(eventBus, 'emitPlugOnline');
    const readingSpy = vi.spyOn(eventBus, 'emitPowerReading');

    // The squatter at this IP reports a different device id.
    mockFetch.mockResolvedValueOnce(mockOk({ id: 'shellypstripg4-58e6c53f7f78' }));

    service.startPolling('shellyplugsg3-d0cf13dbdfd8', '192.168.3.148');
    await vi.advanceTimersByTimeAsync(0);

    expect(onlineSpy).toHaveBeenCalledWith('shellyplugsg3-d0cf13dbdfd8', false);
    expect(readingSpy).not.toHaveBeenCalled();
    // Only the GetDeviceInfo call was made; Switch.GetStatus must be suppressed.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.3.148/rpc/Shelly.GetDeviceInfo',
      expect.any(Object)
    );
  });

  it('id check is skipped within 60s window after a successful match', async () => {
    queueFirstPoll(mockFetch, { apower: 1, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }, 'plug-1');
    // Subsequent polls only return Switch data (no id check should fire)
    mockFetch.mockResolvedValueOnce(mockOk({ apower: 1, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }));
    mockFetch.mockResolvedValueOnce(mockOk({ apower: 1, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }));

    service.startPolling('plug-1', '192.168.3.167', 5000);
    await vi.advanceTimersByTimeAsync(0);
    // 1st poll: 2 calls (id + switch)
    expect(mockFetch.mock.calls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(5000);
    // 2nd poll: 1 call (switch only — id check still within 60s)
    expect(mockFetch.mock.calls.length).toBe(3);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockFetch.mock.calls.length).toBe(4);

    // No GetDeviceInfo calls in the recent activity
    const recentInfoCalls = mockFetch.mock.calls.slice(1).filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('Shelly.GetDeviceInfo')
    );
    expect(recentInfoCalls.length).toBe(0);
  });

  it('id check re-triggers after 60s', async () => {
    queueFirstPoll(mockFetch, { apower: 0, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }, 'plug-1');

    // Set up a sticky mock for everything past the first poll. id-check returns
    // matching id on every call so the service stays online.
    let callIdx = 0;
    mockFetch.mockImplementation(async (url: string) => {
      callIdx++;
      if (typeof url === 'string' && url.includes('Shelly.GetDeviceInfo')) {
        return mockOk({ id: 'plug-1' });
      }
      return mockOk({ apower: 0, voltage: 230, current: 0, output: false, aenergy: { total: 0 } });
    });

    service.startPolling('plug-1', '192.168.3.167', 5000);
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = mockFetch.mock.calls.length; // 2

    // Run 11 polls × 5s = 55s — still inside the 60s window
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const after55s = mockFetch.mock.calls.length;
    const infoCallsBefore60s = mockFetch.mock.calls
      .slice(afterFirst)
      .filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('Shelly.GetDeviceInfo'))
      .length;
    expect(infoCallsBefore60s).toBe(0);

    // One more tick — total 60s now → next id check should fire on the poll
    await vi.advanceTimersByTimeAsync(5000);
    const after60s = mockFetch.mock.calls.length;
    const infoCallsAfter60s = mockFetch.mock.calls
      .slice(afterFirst)
      .filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('Shelly.GetDeviceInfo'))
      .length;
    expect(infoCallsAfter60s).toBe(1);
    expect(after60s).toBeGreaterThan(after55s);
  });

  it('multi-channel plug id (<base>:1) compares against the base id only', async () => {
    const onlineSpy = vi.spyOn(eventBus, 'emitPlugOnline');

    // Device reports the base id; our plug row is the channel-1 entry.
    queueFirstPoll(
      mockFetch,
      { apower: 17, voltage: 230, current: 0.07, output: true, aenergy: { total: 5 } },
      'shellypstripg4-58e6c53f7f78:1'
    );

    service.startPolling('shellypstripg4-58e6c53f7f78:1', '192.168.3.148', 5000, 1);
    await vi.advanceTimersByTimeAsync(0);

    // No offline emission — id matched after stripping the :1 suffix.
    expect(onlineSpy).not.toHaveBeenCalledWith('shellypstripg4-58e6c53f7f78:1', false);
    // Switch was called against channel 1.
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.3.148/rpc/Switch.GetStatus?id=1',
      expect.any(Object)
    );
  });

  it('id check failure (GetDeviceInfo unreachable) marks offline, retries on next poll', async () => {
    const onlineSpy = vi.spyOn(eventBus, 'emitPlugOnline');

    // First poll: GetDeviceInfo throws → markOffline, no Switch call
    mockFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    // Second poll: id check retries (previous failed, ignore 60s window).
    // Match this time; Switch.GetStatus then succeeds.
    mockFetch.mockResolvedValueOnce(mockOk({ id: 'plug-1' }));
    mockFetch.mockResolvedValueOnce(
      mockOk({ apower: 0, voltage: 230, current: 0, output: false, aenergy: { total: 0 } })
    );

    service.startPolling('plug-1', '192.168.3.167', 5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(onlineSpy).toHaveBeenCalledWith('plug-1', false);
    const firstCalls = mockFetch.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5000);
    // Two more calls expected: device-info (retry because last check failed) +
    // Switch.GetStatus (since id now matches).
    expect(mockFetch.mock.calls.length).toBe(firstCalls + 2);
  });
});

describe('HttpPollingService.stopPolling overloads (Phase 9 drain)', () => {
  let eventBus: EventBus;
  let service: HttpPollingService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    service = new HttpPollingService(eventBus);

    mockFetch = vi.fn();
    stickyOkImpl(mockFetch);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    service.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('single-plug overload stops only the named plug', async () => {
    service.startPolling('plug-a', '192.168.1.10', 10_000);
    service.startPolling('plug-b', '192.168.1.11', 10_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isPolling('plug-a')).toBe(true);
    expect(service.isPolling('plug-b')).toBe(true);

    service.stopPolling('plug-a');

    expect(service.isPolling('plug-a')).toBe(false);
    expect(service.isPolling('plug-b')).toBe(true);
  });

  it('no-arg overload stops every poller and returns the prior count', async () => {
    service.startPolling('plug-a', '192.168.1.10', 10_000);
    service.startPolling('plug-b', '192.168.1.11', 10_000);
    service.startPolling('plug-c', '192.168.1.12', 10_000);
    await vi.advanceTimersByTimeAsync(0);

    const drainPromise = service.stopPolling();
    await vi.advanceTimersByTimeAsync(100);
    const stopped = await drainPromise;

    expect(stopped).toBe(3);
    expect(service.isPolling('plug-a')).toBe(false);
    expect(service.isPolling('plug-b')).toBe(false);
    expect(service.isPolling('plug-c')).toBe(false);
  });

  it('no-arg overload returns 0 when called on an idle service', async () => {
    const drainPromise = service.stopPolling();
    await vi.advanceTimersByTimeAsync(100);
    const stopped = await drainPromise;
    expect(stopped).toBe(0);
  });

  it('no-arg overload returns 0 on second call (idempotent)', async () => {
    service.startPolling('plug-a', '192.168.1.10', 10_000);
    await vi.advanceTimersByTimeAsync(0);

    const firstPromise = service.stopPolling();
    await vi.advanceTimersByTimeAsync(100);
    const first = await firstPromise;

    const secondPromise = service.stopPolling();
    await vi.advanceTimersByTimeAsync(100);
    const second = await secondPromise;

    expect(first).toBe(1);
    expect(second).toBe(0);
  });
});
